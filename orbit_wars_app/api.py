"""FastAPI route handlers."""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import tarfile
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .discovery import scan_zoo
from . import kaggle_auth
from . import kaggle_scraper
from . import kaggle_submissions
from .kaggle_auth import KaggleAuthError
from .kaggle_submissions import KaggleCliError
from .schemas import AgentInfo, AgentLogsResponse, KaggleSubmission, Rating, TournamentConfig
from .match import run_match_with_planets
from .replay_store import save_replay
from .tournament import Tournament
from .trueskill_store import TrueSkillStore


router = APIRouter(prefix="/api")


def _zoo_root() -> Path:
    return Path(os.environ.get("ORBIT_WARS_ZOO_DIR", "agents"))


def _runs_root() -> Path:
    return Path(os.environ.get("ORBIT_WARS_RUNS_DIR", "runs"))


def _safe_subpath(parent: Path, child_name: str) -> Path:
    """Join `parent / child_name` and ensure the result stays inside `parent`.

    Used for path-parameter endpoints where the URL fragment feeds directly
    into a filesystem lookup (e.g. `DELETE /runs/{run_id}` → `runs/<run_id>`).
    Rejects `../` traversal and absolute paths. Raises HTTPException(400)
    on attempted escape.
    """
    joined = parent / child_name
    try:
        joined.resolve().relative_to(parent.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path component")
    return joined


def _replays_root() -> Path:
    """Top-level replays/ dir for non-tournament sources (Kaggle scrapes)."""
    return Path(os.environ.get("ORBIT_WARS_REPLAYS_DIR", "replays"))


@router.get("/agents", response_model=list[AgentInfo])
def list_agents() -> list[AgentInfo]:
    return scan_zoo(_zoo_root())


@router.get("/agents/{agent_id:path}", response_model=AgentInfo)
def get_agent(agent_id: str) -> AgentInfo:
    zoo = scan_zoo(_zoo_root())
    match = next((a for a in zoo if a.id == agent_id), None)
    if match is None:
        raise HTTPException(status_code=404, detail=f"Agent {agent_id!r} not found")
    return match


@router.get("/ratings", response_model=list[Rating])
def get_ratings(format: Literal["2p", "4p"] = "2p") -> list[Rating]:
    store = TrueSkillStore(_runs_root() / "trueskill.json")
    return store.leaderboard(format=format)  # type: ignore[arg-type]


@router.get("/runs")
def list_runs(exclude_quick_match: bool = False) -> list[dict]:
    runs = _runs_root()
    if not runs.is_dir():
        return []
    summaries: list[dict] = []
    for p in sorted(runs.iterdir(), reverse=True):
        if not p.is_dir():
            continue
        if p.name in ("latest",):
            continue
        run_json = p / "run.json"
        if run_json.is_file():
            try:
                data = json.loads(run_json.read_text())
            except json.JSONDecodeError:
                continue
            if exclude_quick_match and data.get("is_quick_match", False):
                continue
            summaries.append(data)
    return summaries


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict:
    run_dir = _runs_root() / run_id
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")
    out: dict = {"id": run_id}
    for fname, key in [
        ("config.json", "config"),
        ("results.json", "results"),
        ("trueskill.json", "trueskill"),
        ("run.json", "run"),
    ]:
        path = run_dir / fname
        if path.is_file():
            out[key] = json.loads(path.read_text())
    return out


@router.get("/runs/{run_id}/progress")
def get_run_progress(run_id: str) -> dict:
    run_json = _runs_root() / run_id / "run.json"
    if not run_json.is_file():
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")
    data = json.loads(run_json.read_text())
    return {
        "status": data.get("status"),
        "matches_done": data.get("matches_done", 0),
        "total_matches": data.get("total_matches", 0),
    }


# ============================================================
# Replays — unified list (local tournament matches + Kaggle scrapes)
# ============================================================

@router.get("/replays")
def list_replays(
    source: Literal["all", "local", "kaggle"] = "all",
) -> list[dict]:
    """List all replays (local tournament matches + Kaggle-scraped episodes).

    Returns list of dicts. Schema differs by source:
      local:   { source, run_id, match_id, agent_ids, winner, turns, duration_s, status }
      kaggle:  { source, submission_id, episode_id, agents, type, endTime }
    """
    result: list[dict] = []

    if source in ("all", "local"):
        runs = _runs_root()
        if runs.is_dir():
            for run_dir in sorted(runs.iterdir(), reverse=True):
                if not run_dir.is_dir() or run_dir.name == "latest":
                    continue
                results_path = run_dir / "results.json"
                if not results_path.is_file():
                    continue
                try:
                    rdata = json.loads(results_path.read_text())
                except json.JSONDecodeError:
                    continue
                replays_dir = run_dir / "replays"
                for m in rdata.get("matches", []):
                    ts = 0.0
                    mid = m.get("match_id")
                    if mid and replays_dir.is_dir():
                        hit = next(iter(replays_dir.glob(f"{mid}-*.json")), None)
                        if hit is not None:
                            ts = hit.stat().st_mtime
                    result.append(
                        {
                            "source": "local",
                            "run_id": run_dir.name,
                            "match_id": mid,
                            "agent_ids": m.get("agent_ids", []),
                            "winner": m.get("winner"),
                            "turns": m.get("turns", 0),
                            "duration_s": m.get("duration_s", 0.0),
                            "status": m.get("status", "ok"),
                            "started_at": rdata.get("started_at"),
                            "ts": ts,
                        }
                    )

    if source in ("all", "kaggle"):
        result.extend(kaggle_scraper.list_local_kaggle_replays(_replays_root()))

    # Newest first by default (mtime of replay file or scrape).
    result.sort(key=lambda r: r.get("ts", 0), reverse=True)
    return result


class ScrapeRequest(BaseModel):
    submission_id: int
    count: int = 10


class ScrapeUrlRequest(BaseModel):
    url: str


# ============================================================
# Playground
# ============================================================

class PlaygroundPlanet(BaseModel):
    x: float
    y: float
    radius: float = 1.5
    ships: int = 10
    production: int = 2
    owner: int = -1  # -1 = neutral, 0 = P1, 1 = P2, 2 = P3, 3 = P4


class PlaygroundRunRequest(BaseModel):
    planets: list[PlaygroundPlanet]
    agent_ids: list[str]
    format: Literal["2p", "4p"] = "2p"
    seed: int = 0


@router.post("/playground/run")
def run_playground(req: PlaygroundRunRequest) -> dict:
    """Run a single match with custom planet configuration and return replay ID."""
    from datetime import datetime, timezone

    num_players = 4 if req.format == "4p" else 2
    if len(req.agent_ids) != num_players:
        raise HTTPException(
            status_code=400,
            detail=f"Format {req.format} requires exactly {num_players} agent_ids, got {len(req.agent_ids)}",
        )
    if len(req.planets) == 0:
        raise HTTPException(status_code=400, detail="At least one planet is required")

    # Validate planet constraints
    seen_ids = set()
    for i, p in enumerate(req.planets):
        pid = i  # We assign IDs 0..N-1 based on order
        seen_ids.add(pid)
        if p.x < 0 or p.x > 100 or p.y < 0 or p.y > 100:
            raise HTTPException(
                status_code=400,
                detail=f"Planet {i}: position ({p.x}, {p.y}) is outside the board (0–100)",
            )
        sun_dist = ((p.x - 50) ** 2 + (p.y - 50) ** 2) ** 0.5
        if sun_dist < 10 + p.radius:
            raise HTTPException(
                status_code=400,
                detail=f"Planet {i}: distance to sun ({sun_dist:.1f}) is less than sun radius + planet radius ({10 + p.radius})",
            )
        if p.owner < -1 or p.owner >= num_players:
            raise HTTPException(
                status_code=400,
                detail=f"Planet {i}: owner must be -1 (neutral) or 0–{num_players - 1}, got {p.owner}",
            )
        if p.ships < 0:
            raise HTTPException(status_code=400, detail=f"Planet {i}: ships must be >= 0")
        if p.production < 0:
            raise HTTPException(status_code=400, detail=f"Planet {i}: production must be >= 0")

    # Check each player has at least one planet
    for pid_idx in range(num_players):
        has_home = any(p.owner == pid_idx for p in req.planets)
        if not has_home:
            raise HTTPException(
                status_code=400,
                detail=f"Player {pid_idx}: at least one planet with owner={pid_idx} is required",
            )

    # Resolve agents
    zoo = scan_zoo(_zoo_root())
    zoo_map = {a.id: a for a in zoo}
    agent_paths: list[Path] = []
    for aid in req.agent_ids:
        info = zoo_map.get(aid)
        if info is None:
            raise HTTPException(status_code=404, detail=f"Agent {aid!r} not found in zoo")
        if info.disabled:
            raise HTTPException(status_code=400, detail=f"Agent {aid!r} is disabled")
        agent_paths.append(_zoo_root().parent / info.path)

    # Build planet arrays: [id, owner, x, y, radius, ships, production]
    planet_arrays = [
        [i, p.owner, p.x, p.y, p.radius, p.ships, p.production]
        for i, p in enumerate(req.planets)
    ]

    # Run match
    outcome = run_match_with_planets(
        agent_ids=req.agent_ids,
        agent_paths=agent_paths,
        planets=planet_arrays,
        seed=req.seed,
    )

    # Save to runs/playground/
    playground_dir = _runs_root() / "playground"
    replays_dir = playground_dir / "replays"
    replays_dir.mkdir(parents=True, exist_ok=True)
    match_counter = len(list(replays_dir.glob("*.json"))) + 1
    rp = save_replay(replays_dir, match_counter, req.agent_ids, outcome.replay)
    replay_rel = str(rp.relative_to(playground_dir))
    match_id = f"{match_counter:03d}"

    # Write minimal run.json and results.json so replay-loading routes work
    now = datetime.now(timezone.utc).isoformat()
    (playground_dir / "run.json").write_text(
        json.dumps(
            {
                "id": "playground",
                "started_at": now,
                "finished_at": now,
                "mode": "fast",
                "format": req.format,
                "status": "completed",
                "total_matches": 1,
                "matches_done": 1,
                "is_quick_match": False,
            },
            indent=2,
        )
    )
    (playground_dir / "results.json").write_text(
        json.dumps(
            {
                "started_at": now,
                "finished_at": now,
                "total_matches": 1,
                "matches": [
                    {
                        "match_id": match_id,
                        "agent_ids": req.agent_ids,
                        "winner": outcome.winner,
                        "scores": outcome.scores,
                        "turns": outcome.turns,
                        "duration_s": outcome.duration_s,
                        "status": outcome.status,
                        "seed": req.seed,
                        "replay_path": replay_rel,
                    }
                ],
                "summary": {"total_matches": 1},
                "status": "completed",
            },
            indent=2,
        )
    )

    return {"run_id": "playground", "match_id": match_id, "status": "completed"}


# ============================================================
# Playground — saved environments
# ============================================================

def _playground_env_dir() -> Path:
    p = _runs_root() / "playground" / "environments"
    p.mkdir(parents=True, exist_ok=True)
    return p


class SaveEnvironmentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    planets: list[PlaygroundPlanet]
    agent_ids: list[str]
    format: Literal["2p", "4p"] = "2p"


@router.post("/playground/environments/save")
def save_environment(req: SaveEnvironmentRequest) -> dict:
    """Save a playground planet configuration under a user-given name."""
    from datetime import datetime, timezone

    safe_name = req.name.strip()
    if not safe_name:
        raise HTTPException(status_code=400, detail="name must not be empty")
    if "/" in safe_name or "\\" in safe_name:
        raise HTTPException(status_code=400, detail="name must not contain path separators")

    env_dir = _playground_env_dir()
    path = env_dir / f"{safe_name}.json"

    payload = {
        "name": safe_name,
        "planets": [p.model_dump() for p in req.planets],
        "agent_ids": req.agent_ids,
        "format": req.format,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, indent=2))
    return {"saved": True, "name": safe_name}


@router.get("/playground/environments")
def list_environments() -> list[dict]:
    """List all saved playground environments."""
    env_dir = _playground_env_dir()
    out: list[dict] = []
    for p in sorted(env_dir.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(p.read_text())
        except json.JSONDecodeError:
            continue
        planets = data.get("planets", [])
        player_count = len(set(p["owner"] for p in planets if p["owner"] >= 0))
        out.append({
            "name": data.get("name", p.stem),
            "created_at": data.get("created_at", ""),
            "planet_count": len(planets),
            "format": data.get("format", "2p"),
            "player_count": player_count,
            "agent_ids": data.get("agent_ids", []),
        })
    return out


@router.get("/playground/environments/{name:path}")
def get_environment(name: str) -> dict:
    """Return the full saved environment config."""
    safe = _safe_subpath(_playground_env_dir(), f"{name}.json")
    if not safe.is_file():
        raise HTTPException(status_code=404, detail=f"Environment {name!r} not found")
    return json.loads(safe.read_text())


@router.delete("/playground/environments/{name:path}")
def delete_environment(name: str) -> dict:
    """Delete a saved environment."""
    safe = _safe_subpath(_playground_env_dir(), f"{name}.json")
    if not safe.is_file():
        raise HTTPException(status_code=404, detail=f"Environment {name!r} not found")
    safe.unlink()
    return {"deleted": True, "name": name}


@router.post("/replays/scrape-url")
def scrape_replay_url(req: ScrapeUrlRequest) -> dict:
    """Parse a Kaggle replay URL and fetch that single episode.

    Accepts:
      - https://www.kaggle.com/competitions/orbit-wars/episodes/70123456
      - https://www.kaggle.com/.../episodes/70123456?submissionId=51799179
      - Bare episode ID as string
    """
    import re

    url = req.url.strip()

    # Bare numeric → treat as episode_id
    if url.isdigit():
        episode_id = int(url)
        submission_id = 0
    else:
        # Accept both Kaggle URL shapes:
        #   /competitions/orbit-wars/episodes/<ep_id>?submissionId=<sub_id>
        #   /competitions/orbit-wars/leaderboard?episodeId=<ep_id>&submissionId=<sub_id>
        m_ep = re.search(r"/episodes/(\d+)", url) or re.search(
            r"[?&]episodeId=(\d+)", url
        )
        if not m_ep:
            raise HTTPException(
                status_code=400,
                detail=(
                    "URL must contain /episodes/<id> or ?episodeId=<id>. "
                    "Examples: an episode page or a leaderboard link."
                ),
            )
        episode_id = int(m_ep.group(1))
        m_sub = re.search(r"[?&]submissionId=(\d+)", url)
        submission_id = int(m_sub.group(1)) if m_sub else 0

    replays_root = _replays_root()
    replays_root.mkdir(parents=True, exist_ok=True)

    try:
        path = kaggle_scraper.scrape_single_episode(
            episode_id=episode_id,
            submission_id=submission_id,
            replays_root=replays_root,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Fetch failed: {e}")

    return {
        "episode_id": episode_id,
        "submission_id": submission_id,
        "path": str(path.relative_to(replays_root.parent)),
    }


# Register upload endpoints with graceful fallback when multipart support
try:
    # Try to import multipart helpers — FastAPI needs python-multipart for UploadFile
    from fastapi import UploadFile, File  # type: ignore

    @router.post("/replays/upload")
    def upload_replay(file: UploadFile = File(...)) -> dict:
        """Upload a Kaggle episode JSON file (multipart/form-data).

        Writes to `replays/kaggle/Uploads/<episode_id>.json` and a `.meta.json`.
        """
        try:
            raw = file.file.read()
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            payload = json.loads(raw)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON file upload")

        episode_id = None
        try:
            if isinstance(payload, dict):
                for k in ("EpisodeId", "episodeId", "episode_id"):
                    if k in payload:
                        episode_id = int(payload[k])
                        break
                if episode_id is None:
                    info = payload.get("info") or {}
                    if isinstance(info, dict):
                        for k in ("EpisodeId", "episodeId", "episode_id"):
                            if k in info:
                                episode_id = int(info[k])
                                break
        except Exception:
            episode_id = None

        if episode_id is None:
            import re

            m = re.search(r"(\d+)", file.filename or "")
            if m:
                episode_id = int(m.group(1))

        if episode_id is None:
            episode_id = uuid.uuid4().hex

        replays_root = _replays_root()
        out_dir = replays_root / "kaggle" / "Uploads"
        out_dir.mkdir(parents=True, exist_ok=True)

        replay_path = out_dir / f"{episode_id}.json"
        meta_path = out_dir / f"{episode_id}.meta.json"

        replay_path.write_text(json.dumps(payload), encoding="utf-8")
        try:
            meta = kaggle_scraper._extract_meta(payload, int(episode_id) if str(episode_id).isdigit() else episode_id)
        except Exception:
            meta = {"episode_id": episode_id}
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

        return {"episode_id": episode_id, "path": str(replay_path.relative_to(replays_root.parent))}

except Exception:
    # multipart support not available — register a stub that points user to JSON upload
    @router.post("/replays/upload")
    def upload_replay_stub() -> dict:
        raise HTTPException(
            status_code=503,
            detail=(
                "File upload support is not available: install python-multipart in the server environment. "
                "As a workaround, POST JSON to /api/replays/upload-json instead."
            ),
        )


@router.post("/replays/upload-json")
def upload_replay_json(payload: dict) -> dict:
    """Upload a Kaggle replay by sending the JSON payload in the request body.

    Body should be the replay JSON (application/json). This avoids multipart
    dependencies and can be used as a quick workaround.
    """
    try:
        payload = dict(payload) if isinstance(payload, dict) else json.loads(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    episode_id = None
    try:
        if isinstance(payload, dict):
            for k in ("EpisodeId", "episodeId", "episode_id"):
                if k in payload:
                    episode_id = int(payload[k])
                    break
            if episode_id is None:
                info = payload.get("info") or {}
                if isinstance(info, dict):
                    for k in ("EpisodeId", "episodeId", "episode_id"):
                        if k in info:
                            episode_id = int(info[k])
                            break
    except Exception:
        episode_id = None

    if episode_id is None:
        episode_id = uuid.uuid4().hex

    replays_root = _replays_root()
    out_dir = replays_root / "kaggle" / "Uploads"
    out_dir.mkdir(parents=True, exist_ok=True)

    replay_path = out_dir / f"{episode_id}.json"
    meta_path = out_dir / f"{episode_id}.meta.json"

    replay_path.write_text(json.dumps(payload), encoding="utf-8")
    try:
        meta = kaggle_scraper._extract_meta(payload, int(episode_id) if str(episode_id).isdigit() else episode_id)
    except Exception:
        meta = {"episode_id": episode_id}
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {"episode_id": episode_id, "path": str(replay_path.relative_to(replays_root.parent))}


@router.post("/replays/scrape")
def start_scrape(req: ScrapeRequest) -> dict:
    """Start background scrape of Kaggle episodes for a submission.

    Returns {job_id}. Poll GET /replays/scrape/{job_id} for progress.
    """
    if req.count < 1 or req.count > 1000:
        raise HTTPException(
            status_code=400, detail="count must be between 1 and 1000"
        )
    if req.submission_id <= 0:
        raise HTTPException(status_code=400, detail="invalid submission_id")

    import uuid

    job_id = uuid.uuid4().hex

    replays_root = _replays_root()
    replays_root.mkdir(parents=True, exist_ok=True)

    # Pre-register job so immediate progress polls find it. Must happen BEFORE
    # executor.submit, otherwise a fast scrape races us and our sentinel clobbers
    # its completed state.
    with kaggle_scraper._jobs_lock:
        kaggle_scraper._jobs[job_id] = kaggle_scraper.ScrapeJob(
            job_id=job_id,
            submission_id=req.submission_id,
            count=req.count,
            status="pending",
        )

    def _run() -> None:
        try:
            kaggle_scraper.scrape_submission(
                submission_id=req.submission_id,
                count=req.count,
                replays_root=replays_root,
                job_id=job_id,
            )
        except Exception as e:
            with kaggle_scraper._jobs_lock:
                j = kaggle_scraper._jobs.get(job_id)
                if j is not None:
                    j.status = "failed"
                    j.error = f"Internal error: {e}"

    _executor.submit(_run)
    return {"job_id": job_id, "status": "pending"}


@router.get("/replays/scrape/{job_id}")
def get_scrape_progress(job_id: str) -> dict:
    job = kaggle_scraper.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
    return {
        "job_id": job.job_id,
        "submission_id": job.submission_id,
        "count": job.count,
        "status": job.status,
        "total": job.total,
        "downloaded": job.downloaded,
        "error": job.error,
    }


@router.delete("/kaggle-replays/{submission_id}/{episode_id}")
def delete_kaggle_replay(submission_id: int, episode_id: int) -> dict:
    base = _replays_root() / "kaggle" / str(submission_id)
    for p in (
        base / f"episode_{episode_id}.json",
        base / f"episode_{episode_id}.meta.json",
    ):
        if p.is_file():
            p.unlink()
    return {"deleted": True, "submission_id": submission_id, "episode_id": episode_id}


@router.delete("/replays/{run_id}/{match_id}")
def delete_local_replay(run_id: str, match_id: str) -> dict:
    """Delete a local match replay JSON.

    Only removes the replay file — keeps the tournament's results.json
    intact (match history retained, just replay binary is gone).
    """
    run_dir = _safe_subpath(_runs_root(), run_id)
    replays_dir = _safe_subpath(run_dir, "replays")
    if not replays_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")
    # `match_id` feeds the glob pattern below — reject path separators up front
    # to keep the glob from escaping `replays_dir`.
    if "/" in match_id or "\\" in match_id or ".." in match_id:
        raise HTTPException(status_code=400, detail="invalid match id")
    matches = list(replays_dir.glob(f"{match_id}-*.json"))
    if not matches:
        raise HTTPException(
            status_code=404, detail=f"Match {match_id!r} not found"
        )
    for p in matches:
        p.unlink()
    return {"deleted": True, "run_id": run_id, "match_id": match_id}


@router.delete("/agents/{agent_id:path}")
def delete_agent(agent_id: str) -> dict:
    """Delete an agent's folder from the zoo.

    Does NOT touch TrueSkill ratings or historical replays — only removes
    the source under agents/<bucket>/<name>/. User can re-add it later.
    """
    import shutil

    zoo = _zoo_root()
    agent_dir = zoo / agent_id
    # Safety: path must be inside zoo (no traversal)
    try:
        agent_dir.resolve().relative_to(zoo.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid agent path")
    if not agent_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Agent {agent_id!r} not found")
    shutil.rmtree(agent_dir)
    return {"deleted": True, "agent_id": agent_id}


@router.post("/ratings/reset")
def reset_ratings(format: Literal["2p", "4p", "all"] = "all") -> dict:
    """Reset TrueSkill ratings (global persistent store).

    Schema: { schema_version, last_updated, ratings: { agent_id: { "2p": {...}, "4p": {...} } } }
    format="all" → wipe file. format="2p"|"4p" → strip that subkey from every agent.
    """
    import json as _json

    path = _runs_root() / "trueskill.json"
    if not path.is_file():
        return {"reset": True, "cleared": 0}
    if format == "all":
        path.unlink()
        return {"reset": True, "cleared": "all"}
    try:
        data = _json.loads(path.read_text())
    except _json.JSONDecodeError:
        path.unlink()
        return {"reset": True, "cleared": "corrupted"}
    ratings = data.get("ratings", {}) if isinstance(data, dict) else {}
    removed = 0
    for aid in list(ratings.keys()):
        per_fmt = ratings.get(aid, {})
        if format in per_fmt:
            del per_fmt[format]
            removed += 1
        if not per_fmt:
            del ratings[aid]
    data["ratings"] = ratings
    path.write_text(json.dumps(data, indent=2))
    return {"reset": True, "cleared": format, "entries_removed": removed}


@router.delete("/runs/{run_id}")
def delete_run(run_id: str) -> dict:
    """Delete entire tournament run directory (run.json, results.json, replays/)."""
    import shutil

    run_dir = _safe_subpath(_runs_root(), run_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")
    shutil.rmtree(run_dir)
    return {"deleted": True, "run_id": run_id}


@router.get("/kaggle-replays/{submission_id}/{episode_id}")
def get_kaggle_replay(submission_id: int, episode_id: int) -> dict:
    path = (
        _replays_root() / "kaggle" / str(submission_id) / f"episode_{episode_id}.json"
    )
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Kaggle replay {submission_id}/{episode_id} not found",
        )
    return json.loads(path.read_text())


@router.get("/replays/{run_id}/{match_id}")
def get_replay(run_id: str, match_id: str) -> dict:
    run_dir = _runs_root() / run_id
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")
    replays_dir = run_dir / "replays"
    if not replays_dir.is_dir():
        raise HTTPException(status_code=404, detail="No replays directory")
    # match_id = "001"; find file that starts with f"{match_id}-"
    matches = list(replays_dir.glob(f"{match_id}-*.json"))
    if not matches:
        raise HTTPException(status_code=404, detail=f"Match {match_id!r} not found")
    return json.loads(matches[0].read_text())


# ============================================================
# Kaggle submissions (own LB entries + agent logs)
# ============================================================


@router.get("/kaggle-submissions", response_model=list[KaggleSubmission])
def list_kaggle_submissions() -> list[KaggleSubmission]:
    try:
        return kaggle_submissions.list_my_submissions()
    except KaggleCliError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


class SubmitAgentRequest(BaseModel):
    agent_id: str
    description: str


@router.post("/kaggle-submissions")
def submit_kaggle_agent(req: SubmitAgentRequest) -> dict:
    """Submit an agent (by bucket/name id) to orbit-wars via the Kaggle API."""
    if not req.description.strip():
        raise HTTPException(status_code=400, detail="description is required")
    agent_dir = _safe_subpath(_zoo_root(), req.agent_id)
    main_py = agent_dir / "main.py"
    if not main_py.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"No main.py at {main_py} — agent id must be 'bucket/name'",
        )
    # Multi-file agents tar up the whole directory (preserving subdirs like
    # src/ and weights/); single-file uploads main.py alone. Excludes our zoo
    # metadata (agent.yaml) and transient caches; everything else rides along
    # so PyTorch checkpoints, config YAMLs, and nested modules all make it.
    extras = _collect_submission_files(agent_dir)
    with tempfile.TemporaryDirectory() as tmpdir:
        if extras:
            archive = Path(tmpdir) / "submission.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(main_py, arcname="main.py")
                for path in extras:
                    tar.add(path, arcname=str(path.relative_to(agent_dir)))
            upload = archive
        else:
            upload = main_py
        try:
            return kaggle_submissions.submit_agent(upload, req.description.strip())
        except KaggleCliError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)


# Files that exist purely for the local zoo (agent.yaml metadata, caches,
# editor droppings). Everything else in the agent directory is assumed to be
# runtime-needed and gets tarred into the submission.
_SUBMISSION_EXCLUDE_NAMES = {"agent.yaml", ".DS_Store"}
_SUBMISSION_EXCLUDE_SUFFIXES = {".pyc"}
_SUBMISSION_EXCLUDE_DIR_PARTS = {"__pycache__", ".git", ".pytest_cache", ".venv"}


def _collect_submission_files(agent_dir: Path) -> list[Path]:
    """Return all files to bundle alongside main.py (may include subdirs)."""
    out: list[Path] = []
    for p in agent_dir.rglob("*"):
        if not p.is_file():
            continue
        if p.name == "main.py" and p.parent == agent_dir:
            continue
        if p.name in _SUBMISSION_EXCLUDE_NAMES:
            continue
        if p.suffix in _SUBMISSION_EXCLUDE_SUFFIXES:
            continue
        if any(part in _SUBMISSION_EXCLUDE_DIR_PARTS for part in p.relative_to(agent_dir).parts):
            continue
        out.append(p)
    return sorted(out)


@router.get(
    "/kaggle-submissions/{sub_id}/episodes/{ep_id}/logs",
    response_model=AgentLogsResponse,
)
def get_kaggle_agent_logs(sub_id: int, ep_id: int) -> AgentLogsResponse:
    idx = kaggle_submissions.infer_my_agent_idx(
        sub_id, ep_id, _replays_root(),
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        if idx is not None:
            try:
                text = kaggle_submissions.fetch_agent_logs(ep_id, idx, cwd=tmp)
            except KaggleCliError as e:
                raise HTTPException(status_code=e.status_code, detail=e.message)
            return AgentLogsResponse(
                submission_id=sub_id, episode_id=ep_id, agent_idx=idx, text=text
            )
        # Metadata miss — probe every possible slot. 2p games fill 0–1, 4p FFA
        # fills 0–3; Kaggle returns 403 for slots that aren't us. Stop on the
        # first 2xx; re-raise non-403 errors.
        for candidate in range(4):
            try:
                text = kaggle_submissions.fetch_agent_logs(ep_id, candidate, cwd=tmp)
                return AgentLogsResponse(
                    submission_id=sub_id,
                    episode_id=ep_id,
                    agent_idx=candidate,
                    text=text,
                )
            except KaggleCliError as e:
                if e.status_code == 403:
                    continue
                raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(
            status_code=404,
            detail="Cannot determine your agent index — scrape replay metadata first",
        )


# ============================================================
# Kaggle auth (Settings tab — wire up ~/.kaggle/kaggle.json from browser)
# ============================================================


class KaggleAuthStatus(BaseModel):
    connected: bool
    username: str | None
    source: str | None = None            # "file" | "env" | None
    shadowed: bool | None = None         # set by save when env vars shadow the saved file
    saved_username: str | None = None    # only when shadowed=True
    deleted: bool | None = None          # only on DELETE responses


class KaggleTokenRequest(BaseModel):
    # Kaggle tokens are ~80 bytes; 2 KB leaves room for odd formatting
    # (trailing newlines, BOM, minor whitespace) but caps DoS via giant bodies.
    token: str = Field(..., max_length=2048)


@router.get("/kaggle-auth", response_model=KaggleAuthStatus)
def get_kaggle_auth_status() -> KaggleAuthStatus:
    return KaggleAuthStatus(**kaggle_auth.get_status())


@router.post("/kaggle-auth", response_model=KaggleAuthStatus)
def save_kaggle_auth(req: KaggleTokenRequest) -> KaggleAuthStatus:
    try:
        return KaggleAuthStatus(**kaggle_auth.save_token(req.token))
    except KaggleAuthError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.delete("/kaggle-auth", response_model=KaggleAuthStatus)
def clear_kaggle_auth() -> KaggleAuthStatus:
    try:
        return KaggleAuthStatus(**kaggle_auth.clear_token())
    except KaggleAuthError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


# Single-tournament lock + tracking state
_tournament_lock = threading.Lock()
_current_run_id: str | None = None
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)


@router.post("/tournaments")
async def start_tournament(cfg: TournamentConfig) -> dict:
    global _current_run_id
    with _tournament_lock:
        if _current_run_id is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "tournament_in_progress",
                    "current_run_id": _current_run_id,
                },
            )
        # Reserve the slot with a sentinel so concurrent POSTs see the lock
        _current_run_id = "<starting>"

    zoo_root = _zoo_root()
    runs_root = _runs_root()
    runs_root.mkdir(parents=True, exist_ok=True)
    t = Tournament(config=cfg, runs_root=runs_root, zoo_root=zoo_root)

    # Launch in background thread so POST returns promptly
    def _run_and_clear() -> None:
        global _current_run_id
        try:
            t.run()
        finally:
            with _tournament_lock:
                _current_run_id = None

    _executor.submit(_run_and_clear)

    # Poll runs_root for newly-created run.json (≤5 s)
    deadline = time.monotonic() + 5.0
    run_id: str | None = None
    while time.monotonic() < deadline:
        for p in sorted(runs_root.iterdir(), reverse=True):
            if not p.is_dir() or p.name == "latest":
                continue
            run_json = p / "run.json"
            if run_json.is_file():
                try:
                    data = json.loads(run_json.read_text())
                except json.JSONDecodeError:
                    continue
                if data.get("status") == "running":
                    run_id = data["id"]
                    break
        if run_id is not None:
            break
        await asyncio.sleep(0.05)

    if run_id is None:
        # Release lock — Tournament.run might be stuck or crashed early
        with _tournament_lock:
            _current_run_id = None
        raise HTTPException(
            status_code=500,
            detail="Tournament started but run.json never appeared",
        )

    with _tournament_lock:
        _current_run_id = run_id

    return {"run_id": run_id, "status": "starting"}

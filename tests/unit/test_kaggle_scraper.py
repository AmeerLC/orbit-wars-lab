"""Unit tests for orbit_wars_app.kaggle_scraper."""
from __future__ import annotations

import json
from pathlib import Path

from orbit_wars_app import kaggle_scraper as ks


def test_list_local_kaggle_replays_includes_legacy_upload_filenames(tmp_path: Path) -> None:
    uploads_dir = tmp_path / "kaggle" / "Uploads"
    uploads_dir.mkdir(parents=True)

    episode_id = 77507577
    replay_path = uploads_dir / f"{episode_id}.json"
    meta_path = uploads_dir / f"{episode_id}.meta.json"
    replay_path.write_text(json.dumps({
        "info": {"Agents": [{"Name": "A"}, {"Name": "B"}]},
        "rewards": [1, -1],
    }), encoding="utf-8")
    meta_path.write_text(json.dumps({
        "meta_schema": 2,
        "episode_id": episode_id,
        "agents": [{"name": "A"}, {"name": "B"}],
        "team_names": ["A", "B"],
        "winner": "A",
    }), encoding="utf-8")

    result = ks.list_local_kaggle_replays(tmp_path)

    assert len(result) == 1
    assert result[0]["source"] == "kaggle"
    assert result[0]["submission_id"] == 0
    assert result[0]["episode_id"] == episode_id
    assert result[0]["agents"] == [{"name": "A"}, {"name": "B"}]
    assert result[0]["path"].endswith(f"kaggle/Uploads/{episode_id}.json")

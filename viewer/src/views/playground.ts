/**
 * Playground — visual map editor + match runner.
 *
 * Top: canvas for drag-and-drop planet placement.
 * Middle: agent selects, format toggle, Add Planet, Randomize, Run Match.
 * Bottom: embedded replay (expands over editor when match completes).
 */

import { installHeaderNav } from "../components/header-nav";
import { mountEmbeddedReplay, EmbeddedReplayHandle } from "../components/embedded-replay";
import { api, AgentInfo, PlaygroundEnvironment, PlaygroundEnvironmentFull } from "../api";
import { PLAYER_COLORS, NEUTRAL_COLOR } from "../renderer/palette";

// ---- Types ----

interface PlanetData {
  id: number;
  owner: number; // -1 neutral, 0=P1, 1=P2, 2=P3, 3=P4
  x: number;
  y: number;
  radius: number;
  ships: number;
  production: number;
}

interface MatchRunState {
  kind: "idle" | "running" | "done" | "error";
  msg?: string;
}

// ---- Constants ----

const BOARD = 100;
const CENTER = 50;
const SUN_R = 10;
const ROTATION_LIMIT = 50; // planets with orbital_r + radius < this rotate; beyond = static
const DEFAULT_RADIUS = 1.5;
const DEFAULT_SHIPS = 10;
const DEFAULT_PRODUCTION = 2;

// ---- Planet rendering helpers ----

function planetColor(owner: number, numPlayers: number): string {
  if (owner < 0 || owner >= numPlayers) return NEUTRAL_COLOR;
  return PLAYER_COLORS[owner] || NEUTRAL_COLOR;
}

function sunDist(x: number, y: number): number {
  return Math.sqrt((x - CENTER) ** 2 + (y - CENTER) ** 2);
}

function inSun(x: number, y: number, r: number): boolean {
  return sunDist(x, y) < SUN_R + r;
}

function onBoard(x: number, y: number, r: number): boolean {
  return x - r >= 0 && x + r <= BOARD && y - r >= 0 && y + r <= BOARD;
}

function clampToBoard(x: number, y: number, r: number): [number, number] {
  const cx = Math.max(r, Math.min(BOARD - r, x));
  const cy = Math.max(r, Math.min(BOARD - r, y));
  if (inSun(cx, cy, r)) {
    const d = sunDist(cx, cy);
    const minD = SUN_R + r + 0.5;
    if (d < minD) {
      const scale = minD / d;
      return [CENTER + (cx - CENTER) * scale, CENTER + (cy - CENTER) * scale];
    }
  }
  return [cx, cy];
}

function isOrbiting(p: PlanetData): boolean {
  return sunDist(p.x, p.y) + p.radius < ROTATION_LIMIT;
}

function randomPlanets(format: "2p" | "4p"): PlanetData[] {
  const numPlayers = format === "4p" ? 4 : 2;
  const planets: PlanetData[] = [];
  let id = 0;

  const angleStep = (2 * Math.PI) / numPlayers;
  const homeRadius = 32 + Math.random() * 8;
  for (let p = 0; p < numPlayers; p++) {
    const angle = angleStep * p + (Math.random() - 0.5) * 0.3;
    const x = CENTER + Math.cos(angle) * homeRadius;
    const y = CENTER + Math.sin(angle) * homeRadius;
    planets.push({ id: id++, owner: p, x, y, radius: 1.5, ships: 10, production: 2 });
  }

  const neutralCount = 6 + Math.floor(Math.random() * 8);
  for (let i = 0; i < neutralCount; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = 18 + Math.random() * 30;
    const x = CENTER + Math.cos(angle) * dist;
    const y = CENTER + Math.sin(angle) * dist;
    const prod = 1 + Math.floor(Math.random() * 4);
    const r = 1 + Math.log(prod);
    const ships = 5 + Math.floor(Math.random() * 40);
    if (!inSun(x, y, r) && onBoard(x, y, r)) {
      planets.push({ id: id++, owner: -1, x, y, radius: r, ships, production: prod });
    }
  }

  return planets;
}

// ---- Canvas drawing ----

function drawSun(ctx: CanvasRenderingContext2D, s: number) {
  const cx = CENTER * s, cy = CENTER * s, sr = SUN_R * s;
  const grad = ctx.createRadialGradient(cx, cy, sr * 0.2, cx, cy, sr);
  grad.addColorStop(0, "#fff7d0");
  grad.addColorStop(0.4, "#ffcc44");
  grad.addColorStop(1, "#994400");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, sr, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, s: number) {
  ctx.strokeStyle = "rgba(100,120,180,0.08)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= BOARD; i += 10) {
    const v = i * s;
    ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(w, v); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(120,150,220,0.22)";
  for (let i = 0; i <= BOARD; i += 50) {
    const v = i * s;
    ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(w, v); ctx.stroke();
  }
}

function drawRotationLimit(ctx: CanvasRenderingContext2D, s: number) {
  const cx = CENTER * s, cy = CENTER * s, r = ROTATION_LIMIT * s;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 200, 100, 0.25)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 8]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // Label
  ctx.fillStyle = "rgba(255, 200, 100, 0.4)";
  ctx.font = `${Math.max(7, 9 * s / 50)}px monospace`;
  ctx.textAlign = "left";
  ctx.fillText("orbit limit", cx + r + 4, cy - 2);
  ctx.restore();
}

function drawPlanets(
  ctx: CanvasRenderingContext2D,
  planets: PlanetData[],
  s: number,
  numPlayers: number,
  selectedId: number | null,
) {
  for (const p of planets) {
    const cx = p.x * s, cy = p.y * s, r = p.radius * s;
    const color = planetColor(p.owner, numPlayers);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (p.id === selectedId) {
      ctx.strokeStyle = "rgba(138,196,255,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Orbit indicator dot on the planet if it's an orbiting planet
    if (isOrbiting(p)) {
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(cx, cy - r - 3, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ship count
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.max(8, 10 * s / 50)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.fillText(`${p.ships}`, cx, cy);
    ctx.shadowBlur = 0;

    // Production label
    const prodY = cy + r + (10 * s) / 50;
    ctx.fillStyle = "rgba(180,190,220,0.75)";
    ctx.font = `${Math.max(6, 8 * s / 50)}px monospace`;
    ctx.fillText(`+${p.production}`, cx, prodY);
  }
}

// ---- Planet hit testing ----

function hitPlanet(mx: number, my: number, planets: PlanetData[], s: number): PlanetData | null {
  for (let i = planets.length - 1; i >= 0; i--) {
    const p = planets[i];
    const dx = mx - p.x * s;
    const dy = my - p.y * s;
    if (Math.sqrt(dx * dx + dy * dy) <= p.radius * s + 4) {
      return p;
    }
  }
  return null;
}

function canvasToBoard(cx: number, cy: number, s: number): [number, number] {
  return [cx / s, cy / s];
}

// ---- Main render ----

export async function renderPlayground(root: HTMLElement): Promise<void> {
  const numPlayers = () => (format === "4p" ? 4 : 2);

  root.innerHTML = `
    <div class="playground">
      <div class="pg-runner" id="pg-runner">
        <div class="pg-editor" id="pg-editor">
          <div class="pg-canvas-wrap">
            <canvas class="pg-canvas" id="pg-canvas"></canvas>
            <div class="pg-property-panel" id="pg-prop" hidden>
              <div class="pg-prop-row">
                <label class="pg-prop-label">Owner</label>
                <div class="pg-prop-owners" id="pg-prop-owners"></div>
              </div>
              <div class="pg-prop-row">
                <label class="pg-prop-label" for="pg-prop-ships">Ships</label>
                <input class="pg-prop-input" id="pg-prop-ships" type="number" min="0" max="999" value="10">
              </div>
              <div class="pg-prop-row">
                <label class="pg-prop-label" for="pg-prop-prod">Prod</label>
                <input class="pg-prop-input" id="pg-prop-prod" type="number" min="0" max="99" value="2">
              </div>
              <div class="pg-prop-row">
                <label class="pg-prop-label" for="pg-prop-radius">Radius</label>
                <input class="pg-prop-input" id="pg-prop-radius" type="number" min="0.5" max="10" step="0.1" value="1.5">
              </div>
              <div class="pg-prop-row">
                <span class="pg-prop-label">Position</span>
                <span class="pg-prop-coord" id="pg-prop-x">0.0</span>
                <span class="pg-prop-sep">,</span>
                <span class="pg-prop-coord" id="pg-prop-y">0.0</span>
              </div>
              <div class="pg-prop-info" id="pg-prop-info"></div>
              <div class="pg-prop-actions">
                <button class="pg-prop-del" id="pg-prop-del">Delete</button>
                <button class="pg-prop-close" id="pg-prop-close">✕</button>
              </div>
            </div>
          </div>
          <div class="pg-collapsible pg-collapsible-open" id="pg-controls-collapsible">
            <button class="pg-collapse-btn" id="pg-controls-collapse-btn">▼ Controls</button>
            <div class="pg-controls" id="pg-controls-content">
              <div class="pg-controls-row">
                <div class="config-group">
                  <span class="config-label">format</span>
                  <button class="config-pill on" data-fmt="2p">2p</button>
                  <button class="config-pill" data-fmt="4p">4p</button>
                </div>
                <button class="config-pill" id="pg-add-planet">+ Add Planet</button>
                <button class="config-pill" id="pg-randomize">Randomize Map</button>
                <button class="config-pill" id="pg-clear">Clear</button>
                <button class="config-pill" id="pg-upload-env">Upload JSON</button>
                <button class="config-pill" id="pg-save-env">Save</button>
                <input id="pg-upload-input" type="file" accept="application/json" hidden>
              </div>
              <div class="pg-controls-row" id="pg-agent-row"></div>
              <div class="pg-controls-row">
                <button class="qm-play" id="pg-run">Run Match</button>
                <span class="pg-status" id="pg-status"></span>
              </div>
              <div class="pg-save-panel" id="pg-save-panel" hidden>
                <label class="pg-prop-label">Save as:</label>
                <input class="pg-save-input" id="pg-save-input" type="text" placeholder="environment name" maxlength="128">
                <button class="config-pill" id="pg-save-btn">Save</button>
                <button class="config-pill" id="pg-cancel-save">Cancel</button>
                <span class="pg-save-status" id="pg-save-status"></span>
              </div>
            </div>
          </div>
          <div class="pg-collapsible" id="pg-collapsible">
            <button class="pg-collapse-btn" id="pg-collapse-btn">▼ My Environments</button>
            <div class="pg-environments" id="pg-environments" hidden>
              <div class="pg-env-grid" id="pg-env-grid"></div>
            </div>
          </div>
        </div>
        <div class="pg-replay-area" id="pg-replay-area" hidden>
          <div class="pg-replay-bar">
            <span class="pg-replay-title">Replay</span>
            <button class="pg-replay-back" id="pg-replay-back" title="Back to editor">← Editor</button>
          </div>
          <div class="pg-replay-inner" id="pg-replay"></div>
        </div>
      </div>
    </div>
  `;
  installHeaderNav(root, "playground");

  // ---- State ----
  let planets: PlanetData[] = [];
  let nextId = 0;
  let selectedId: number | null = null;
  let format: "2p" | "4p" = "2p";
  let agentIds: string[] = ["", ""];
  let agents: AgentInfo[] = [];
  let matchState: MatchRunState = { kind: "idle" };
  let activeReplay: EmbeddedReplayHandle | null = null;
  // ---- DOM refs ----
  const canvas = document.getElementById("pg-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const wrap = root.querySelector(".pg-canvas-wrap")!;
  const propPanel = document.getElementById("pg-prop")! as HTMLElement;
  const propOwners = document.getElementById("pg-prop-owners")!;
  const propShips = document.getElementById("pg-prop-ships") as HTMLInputElement;
  const propProd = document.getElementById("pg-prop-prod") as HTMLInputElement;
  const propRadius = document.getElementById("pg-prop-radius") as HTMLInputElement;
  const propInfo = document.getElementById("pg-prop-info")!;
  const propX = document.getElementById("pg-prop-x")!;
  const propY = document.getElementById("pg-prop-y")!;
  const propDel = document.getElementById("pg-prop-del")!;
  const propClose = document.getElementById("pg-prop-close")!;
  const agentRow = document.getElementById("pg-agent-row")!;
  const runBtn = document.getElementById("pg-run") as HTMLButtonElement;
  const statusEl = document.getElementById("pg-status")!;
  const runner = document.getElementById("pg-runner")!;
  const replayArea = document.getElementById("pg-replay-area")!;
  const replayInner = document.getElementById("pg-replay")!;
  const replayBack = document.getElementById("pg-replay-back")!;
  const savePanel = document.getElementById("pg-save-panel")!;
  const saveInput = document.getElementById("pg-save-input") as HTMLInputElement;
  const saveBtn = document.getElementById("pg-save-btn") as HTMLButtonElement;
  const cancelSaveBtn = document.getElementById("pg-cancel-save") as HTMLButtonElement;
  const saveStatus = document.getElementById("pg-save-status")!;
  const uploadBtn = document.getElementById("pg-upload-env") as HTMLButtonElement;
  const uploadInput = document.getElementById("pg-upload-input") as HTMLInputElement;
  const envGrid = document.getElementById("pg-env-grid")!;
  const controlsCollapseBtn = document.getElementById("pg-controls-collapse-btn")!;
  const controlsContent = document.getElementById("pg-controls-content")! as HTMLElement;
  let controlsCollapsed = true;
  const envCollapsible = document.getElementById("pg-collapsible")!;
  const envCollapseBtn = document.getElementById("pg-collapse-btn")!;
  let envCollapsed = true;

  function updateControlsCollapseState() {
    controlsContent.hidden = controlsCollapsed;
    controlsContent.style.display = controlsCollapsed ? "none" : "flex";
    controlsCollapseBtn.textContent = controlsCollapsed ? "▶ Controls" : "▼ Controls";
  }

  function updateEnvironmentCollapseState() {
    const envsDiv = envCollapsible.querySelector(".pg-environments")! as HTMLElement;
    envsDiv.hidden = envCollapsed;
    envCollapseBtn.textContent = envCollapsed ? "▶ My Environments" : "▼ My Environments";
  }

  updateControlsCollapseState();
  updateEnvironmentCollapseState();

  // ---- Canvas sizing ----
  function resizeCanvas() {
    const rect = wrap.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height) - 16;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    renderCanvas();
  }
  const ro = new ResizeObserver(resizeCanvas);
  ro.observe(wrap);

  // ---- Rendering ----
  function panelScale(): number {
    return canvas.width / (window.devicePixelRatio || 1) / BOARD;
  }

  function renderCanvas() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = panelScale();

    ctx.fillStyle = "#0a0a14";
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    drawGrid(ctx, canvas.width / dpr, canvas.height / dpr, s);
    drawRotationLimit(ctx, s);
    drawSun(ctx, s);
    drawPlanets(ctx, planets, s, numPlayers(), selectedId);
  }

  // ---- Property panel ----
  function showPropPanel(p: PlanetData) {
    selectedId = p.id;
    propPanel.hidden = false;

    propOwners.innerHTML = `
      <button class="pg-owner-btn ${p.owner === -1 ? "on" : ""}" data-owner="-1" style="--c:${NEUTRAL_COLOR}">N</button>
      ${Array.from({ length: numPlayers() }, (_, i) => `
        <button class="pg-owner-btn ${p.owner === i ? "on" : ""}" data-owner="${i}" style="--c:${PLAYER_COLORS[i]}">P${i + 1}</button>
      `).join("")}
    `;
    propOwners.querySelectorAll<HTMLButtonElement>(".pg-owner-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const o = parseInt(btn.dataset.owner!, 10);
        const planet = planets.find((pl) => pl.id === selectedId);
        if (planet) { planet.owner = o; renderCanvas(); showPropPanel(planet); }
      });
    });

    propShips.value = String(p.ships);
    propProd.value = String(p.production);
    propRadius.value = String(p.radius);
    propX.textContent = p.x.toFixed(1);
    propY.textContent = p.y.toFixed(1);

    const orbits = isOrbiting(p);
    propInfo.textContent = orbits ? "↻ orbits sun" : "static (too far to orbit)";
    propInfo.className = orbits ? "pg-prop-orbit" : "pg-prop-static";

    const s = panelScale();
    let px = p.x * s + p.radius * s + 12;
    let py = p.y * s - 70;
    if (px + 170 > canvas.clientWidth) px = p.x * s - 182;
    if (py < 4) py = p.y * s + p.radius * s + 12;
    propPanel.style.left = `${px}px`;
    propPanel.style.top = `${py}px`;

    renderCanvas();
  }

  function hidePropPanel() {
    selectedId = null;
    propPanel.hidden = true;
    renderCanvas();
  }

  function applyPropChanges() {
    const planet = planets.find((p) => p.id === selectedId);
    if (!planet) return;
    planet.ships = Math.max(0, parseInt(propShips.value, 10) || 0);
    planet.production = Math.max(0, parseInt(propProd.value, 10) || 0);
    planet.radius = Math.max(0.5, parseFloat(propRadius.value) || 1.5);
    renderCanvas();
  }

  function addPlanetAt(bx: number, by: number) {
    const r = DEFAULT_RADIUS;
    const [cx, cy] = clampToBoard(bx, by, r);
    if (!inSun(cx, cy, r) && onBoard(cx, cy, r)) {
      const p: PlanetData = { id: nextId++, owner: -1, x: cx, y: cy, radius: r, ships: DEFAULT_SHIPS, production: DEFAULT_PRODUCTION };
      planets.push(p);
      renderCanvas();
      showPropPanel(p);
    }
  }

  propShips.addEventListener("input", applyPropChanges);
  propProd.addEventListener("input", applyPropChanges);
  propRadius.addEventListener("input", applyPropChanges);

  propDel.addEventListener("click", () => {
    const pid = selectedId;
    hidePropPanel();
    planets = planets.filter((p) => p.id !== pid);
    renderCanvas();
  });

  propClose.addEventListener("click", hidePropPanel);

  // ---- Canvas interaction ----
  let draggingId: number | null = null;

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const s = panelScale();
    const hit = hitPlanet(mx, my, planets, s);

    if (e.button === 0 && hit) {
      draggingId = hit.id;
      showPropPanel(hit);
      e.preventDefault();
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (draggingId === null) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const s = panelScale();
    const [bx, by] = canvasToBoard(mx, my, s);
    const planet = planets.find((p) => p.id === draggingId);
    if (!planet) return;
    const [cx, cy] = clampToBoard(bx, by, planet.radius);
    if (!inSun(cx, cy, planet.radius)) {
      planet.x = cx;
      planet.y = cy;
    }
    renderCanvas();
    if (selectedId === draggingId) {
      propX.textContent = cx.toFixed(1);
      propY.textContent = cy.toFixed(1);
      const px = cx * s + planet.radius * s + 12;
      const py = cy * s - 70;
      if (px + 170 <= canvas.clientWidth) propPanel.style.left = `${px}px`;
      if (py >= 4) propPanel.style.top = `${py}px`;
    }
  });

  window.addEventListener("mouseup", () => {
    draggingId = null;
  });

  // Single-click on empty space: close panel if open, else add planet
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const s = panelScale();
    const hit = hitPlanet(mx, my, planets, s);
    if (hit) return; // handled by mousedown
    if (!propPanel.hidden) {
      hidePropPanel();
    } else {
      const [bx, by] = canvasToBoard(mx, my, s);
      addPlanetAt(bx, by);
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const s = panelScale();
    const hit = hitPlanet(mx, my, planets, s);
    if (hit) {
      if (selectedId === hit.id) hidePropPanel();
      planets = planets.filter((p) => p.id !== hit.id);
      renderCanvas();
    }
  });

  // ---- Add Planet button ----
  document.getElementById("pg-add-planet")!.addEventListener("click", () => {
    // Place new planet above the sun, nudged to avoid overlap
    let bx = 50, by = 20;
    // Find a spot not occupied
    for (let attempt = 0; attempt < 20; attempt++) {
      bx = 20 + Math.random() * 60;
      by = 15 + Math.random() * 35;
      const r = DEFAULT_RADIUS;
      if (!inSun(bx, by, r) && onBoard(bx, by, r)) {
        const s = panelScale();
        if (!hitPlanet(bx * s, by * s, planets, s)) break;
      }
    }
    hidePropPanel();
    addPlanetAt(bx, by);
  });

  // ---- Randomize ----
  document.getElementById("pg-randomize")!.addEventListener("click", () => {
    hidePropPanel();
    planets = randomPlanets(format);
    nextId = planets.length;
    renderCanvas();
  });

  // ---- Clear ----
  document.getElementById("pg-clear")!.addEventListener("click", () => {
    hidePropPanel();
    planets = [];
    nextId = 0;
    renderCanvas();
  });

  // ---- Save Environment ----
  document.getElementById("pg-save-env")!.addEventListener("click", () => {
    savePanel.hidden = false;
    saveInput.value = "";
    saveStatus.textContent = "";
    saveInput.focus();
  });

  cancelSaveBtn.addEventListener("click", () => {
    savePanel.hidden = true;
    saveStatus.textContent = "";
  });

  saveBtn.addEventListener("click", async () => {
    const name = saveInput.value.trim();
    if (!name) {
      saveStatus.textContent = "Enter a name";
      return;
    }
    const np = numPlayers();
    const picked = agentIds.slice(0, np);
    if (picked.some((a) => !a)) {
      saveStatus.textContent = "Select agents first";
      return;
    }
    try {
      await api.saveEnvironment({
        name,
        planets: planets.map((p) => ({
          x: Number(p.x.toFixed(2)),
          y: Number(p.y.toFixed(2)),
          radius: p.radius,
          ships: p.ships,
          production: p.production,
          owner: p.owner,
        })),
        agent_ids: picked,
        format,
      });
      saveStatus.textContent = "Saved!";
      savePanel.hidden = true;
      await loadEnvironments();
    } catch (err) {
      saveStatus.textContent = `Error: ${(err as Error).message}`;
    }
  });

  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async () => {
    if (!uploadInput.files || uploadInput.files.length === 0) return;
    const file = uploadInput.files[0];
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      const env = parseUploadedEnvironment(data);
      loadUploadedEnvironment(env);
      statusEl.textContent = `Loaded ${file.name}`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Upload failed: ${(err as Error).message}`;
    } finally {
      uploadInput.value = "";
    }
  });

  saveInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveBtn.click();
  });

  // ---- Collapsible Controls ----
  controlsCollapseBtn.addEventListener("click", () => {
    controlsCollapsed = !controlsCollapsed;
    updateControlsCollapseState();
  });

  // ---- Collapsible Environments ----
  envCollapseBtn.addEventListener("click", () => {
    envCollapsed = !envCollapsed;
    updateEnvironmentCollapseState();
  });

  // ---- Environments List ----
  async function loadEnvironments() {
    try {
      const envs = await api.listEnvironments();
      renderEnvironmentGrid(envs);
    } catch (err) {
      // Silently fail - environments are optional
      envGrid.innerHTML = `<div class="pg-env-empty">No saved environments</div>`;
    }
  }

  function renderEnvironmentGrid(envs: PlaygroundEnvironment[]) {
    if (envs.length === 0) {
      envGrid.innerHTML = `<div class="pg-env-empty">No saved environments</div>`;
      return;
    }
    envGrid.innerHTML = envs.map((env) => {
      const date = env.created_at ? new Date(env.created_at).toLocaleDateString() : "Unknown date";
      return `
        <div class="pg-env-card" data-env="${env.name}">
          <div class="pg-env-card-header">
            <span class="pg-env-card-name">${env.name}</span>
          </div>
          <div class="pg-env-card-meta">
            ${env.planet_count} planets • ${env.format} • ${env.player_count} players • ${date}
          </div>
          <div class="pg-env-card-actions">
            <button class="pg-env-btn pg-env-load">Load</button>
            <button class="pg-env-btn pg-env-run">Run Match</button>
            <button class="pg-env-btn delete pg-env-delete">Delete</button>
          </div>
        </div>
      `;
    }).join("");

    envGrid.querySelectorAll(".pg-env-load").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = (btn.parentElement!.parentElement! as HTMLElement).dataset.env!;
        try {
          const env = await api.getEnvironment(name);
          await loadEnvironment(env);
        } catch (err) {
          statusEl.textContent = `Error: ${(err as Error).message}`;
        }
      });
    });

    envGrid.querySelectorAll(".pg-env-run").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = (btn.parentElement!.parentElement! as HTMLElement).dataset.env!;
        try {
          const env = await api.getEnvironment(name);
          await runEnvironmentMatch(env);
        } catch (err) {
          statusEl.textContent = `Error: ${(err as Error).message}`;
        }
      });
    });

    envGrid.querySelectorAll(".pg-env-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = (btn.parentElement!.parentElement! as HTMLElement).dataset.env!;
        if (!confirm(`Delete environment "${name}"?`)) return;
        try {
          await api.deleteEnvironment(name);
          await loadEnvironments();
        } catch (err) {
          statusEl.textContent = `Error: ${(err as Error).message}`;
        }
      });
    });
  }

  async function loadEnvironment(env: PlaygroundEnvironmentFull) {
    hidePropPanel();
    format = env.format as "2p" | "4p";
    root.querySelectorAll<HTMLButtonElement>("[data-fmt]").forEach((b) =>
      b.classList.toggle("on", b.dataset.fmt === format)
    );
    planets = env.planets.map((p, i) => ({
      id: i,
      owner: p.owner,
      x: p.x,
      y: p.y,
      radius: p.radius,
      ships: p.ships,
      production: p.production,
    }));
    nextId = planets.length;
    const np = numPlayers();
    while (agentIds.length < np) agentIds.push("");
    agentIds = agentIds.slice(0, np);
    env.agent_ids.forEach((aid, i) => {
      if (i < np) agentIds[i] = aid;
    });
    renderAgentRow();
    renderCanvas();
  }

  function parseUploadedEnvironment(data: unknown) {
    function parsePlanetArray(planetsData: any): PlanetData[] {
      if (!Array.isArray(planetsData) || planetsData.length === 0) {
        return [];
      }
      return planetsData.map((item: any, index: number) => {
        if (!Array.isArray(item) || item.length < 7) {
          throw new Error("Planet entry is malformed.");
        }
        return {
          id: index,
          owner: Number(item[1]),
          x: Number(item[2]),
          y: Number(item[3]),
          radius: Number(item[4]),
          ships: Number(item[5]),
          production: Number(item[6]),
        };
      });
    }

    function parseObservation(obs: any) {
      const planets = parsePlanetArray(obs.planets);
      const initialPlanets = parsePlanetArray(obs.initial_planets);
      const hasOwnedPlanets = (arr: PlanetData[]) => arr.some((p) => p.owner >= 0);
      if (hasOwnedPlanets(planets)) {
        return planets;
      }
      if (hasOwnedPlanets(initialPlanets)) {
        return initialPlanets;
      }
      if (planets.length > 0) {
        return planets;
      }
      if (initialPlanets.length > 0) {
        return initialPlanets;
      }
      throw new Error("Uploaded JSON does not contain initial planets or planets data.");
    }

    let planets: PlanetData[] | null = null;
    if (Array.isArray(data)) {
      for (const step of data) {
        if (Array.isArray(step)) {
          for (const frame of step) {
            if (frame && frame.observation) {
              try {
                planets = parseObservation(frame.observation);
                break;
              } catch {
                continue;
              }
            }
          }
        } else if (step && step.observation) {
          try {
            planets = parseObservation(step.observation);
          } catch {
            // continue
          }
        }
        if (planets) break;
      }
    } else if (data && typeof data === "object") {
      const obj = data as any;
      if (Array.isArray(obj.steps)) {
        return parseUploadedEnvironment(obj.steps);
      }
      if (obj.observation) {
        planets = parseObservation(obj.observation);
      }
    }
    if (!planets) {
      throw new Error("Unable to extract planets from uploaded JSON.");
    }
    const ownerIds = planets.map((p) => p.owner).filter((o) => o >= 0);
    const maxOwner = ownerIds.length ? Math.max(...ownerIds) : 1;
    const playerCount = maxOwner >= 3 ? 4 : 2;
    const formatValue: "2p" | "4p" = playerCount === 4 ? "4p" : "2p";
    return {
      planets,
      format: formatValue,
    };
  }

  function loadUploadedEnvironment(env: { planets: PlanetData[]; format: "2p" | "4p"; }) {
    hidePropPanel();
    format = env.format;
    root.querySelectorAll<HTMLButtonElement>("[data-fmt]").forEach((b) =>
      b.classList.toggle("on", b.dataset.fmt === format)
    );
    planets = env.planets.map((p, i) => ({ ...p, id: i }));
    nextId = planets.length;
    const np = numPlayers();
    agentIds = agentIds.slice(0, np);
    while (agentIds.length < np) agentIds.push("");
    renderAgentRow();
    renderCanvas();
  }

  async function runEnvironmentMatch(env: PlaygroundEnvironmentFull) {
    const np = numPlayers();
    const picked = env.agent_ids.slice(0, np);
    if (picked.some((a) => !a)) {
      statusEl.textContent = "Environment missing agent selections";
      return;
    }
    for (let i = 0; i < np; i++) {
      if (!env.planets.some((p) => p.owner === i)) {
        statusEl.textContent = `P${i + 1} needs at least one home planet`;
        return;
      }
    }
    matchState = { kind: "running" };
    updateRunState();
    runBtn.textContent = "Running…";
    statusEl.textContent = "";
    hidePropPanel();

    try {
      const resp = await api.runPlayground({
        planets: env.planets,
        agent_ids: picked,
        format: env.format as "2p" | "4p",
      });

      matchState = { kind: "done" };
      runBtn.textContent = "Run Match";
      statusEl.textContent = "";

      replayInner.innerHTML = "";
      activeReplay = mountEmbeddedReplay(replayInner);
      activeReplay.playLocal(resp.run_id, resp.match_id);
      showReplay();
    } catch (err) {
      matchState = { kind: "error", msg: (err as Error).message };
      runBtn.textContent = "Run Match";
      statusEl.textContent = `Error: ${(err as Error).message}`;
    }
    updateRunState();
  }

  // ---- Format toggle ----
  root.querySelectorAll<HTMLButtonElement>("[data-fmt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      format = btn.dataset.fmt as "2p" | "4p";
      root.querySelectorAll<HTMLButtonElement>("[data-fmt]").forEach((b) =>
        b.classList.toggle("on", b.dataset.fmt === format)
      );
      const np = numPlayers();
      while (agentIds.length < np) agentIds.push("");
      agentIds = agentIds.slice(0, np);
      for (const p of planets) {
        if (p.owner >= np) p.owner = -1;
      }
      hidePropPanel();
      renderAgentRow();
      renderCanvas();
    });
  });

  // ---- Agent selects ----
  function renderAgentRow() {
    agentRow.innerHTML = agentIds
      .map((aid, i) => {
        const color = PLAYER_COLORS[i];
        const opts = agents
          .filter((a) => !a.disabled)
          .map((a) => `<option value="${a.id}" ${a.id === aid ? "selected" : ""}>${a.name}</option>`)
          .join("");
        return `
          <div class="pg-agent-slot">
            <span class="color-dot" style="background:${color}"></span>
            <span class="pg-agent-label">P${i + 1}</span>
            <select class="pg-agent-select" data-slot="${i}">
              <option value="">-- pick agent --</option>
              ${opts}
            </select>
          </div>
        `;
      })
      .join("");
    agentRow.querySelectorAll<HTMLSelectElement>(".pg-agent-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const i = parseInt(sel.dataset.slot!, 10);
        agentIds[i] = sel.value;
        updateRunState();
      });
    });
  }

  // ---- Replay: show/hide ----
  function showReplay() {
    runner.classList.add("pg-runner-replay");
    replayArea.hidden = false;
  }

  function hideReplay() {
    runner.classList.remove("pg-runner-replay");
    replayArea.hidden = true;
  }

  replayBack.addEventListener("click", () => {
    hideReplay();
  });

  // ---- Run button state ----
  function updateRunState() {
    const np = numPlayers();
    const allPicked = agentIds.slice(0, np).every((a) => a !== "");
    const running = matchState.kind === "running";
    runBtn.disabled = !allPicked || running;
  }

  // ---- Run match ----
  runBtn.addEventListener("click", async () => {
    const np = numPlayers();
    const picked = agentIds.slice(0, np);
    if (picked.some((a) => !a)) return;

    for (let i = 0; i < np; i++) {
      if (!planets.some((p) => p.owner === i)) {
        statusEl.textContent = `P${i + 1} needs at least one home planet (set owner in planet panel)`;
        return;
      }
    }

    matchState = { kind: "running" };
    updateRunState();
    runBtn.textContent = "Running…";
    statusEl.textContent = "";
    hidePropPanel();

    try {
      const resp = await api.runPlayground({
        planets: planets.map((p) => ({
          x: Number(p.x.toFixed(2)),
          y: Number(p.y.toFixed(2)),
          radius: p.radius,
          ships: p.ships,
          production: p.production,
          owner: p.owner,
        })),
        agent_ids: picked,
        format,
      });

      matchState = { kind: "done" };
      runBtn.textContent = "Run Match";
      statusEl.textContent = "";

      replayInner.innerHTML = "";
      activeReplay = mountEmbeddedReplay(replayInner);
      activeReplay.playLocal(resp.run_id, resp.match_id);
      showReplay();
    } catch (err) {
      matchState = { kind: "error", msg: (err as Error).message };
      runBtn.textContent = "Run Match";
      statusEl.textContent = `Error: ${(err as Error).message}`;
    }
    updateRunState();
  });

  // ---- Init ----
  try {
    agents = await api.listAgents();
    const available = agents.filter((a) => !a.disabled);
    if (available.length >= 1) agentIds[0] = available[0].id;
    if (available.length >= 2) agentIds[1] = available[1].id;
    if (available.length >= 3) agentIds[2] = available[2].id;
    if (available.length >= 4) agentIds[3] = available[3].id;
    renderAgentRow();
  } catch (err) {
    agentRow.innerHTML = `<span class="pg-status">Failed to load agents: ${(err as Error).message}</span>`;
    console.error("Failed to load agents:", err);
  }

  // Load environments in background - don't block initialization
  loadEnvironments().catch((err) => {
    console.error("Failed to load environments:", err);
  });

  resizeCanvas();
  updateRunState();
}

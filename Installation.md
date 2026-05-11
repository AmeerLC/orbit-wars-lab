# Orbit Wars Lab - Installation Guide

Local tournament runner + visualizer for the [Orbit Wars Kaggle competition](https://www.kaggle.com/competitions/orbit-wars).

## Prerequisites

Before starting, verify you have the required tools:

```bash
python3.12 --version    # Should be 3.12 or higher
node --version          # Node.js installed
npm --version           # npm installed
```

### Install pnpm (Node package manager)

If you don't have `pnpm` installed globally:

```bash
npm install -g pnpm
```

---

## Installation Steps

### 1. Navigate to the project directory

```bash
cd /home/ameer/Kaggle/orbit-wars/orbit-wars-lab
```

### 2. Create and activate Python virtual environment

```bash
python3.12 -m venv .venv
source .venv/bin/activate
```

On Windows, use:
```bash
python3.12 -m venv .venv
.venv\Scripts\activate
```

### 3. Upgrade pip

```bash
pip install --upgrade pip
```

### 4. Install Python dependencies

Choose one of the following based on your needs:

#### **Option A: Core installation (minimal)**
```bash
pip install -e .
```

#### **Option B: With RL agent support (includes PyTorch CPU)**
```bash
pip install --extra-index-url https://download.pytorch.org/whl/cpu -e ".[rl]"
```

#### **Option C: With dev tools (testing, linting)**
```bash
pip install -e ".[dev]"
```

#### **Option D: Complete setup (recommended)**
```bash
pip install --extra-index-url https://download.pytorch.org/whl/cpu -e ".[rl,dev]"
```

### 5. Install Node.js dependencies

```bash
pnpm install
```

### 6. Verify installation

```bash
orbit-wars-tournament --help
```

This should display the CLI tool help text without errors.

---

## Running the Application

Make sure your virtual environment is activated:
```bash
source .venv/bin/activate
```

### Option 1: Run both backend + frontend together (recommended)

```bash
bash scripts/dev.sh
```

This starts:
- **Backend (FastAPI):** http://127.0.0.1:8000
- **Frontend (Vite):** http://127.0.0.1:6001

Open http://localhost:6001 in your browser.

### Option 2: Run backend only (port 8000)

```bash
uvicorn orbit_wars_app.main:app --host 127.0.0.1 --port 8000 --reload
```

### Option 3: Run frontend only (port 6001)

```bash
pnpm --filter @orbit-wars-lab/viewer dev --port 6001 --strictPort
```

---

## Quick Start Command

Copy and paste this entire sequence to set up from scratch:

```bash
cd /home/ameer/Kaggle/orbit-wars/orbit-wars-lab

# Create and activate venv
python3.12 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install --upgrade pip
pip install --extra-index-url https://download.pytorch.org/whl/cpu -e ".[rl,dev]"
pnpm install

# Start the app
bash scripts/dev.sh
```

---

## Using Make (alternative)

The Makefile has convenient shortcuts:

```bash
make setup           # Create .venv + install all deps
make dev             # Run backend + viewer together
make backend         # Run FastAPI only
make viewer          # Run Vite only
make test            # Run pytest suite
make lint            # Run ruff linter
make clean           # Remove .venv + build artifacts
```

---

## Project Structure

```
orbit_wars_app/      FastAPI backend (Python 3.12)
viewer/              Vite + TypeScript frontend
web/core/            Vendored Kaggle replay player
agents/
  baselines/         Reference agents (built-in)
  external/          Curated public agents (built-in)
  mine/              Your custom agents go here
runs/
  trueskill.json     TrueSkill leaderboard (persistent)
  <date-id>/         Tournament results
```

---

## What You Get

- **11 pre-configured agents** ready to play against
- **Tournament runner** (round-robin or gauntlet modes)
- **Replay viewer** with live stats sidebar
- **TrueSkill leaderboard** (persistent across sessions)
- **Agent zoo** with filtering and selection UI
- **Kaggle integration** (optional - paste your API token in Settings)

---

## Adding Your Own Agent

1. Copy a template agent:
   ```bash
   cp -r agents/baselines/starter agents/mine/my-bot-v1
   ```

2. Edit `agents/mine/my-bot-v1/main.py` and replace the `agent()` function body

3. Refresh the browser - your agent appears in **Quick Match → Picker → mine**

4. Benchmark with a gauntlet tournament:
   ```bash
   python -m orbit_wars_app.tournament gauntlet mine/my-bot-v1 --games-per-pair 10
   ```

---

## Troubleshooting

### Port already in use?

Set a different port:
```bash
PORT=7001 bash scripts/dev.sh
```

### "Python 3.12 not found"

Check available versions:
```bash
python3 --version
python --version
```

If only 3.11 or lower is available, install Python 3.12 from [python.org](https://www.python.org/downloads/)

### Module not found errors?

Ensure venv is activated:
```bash
source .venv/bin/activate
```

Then reinstall:
```bash
pip install --upgrade pip
pip install --extra-index-url https://download.pytorch.org/whl/cpu -e ".[rl,dev]"
```

---

## Deactivating the virtual environment

When finished, deactivate the venv:

```bash
deactivate
```

To reactivate later, just run:
```bash
source .venv/bin/activate
```

---

## For more information

- [Official README](README.md)
- [Orbit Wars Competition](https://www.kaggle.com/competitions/orbit-wars)
- [GitHub Repository](https://github.com/automatylicza/orbit-wars-lab)

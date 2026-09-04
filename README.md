# Pattern Machine

An educational app for BE students to map their own bad habit loops
(procrastination, doomscrolling, revenge bedtime procrastination, impulse
spending, ghosted group chats…) into structured IF/UNLESS/THEN rules, test
those rules against real and AI-discovered scenarios with a deterministic
engine, and — the deepest layer — spawn a real multi-agent Python backend
that discovers and acts on the pattern with genuinely concurrent, real
agents (LLM calls, real web search, real local computation), some of which
can run on a real recurring schedule.

## Two parts, deployed separately

| Part | What it is | Where it runs |
|---|---|---|
| **Frontend** (`src/`) | Vite + TypeScript app: the engine, the coach, pattern discovery, the simulator, the Team/Schedule UI | Any static host — **Vercel** |
| **Backend** (`backend/`) | FastAPI + asyncio + APScheduler: the real 25-agent roster, orchestration, and real recurring scheduling | An **always-on** host (Render/Railway/Fly) — never Vercel, see why below |

The frontend works fully on its own (engine, coach, discovery, simulator) —
the backend is only needed for the "spawn a real team" / "schedule an agent"
features on the Decode screen. Without it, those screens show exactly that
and how to start it.

## Run everything locally

```bash
# Frontend
npm install
npm run dev              # http://localhost:5173

# Backend (separate terminal)
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8787
```

## Deploy for real

### Frontend → Vercel

1. Import this repo into Vercel. `vercel.json` at the repo root already sets
   the build command, output directory, and SPA rewrite — no extra config
   needed for the frontend itself.
2. If you're also deploying the backend (see below), add an environment
   variable in the Vercel project: `VITE_BACKEND_URL` = your backend's live
   URL (e.g. `https://pattern-machine-backend.onrender.com`). Without it,
   the deployed frontend still works fully, but the Team/Schedule screens
   will look for a backend at `127.0.0.1:8787` (i.e. only work for a visitor
   who's also running the backend on their own machine).
3. Everything else (Mistral key, model choice, all saved progress) already
   lives in the visitor's own browser `localStorage` — nothing server-side
   to configure for the core app.

### Backend → Render (or Railway / Fly.io)

This **cannot** be a Vercel serverless function: APScheduler needs a real,
persistent process to keep background jobs firing on their interval, and
serverless functions are stateless and short-lived between invocations — a
scheduler thread living in memory there would just die. See
`backend/README.md` for the full walkthrough; short version:

1. New Web Service on Render, root directory `backend/`.
2. Build: `pip install -r requirements.txt`. Start:
   `uvicorn main:app --host 0.0.0.0 --port $PORT`.
3. Set `ALLOWED_ORIGINS` to your Vercel URL (comma-separated if more than
   one) — CORS only opens for localhost plus whatever's listed here.
4. Point the frontend's `VITE_BACKEND_URL` at this service and redeploy.

The backend never stores your Mistral key on disk in either environment —
it travels once per request from the browser, and for a *scheduled* job it
sits only in that process's memory (a restart clears it; the job definition
survives and asks you to resupply the key).

## Testing

```bash
npx tsc --noEmit     # typecheck
npx vitest run       # 30 unit tests on the deterministic engine
npm run build        # production build
```

Backend has no separate test suite yet; verify by hand with `curl` against
`/health`, `/roster`, `/orchestrate`, and `/schedule` — see
`backend/README.md`.

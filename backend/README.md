# Pattern Machine — agent backend

A real, independently-running Python service. Unlike every other AI feature
in this app (which calls Mistral directly from the browser), this is a
genuine server process — it exists specifically to run actual concurrent
sub-agent execution and real background scheduling, neither of which a
browser tab can do on its own.

## What it actually does

**25 real agents across 8 student-life categories** (Academics, Focus, Body,
Money, Sleep, Teamwork, Data, Media — see `agents/roster/`), each one of:

- A real, distinct LLM call to Mistral (its own system prompt, its own job).
- A real local computation with **no LLM call at all** — actual `pandas`
  analysis on your logged history, actual `scikit-learn` TF-IDF retrieval
  over your notes, actual sandboxed `subprocess` execution of pasted Python
  (real traceback, not a guess), actual `datetime` countdown/checkpoint math.
- A real, current web search via Mistral's Conversations API + `web_search`
  tool (News-Digest, Podcast-Recap) — genuinely current results, not
  training-data improvisation.

`POST /orchestrate` with a pattern description and your own Mistral key:

1. **The orchestrator** makes one real Mistral call to decide which 2–5 of
   the 25 agents (grouped by category in the planner prompt) are worth
   spawning for this specific pattern — it can and does mix categories.
2. Those agents then run **genuinely concurrently** via `asyncio.gather` —
   independent coroutines (LLM calls, a real web search, and real local
   computation, freely mixed), running in parallel, not one combined prompt
   pretending to be several agents. You can see this in the response: each
   sub-agent's `duration_ms` overlaps with the others rather than summing.

`GET /roster` returns the full live catalogue (grouped by category) so the
frontend never hardcodes a roster that can drift from what actually runs.

**Real recurring scheduling** (`POST /schedule`, `GET /schedule`,
`POST /schedule/{id}/resume`, `DELETE /schedule/{id}`) — via APScheduler, a
real Python job scheduler running in this process. Create a job (pick an
agent, an interval, and what context to give it each run) and it keeps
firing on that real interval independent of any open browser tab — e.g. a
News-Digest agent every 4 hours as a substitute for opening Instagram, or a
Podcast-Recap once a day. Job *definitions* persist to `schedules.json` so
the list survives a restart; your Mistral key is held **only in this
process's memory**, never written to disk — a restarted job comes back
`needs_key: true` until you resupply it via `/resume`.

No other state is kept. Your Mistral API key is never stored beyond that one
in-memory scheduling case — it travels once, per request, from the browser
to this process to Mistral, exactly like the rest of the app's "your key,
never ours" model.

## Run it locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8787
```

Then open the app (`npm run dev` in the project root) — the Decode screen
has a "spawn a real multi-agent team" link that calls this service. If it's
not running, the app tells you exactly that and shows this same command.

## Verify it's alive

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","agent_count":25,"categories":{"Academics":[...],...}}

curl http://127.0.0.1:8787/roster
# full catalogue: {"categories": {"Academics": [{"key":"deadline-planner","name":"...","role":"..."}, ...]}}
```

## Deploy it for real (not just your own machine)

This process must **stay alive** to keep APScheduler's background jobs
firing on their real interval, so it needs an always-on host — **not
Vercel**. Vercel's functions are stateless and short-lived (a fresh
invocation per request, no persistent process between them), so a scheduler
thread running in memory would simply die between requests there. That's
also true of most "serverless" platforms — this specifically needs a real
long-lived process, which is what makes the scheduling feature genuine.

**Render** (or Railway / Fly.io — same idea, pick whichever's free tier you
prefer) gives you that:

1. Push this repo to GitHub.
2. New Web Service on Render, root directory `backend/`.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add an environment variable `ALLOWED_ORIGINS` set to your deployed
   frontend's URL (e.g. `https://your-app.vercel.app`) — CORS is locked to
   localhost plus whatever origins you list here, comma-separated for more
   than one.
6. Once it's live, set `VITE_BACKEND_URL` in your Vercel project's
   environment variables to this Render service's URL, and redeploy the
   frontend — see the root README for the frontend half of this.

Nothing about the backend code changes between local and deployed use —
same FastAPI app, same real agents, same real scheduler; only where it runs
and which origins may call it change.

## Why this exists as a separate service instead of another browser-side call

Everything else in this app runs entirely in the browser by design — no
backend, no deploy step, works from a static file. That's a deliberate
constraint that holds for narration, critique, pattern extraction, and web
search. It stops holding for **genuinely concurrent, independently-running
agent processes** and **real background scheduling**: a browser tab has no
persistent process and dies the moment it's closed, so "spawn sub-agents
that actually run" and "keep checking the news for me every few hours" both
need somewhere that isn't the tab. This service is that somewhere — plain
FastAPI + `asyncio` + APScheduler, nothing exotic, runs on your own machine
(or a real host) with your own key.

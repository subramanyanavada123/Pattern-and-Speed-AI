# Pattern Machine — agent backend

A real, independently-running Python service. Unlike every other AI feature
in this app (which calls Mistral directly from the browser), this is a
genuine server process — it exists specifically to run actual concurrent
sub-agent execution, which a browser tab cannot do on its own.

## What it actually does

`POST /orchestrate` with a pattern description and your own Mistral key:

1. **The orchestrator** makes one real Mistral call to decide which 2–4
   specialist sub-agents (Task, Wellness, Learning-Track, Environment) are
   worth spawning for this specific pattern.
2. Those sub-agents then run **genuinely concurrently** via
   `asyncio.gather` — independent coroutines, independent HTTP requests to
   Mistral, running in parallel, not one combined prompt pretending to be
   several agents. You can see this in the response: each sub-agent's
   `duration_ms` overlaps with the others rather than summing.

No state is kept between requests. Your Mistral API key is never stored —
it travels once, per request, from the browser to this process to Mistral,
exactly like the rest of the app's "your key, never ours" model.

## Run it

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
# {"status":"ok","available_roles":["task","wellness","learning","environment"]}
```

## Why this exists as a separate service instead of another browser-side call

Everything else in this app runs entirely in the browser by design — no
backend, no deploy step, works from a static file. That's a deliberate
constraint that holds for narration, critique, pattern extraction, and web
search. It stops holding for **genuinely concurrent, independently-running
agent processes**: a browser tab has no persistent process and dies the
moment it's closed, so "spawn sub-agents that actually run" needs somewhere
that isn't the tab. This service is that somewhere — plain FastAPI +
`asyncio`, nothing exotic, runs on your own machine with your own key.

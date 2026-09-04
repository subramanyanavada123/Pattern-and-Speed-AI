"""
Pattern Machine backend — a real, independently-running agent service.

This is genuinely separate from the browser app: a FastAPI process that
holds no state between requests and no stored API key. The frontend sends
the user's own BYO Mistral key with each request (same "your key, never
ours" model the browser-only version already used); this service exists to
run REAL concurrent sub-agent processes, which a browser tab cannot do on
its own (it dies when the tab closes; asyncio.gather here runs independent
coroutines that a JS single-threaded event loop in a page cannot equal for
genuinely parallel outbound calls with independent lifecycles).

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8787

Deploy for real (not just localhost):
    This process must stay alive to keep APScheduler's real background jobs
    firing, so it needs an always-on host, not a serverless one — Vercel
    cannot run this (its functions are stateless and short-lived; a
    persistent in-process scheduler thread would just die between
    invocations). Render, Railway, and Fly.io all support a real long-lived
    Python process on a real free/cheap tier. See backend/README.md.

    Set ALLOWED_ORIGINS to your deployed frontend's origin(s), comma-separated:
        ALLOWED_ORIGINS=https://your-app.vercel.app uvicorn main:app --host 0.0.0.0 --port $PORT
"""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from agents.orchestrator import orchestrate
from agents.roster import ALL_AGENTS, CATEGORIES
from scheduler import store as schedule_store
from commitments import store as commitment_store

app = FastAPI(title="Pattern Machine Agent Backend", version="0.1.0")

# The Vite dev server runs on localhost:5173 by default; allow it (and the
# common alternate ports Vite falls back to) plus whatever real deployed
# frontend origin(s) are named in ALLOWED_ORIGINS (comma-separated — e.g.
# your Vercel URL) so a deployed frontend can call a deployed backend too.
# No credentials are needed since the API key travels in the request body,
# not a cookie.
_extra_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:5175", "http://127.0.0.1:5175",
        *_extra_origins,
    ],
    allow_methods=["POST", "GET", "DELETE"],
    allow_headers=["Content-Type"],
)


class OrchestrateRequest(BaseModel):
    pattern_description: str = Field(..., min_length=8, max_length=2000)
    mistral_api_key: str = Field(..., min_length=10)
    model: str = Field(default="mistral-small-latest")


class SubAgentResponse(BaseModel):
    agent_name: str
    role: str
    output: str
    duration_ms: int
    error: str | None = None


class OrchestrateResponse(BaseModel):
    plan_reasoning: str
    plan_error: str | None
    selected_roles: list[str]
    role_categories: dict[str, str]
    sub_agents: list[SubAgentResponse]
    total_duration_ms: int


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "agent_count": len(ALL_AGENTS),
        "categories": {category: list(agents.keys()) for category, agents in CATEGORIES.items()},
    }


@app.get("/roster")
async def roster() -> dict:
    """The full real roster with human-readable roles, grouped by category —
    lets the frontend render a live picker instead of a hardcoded list."""
    return {
        "categories": {
            category: [{"key": key, "name": agent.name, "role": agent.role} for key, agent in agents.items()]
            for category, agents in CATEGORIES.items()
        }
    }


@app.post("/orchestrate", response_model=OrchestrateResponse)
async def orchestrate_pattern(req: OrchestrateRequest) -> OrchestrateResponse:
    """
    The real endpoint: takes a pattern description and the caller's own
    Mistral key, runs a real orchestrator-worker agent flow (one planning
    call + N genuinely concurrent sub-agent calls), and returns every
    sub-agent's actual, independent output.
    """
    try:
        result = await orchestrate(
            api_key=req.mistral_api_key,
            model=req.model,
            pattern_description=req.pattern_description,
        )
    except Exception as exc:  # noqa: BLE001 - this endpoint must never 500 opaquely
        raise HTTPException(status_code=502, detail=f"Orchestration failed: {exc}") from exc

    return OrchestrateResponse(
        plan_reasoning=result.plan_reasoning,
        plan_error=result.plan_error,
        selected_roles=result.selected_roles,
        role_categories=result.role_categories or {},
        sub_agents=[
            SubAgentResponse(
                agent_name=r.agent_name, role=r.role, output=r.output,
                duration_ms=r.duration_ms, error=r.error,
            )
            for r in result.sub_agent_results
        ],
        total_duration_ms=result.total_duration_ms,
    )


# ---- Real background scheduling (APScheduler) ----
#
# Job DEFINITIONS persist to schedules.json (role, interval, label, context);
# the Mistral API key is held ONLY in memory per job and is never written to
# disk. After a backend restart, a reloaded job comes back with needs_key:
# true until the frontend calls /schedule/{id}/resume with the key again.


class CreateScheduleRequest(BaseModel):
    role: str = Field(..., description="A roster agent key, e.g. 'news-digest'")
    label: str = Field(..., min_length=1, max_length=120)
    interval_minutes: int = Field(..., ge=5, le=10080, description="How often to actually re-run this agent, in real minutes")
    context: str = Field(default="", max_length=2000, description="What to pass the agent each run, e.g. your interest area")
    mistral_api_key: str = Field(..., min_length=10)
    model: str = Field(default="mistral-small-latest")


class ResumeScheduleRequest(BaseModel):
    mistral_api_key: str = Field(..., min_length=10)


class ScheduledJobResponse(BaseModel):
    id: str
    role: str
    role_name: str
    category: str
    label: str
    interval_minutes: int
    context: str
    created_at: float
    last_run_at: float | None
    last_output: str | None
    last_error: str | None
    needs_key: bool


def _job_to_response(job) -> ScheduledJobResponse:
    agent = ALL_AGENTS.get(job.role)
    return ScheduledJobResponse(
        id=job.id, role=job.role, role_name=agent.name if agent else job.role,
        category=job.category(), label=job.label, interval_minutes=job.interval_minutes,
        context=job.context, created_at=job.created_at, last_run_at=job.last_run_at,
        last_output=job.last_output, last_error=job.last_error, needs_key=job.needs_key,
    )


@app.post("/schedule", response_model=ScheduledJobResponse)
async def create_schedule(req: CreateScheduleRequest) -> ScheduledJobResponse:
    """Creates a REAL recurring job: APScheduler actually re-runs the chosen
    agent every interval_minutes in this process, independent of any open
    browser tab. Runs once immediately so you see a real result right away."""
    try:
        job = schedule_store.create(
            role=req.role, label=req.label, interval_minutes=req.interval_minutes,
            context=req.context, model=req.model, api_key=req.mistral_api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _job_to_response(job)


@app.get("/schedule")
async def list_schedules() -> dict:
    return {"jobs": [_job_to_response(j) for j in schedule_store.list()]}


@app.post("/schedule/{job_id}/resume", response_model=ScheduledJobResponse)
async def resume_schedule(job_id: str, req: ResumeScheduleRequest) -> ScheduledJobResponse:
    """After a backend restart, a schedule's definition survives but its key
    doesn't (never persisted) — call this once to resupply it and pick the
    real interval back up."""
    try:
        job = schedule_store.resume(job_id, req.mistral_api_key)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such scheduled job.")
    return _job_to_response(job)


@app.delete("/schedule/{job_id}")
async def delete_schedule(job_id: str) -> dict:
    schedule_store.delete(job_id)
    return {"status": "deleted", "id": job_id}


# ---- Real commitments: a one-shot real deadline for a spawned agent's
# concrete suggestion (see commitments.py for why this is a separate,
# simpler mechanism than the recurring /schedule jobs above — no LLM call
# on fire, just a real countdown and an honest self-report).


class CreateCommitmentRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    source_agent_name: str = Field(..., min_length=1, max_length=120)
    category: str = Field(default="")
    due_minutes: int = Field(..., ge=1, le=1440)


class ResolveCommitmentRequest(BaseModel):
    status: str = Field(..., pattern="^(done|skipped)$")


class CommitmentResponse(BaseModel):
    id: str
    text: str
    source_agent_name: str
    category: str
    due_minutes: int
    created_at: float
    due_at: float
    fired: bool
    status: str
    resolved_at: float | None


def _commitment_to_response(c) -> CommitmentResponse:
    return CommitmentResponse(
        id=c.id, text=c.text, source_agent_name=c.source_agent_name, category=c.category,
        due_minutes=c.due_minutes, created_at=c.created_at, due_at=c.due_at,
        fired=c.fired, status=c.status, resolved_at=c.resolved_at,
    )


@app.post("/commitment", response_model=CommitmentResponse)
async def create_commitment(req: CreateCommitmentRequest) -> CommitmentResponse:
    """Starts a REAL countdown (APScheduler `date` trigger, server-side —
    survives a closed tab) for a concrete action a spawned agent suggested.
    No LLM call happens when it fires; this backend can't observe whether
    you actually did a workout, so completion is an honest self-report via
    POST /commitment/{id}/resolve."""
    try:
        c = commitment_store.create(
            text=req.text, source_agent_name=req.source_agent_name,
            category=req.category, due_minutes=req.due_minutes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _commitment_to_response(c)


@app.get("/commitment")
async def list_commitments() -> dict:
    return {"commitments": [_commitment_to_response(c) for c in commitment_store.list()]}


@app.post("/commitment/{commitment_id}/resolve", response_model=CommitmentResponse)
async def resolve_commitment(commitment_id: str, req: ResolveCommitmentRequest) -> CommitmentResponse:
    try:
        c = commitment_store.resolve(commitment_id, req.status)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such commitment.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _commitment_to_response(c)


@app.delete("/commitment/{commitment_id}")
async def delete_commitment(commitment_id: str) -> dict:
    commitment_store.delete(commitment_id)
    return {"status": "deleted", "id": commitment_id}

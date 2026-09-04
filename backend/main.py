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
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from agents.orchestrator import AVAILABLE_ROLES, orchestrate

app = FastAPI(title="Pattern Machine Agent Backend", version="0.1.0")

# The Vite dev server runs on localhost:5173 by default; allow it (and the
# common alternate ports Vite falls back to) to call this API directly from
# the browser. No credentials are needed since the API key travels in the
# request body, not a cookie.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:5175", "http://127.0.0.1:5175",
    ],
    allow_methods=["POST", "GET"],
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
    sub_agents: list[SubAgentResponse]
    total_duration_ms: int


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "available_roles": list(AVAILABLE_ROLES.keys())}


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
        sub_agents=[
            SubAgentResponse(
                agent_name=r.agent_name, role=r.role, output=r.output,
                duration_ms=r.duration_ms, error=r.error,
            )
            for r in result.sub_agent_results
        ],
        total_duration_ms=result.total_duration_ms,
    )

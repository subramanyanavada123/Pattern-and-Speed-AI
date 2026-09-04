"""
Real background job scheduling via APScheduler — genuine interval-based
execution in this process's own thread pool, not a simulated countdown
in the browser tab (which dies the moment the tab closes).

Two things are kept deliberately separate:
  - Job DEFINITIONS (role, interval, label, optional context) persist to
    schedules.json on disk, so the schedule list survives a backend restart.
  - The Mistral API KEY is held ONLY in memory, per job id, and is NEVER
    written to schedules.json or anywhere else on disk — consistent with
    the BYO-key-per-request model the rest of this backend already uses.
    After a restart, a job's definition reloads but is marked "needs_key"
    until the frontend resupplies the key (POST /schedule/{id}/resume) —
    it will not silently run without one, and it will not silently store
    one either.

Each job re-runs exactly ONE roster agent (not the full multi-agent
orchestration) on its interval, and keeps only the latest result in memory,
retrievable via GET /schedule. This is intentionally simple: real recurring
execution of a real agent, with a real result you can check — not a queue,
not history, just "is my news digest fresh right now".
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx
from apscheduler.schedulers.background import BackgroundScheduler

from agents.roster import ALL_AGENTS, ROLE_CATEGORY

SCHEDULES_FILE = Path(__file__).parent / "schedules.json"


@dataclass
class ScheduledJob:
    id: str
    role: str
    label: str
    interval_minutes: int
    context: str
    model: str = "mistral-small-latest"
    created_at: float = field(default_factory=time.time)
    # Not persisted (see module docstring) — tracked only in the in-memory
    # sibling dict `_job_keys`, never written into to_persisted_dict().
    last_run_at: Optional[float] = None
    last_output: Optional[str] = None
    last_error: Optional[str] = None
    needs_key: bool = True

    def to_persisted_dict(self) -> dict:
        """Everything except the API key — this is what hits disk."""
        d = asdict(self)
        return d

    def category(self) -> str:
        return ROLE_CATEGORY.get(self.role, "")


class JobStore:
    """Owns the on-disk job-definition file, the in-memory key map, and the
    real APScheduler instance actually firing these jobs on real intervals."""

    def __init__(self) -> None:
        self._jobs: dict[str, ScheduledJob] = {}
        self._keys: dict[str, str] = {}  # job id -> Mistral API key, memory-only
        self._scheduler = BackgroundScheduler()
        self._scheduler.start()
        self._load()

    # ---- persistence (definitions only, never keys) ----

    def _load(self) -> None:
        if not SCHEDULES_FILE.exists():
            return
        try:
            raw = json.loads(SCHEDULES_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return
        for entry in raw.get("jobs", []):
            try:
                job = ScheduledJob(**entry)
            except TypeError:
                continue  # skip malformed/outdated entries rather than crash startup
            job.needs_key = True  # a reload never carries a key forward
            self._jobs[job.id] = job
            # Registered but won't actually fire until resume() supplies a key
            # (see _run_job's needs_key guard below).
            self._register_apscheduler_job(job)

    def _persist(self) -> None:
        SCHEDULES_FILE.write_text(json.dumps({"jobs": [j.to_persisted_dict() for j in self._jobs.values()]}, indent=2))

    # ---- the actual scheduled execution ----

    def _register_apscheduler_job(self, job: ScheduledJob) -> None:
        self._scheduler.add_job(
            self._run_job,
            "interval",
            minutes=job.interval_minutes,
            args=[job.id],
            id=job.id,
            replace_existing=True,
            next_run_time=None,  # don't fire until a key is present; resume() triggers the first run
        )

    def _run_job(self, job_id: str) -> None:
        """Runs synchronously inside APScheduler's own worker thread — this
        really executes on a timer independent of any browser tab or HTTP
        request being open. BackgroundScheduler's workers are plain threads
        with no event loop of their own, so asyncio.run() here is the
        correct, simple way to drive the Runnable's async run() to
        completion — one fresh loop, created and torn down together with the
        AsyncClient inside it, no cross-loop reuse."""
        job = self._jobs.get(job_id)
        api_key = self._keys.get(job_id)
        if job is None or api_key is None:
            return

        agent = ALL_AGENTS.get(job.role)
        if agent is None:
            job.last_error = f"Unknown role '{job.role}' (roster may have changed)."
            return

        async def _do_run():
            async with httpx.AsyncClient(timeout=30.0) as client:
                return await agent.run(client, api_key, job.context or job.label)

        started = time.time()
        try:
            result = asyncio.run(_do_run())
            job.last_output = result.output
            job.last_error = result.error
        except Exception as exc:  # noqa: BLE001 - a scheduled run failing must not kill the scheduler thread
            job.last_error = f"{type(exc).__name__}: {exc}"
        job.last_run_at = started

    # ---- public API used by main.py ----

    def create(self, role: str, label: str, interval_minutes: int, context: str, model: str, api_key: str) -> ScheduledJob:
        if role not in ALL_AGENTS:
            raise ValueError(f"Unknown role '{role}'")
        if interval_minutes < 5:
            raise ValueError("interval_minutes must be at least 5 (this runs real API calls on a real timer)")

        job = ScheduledJob(
            id=uuid.uuid4().hex[:12],
            role=role,
            label=label,
            interval_minutes=interval_minutes,
            context=context,
            model=model,
            needs_key=False,
        )
        self._jobs[job.id] = job
        self._keys[job.id] = api_key
        self._register_apscheduler_job(job)
        self._persist()

        # Fire once immediately so the user sees a real result right away
        # instead of waiting a full interval, then let APScheduler take over
        # on the regular cadence from here. This create() call itself runs
        # on FastAPI's event loop thread, so _run_job (which does its own
        # asyncio.run()) must be handed to a plain worker thread here rather
        # than called inline — asyncio.run() refuses to nest inside an
        # already-running loop.
        self._scheduler.add_job(self._run_job, args=[job.id], id=f"{job.id}-immediate")
        self._scheduler.modify_job(job.id, next_run_time=datetime.now() + timedelta(minutes=interval_minutes))
        return job

    def resume(self, job_id: str, api_key: str) -> ScheduledJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        self._keys[job_id] = api_key
        job.needs_key = False
        self._scheduler.modify_job(job_id, next_run_time=datetime.now() + timedelta(seconds=1))
        return job

    def list(self) -> list[ScheduledJob]:
        return list(self._jobs.values())

    def delete(self, job_id: str) -> None:
        if job_id in self._jobs:
            try:
                self._scheduler.remove_job(job_id)
            except Exception:  # noqa: BLE001 - job may already be gone from the live scheduler
                pass
            del self._jobs[job_id]
            self._keys.pop(job_id, None)
            self._persist()

    def shutdown(self) -> None:
        self._scheduler.shutdown(wait=False)


# Module-level singleton — one real scheduler per backend process, exactly
# like the rest of this service (no external job queue needed for a
# single-user local tool).
store = JobStore()

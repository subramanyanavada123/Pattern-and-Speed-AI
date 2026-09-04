"""
Real commitments: a one-shot real deadline (via APScheduler's `date`
trigger, not `interval`) for a concrete action a spawned agent suggested —
"do the 5-minute circuit before lectures". This is deliberately NOT another
recurring agent job (see scheduler.py): there's no LLM call to make when it
fires, because the one thing this backend genuinely cannot do is observe
whether you did a workout. What IS real here:

  - A real countdown, tracked server-side (survives a closed tab, unlike a
    setTimeout in the browser).
  - A real fired-at timestamp when the deadline passes.
  - The self-report (done/skipped) is honestly left to the user — this
    never fabricates a "yes you did it" signal.

No Mistral key involved at all — this is pure scheduling, no agent re-run.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler

COMMITMENTS_FILE = Path(__file__).parent / "commitments.json"


@dataclass
class Commitment:
    id: str
    text: str  # the real spawned agent's actual suggested action
    source_agent_name: str
    category: str
    due_minutes: int
    created_at: float = field(default_factory=time.time)
    due_at: float = 0.0
    fired: bool = False  # true once the real deadline has actually passed
    status: str = "pending"  # pending | done | skipped
    resolved_at: Optional[float] = None

    def __post_init__(self) -> None:
        if not self.due_at:
            self.due_at = self.created_at + self.due_minutes * 60


class CommitmentStore:
    def __init__(self) -> None:
        self._items: dict[str, Commitment] = {}
        self._scheduler = BackgroundScheduler()
        self._scheduler.start()
        self._load()

    def _load(self) -> None:
        if not COMMITMENTS_FILE.exists():
            return
        try:
            raw = json.loads(COMMITMENTS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return
        for entry in raw.get("commitments", []):
            try:
                c = Commitment(**entry)
            except TypeError:
                continue
            self._items[c.id] = c
            if not c.fired and c.due_at > time.time():
                self._schedule_fire(c)
            elif not c.fired:
                c.fired = True  # deadline already passed while backend was down — real, not backdated

    def _persist(self) -> None:
        COMMITMENTS_FILE.write_text(json.dumps({"commitments": [asdict(c) for c in self._items.values()]}, indent=2))

    def _schedule_fire(self, c: Commitment) -> None:
        self._scheduler.add_job(
            self._mark_fired,
            "date",
            run_date=datetime.fromtimestamp(c.due_at),
            args=[c.id],
            id=f"commitment-{c.id}",
            replace_existing=True,
        )

    def _mark_fired(self, commitment_id: str) -> None:
        c = self._items.get(commitment_id)
        if c is None:
            return
        c.fired = True
        self._persist()

    def create(self, text: str, source_agent_name: str, category: str, due_minutes: int) -> Commitment:
        if due_minutes < 1 or due_minutes > 1440:
            raise ValueError("due_minutes must be between 1 and 1440 (24 hours)")
        c = Commitment(
            id=uuid.uuid4().hex[:12],
            text=text,
            source_agent_name=source_agent_name,
            category=category,
            due_minutes=due_minutes,
        )
        self._items[c.id] = c
        self._schedule_fire(c)
        self._persist()
        return c

    def resolve(self, commitment_id: str, status: str) -> Commitment:
        if status not in ("done", "skipped"):
            raise ValueError("status must be 'done' or 'skipped'")
        c = self._items.get(commitment_id)
        if c is None:
            raise KeyError(commitment_id)
        c.status = status
        c.resolved_at = time.time()
        self._persist()
        return c

    def list(self) -> list[Commitment]:
        # Real time check on every read, not just at fire time — a deadline
        # that's passed is "fired" even if the scheduler thread hasn't
        # ticked yet at the exact millisecond someone happens to poll.
        now = time.time()
        for c in self._items.values():
            if not c.fired and c.due_at <= now:
                c.fired = True
        return list(self._items.values())

    def delete(self, commitment_id: str) -> None:
        if commitment_id in self._items:
            try:
                self._scheduler.remove_job(f"commitment-{commitment_id}")
            except Exception:  # noqa: BLE001
                pass
            del self._items[commitment_id]
            self._persist()


store = CommitmentStore()

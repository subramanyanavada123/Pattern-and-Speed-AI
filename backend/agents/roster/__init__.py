"""
Roster: the full, real agent catalogue, grouped by student-life category so
the planner prompt can reason over categories rather than a flat 20+ item
list. Each category module exports a `<CATEGORY>_AGENTS` dict of real
Runnables (Agent / ComputeAgent / SearchAgent) — see agents/base.py.
"""

from __future__ import annotations

from .academics import ACADEMICS_AGENTS
from .body import BODY_AGENTS
from .data import DATA_AGENTS
from .focus import FOCUS_AGENTS
from .media import MEDIA_AGENTS
from .money import MONEY_AGENTS
from .sleep import SLEEP_AGENTS
from .teamwork import TEAMWORK_AGENTS

# Category label -> dict of {role_key: Runnable}. Order here is the order
# shown to the planner.
CATEGORIES: dict[str, dict[str, object]] = {
    "Academics": ACADEMICS_AGENTS,
    "Focus": FOCUS_AGENTS,
    "Body": BODY_AGENTS,
    "Money": MONEY_AGENTS,
    "Sleep": SLEEP_AGENTS,
    "Teamwork": TEAMWORK_AGENTS,
    "Data (your real history)": DATA_AGENTS,
    "Media (distraction substitutes)": MEDIA_AGENTS,
}

# Flat lookup the orchestrator actually dispatches from — role_key -> Runnable.
# Built from CATEGORIES so there is exactly one source of truth.
ALL_AGENTS: dict[str, object] = {}
for _category_agents in CATEGORIES.values():
    ALL_AGENTS.update(_category_agents)

# role_key -> category label, for surfacing grouping in API responses / UI.
ROLE_CATEGORY: dict[str, str] = {}
for _category, _agents in CATEGORIES.items():
    for _role_key in _agents:
        ROLE_CATEGORY[_role_key] = _category

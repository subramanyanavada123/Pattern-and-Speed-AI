"""
The orchestrator: a real agent that decides which sub-agents a pattern needs,
then actually runs them concurrently (asyncio.gather — genuine parallel
execution, each sub-agent making its own independent unit of real work:
a Mistral call, a real web search, or real local computation).

This follows the orchestrator-worker pattern Anthropic documents for their
own production multi-agent research system: a lead agent forms a plan with
narrow, distinct objectives per worker, spawns the workers, and synthesizes
what comes back. See: https://www.anthropic.com/engineering/multi-agent-research-system

The roster itself lives in agents/roster/ — 25 real agents across 8
student-life categories (Academics, Focus, Body, Money, Sleep, Teamwork,
Data, Media), each either an LLM call with its own distinct system prompt,
a real local computation (pandas/sklearn/subprocess/datetime — no LLM at
all), or a real web-search call. See agents/roster/__init__.py.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, replace

import httpx

from .base import AgentResult, MISTRAL_ENDPOINT, extract_error_detail
from .roster import ALL_AGENTS, CATEGORIES, ROLE_CATEGORY


def _describe_roster_for_planner() -> str:
    """Category-grouped roster description for the planner prompt — this is
    what lets the planner reason sensibly over 25 agents instead of being
    handed one flat comma list, which stops scaling readably past ~8 items."""
    lines = []
    for category, agents in CATEGORIES.items():
        lines.append(f"\n{category}:")
        for key, agent in agents.items():
            lines.append(f'  - "{key}": {agent.role}')
    return "\n".join(lines)


PLANNER_SYSTEM = (
    "You are an orchestrator agent choosing sub-agents for a real multi-agent system. Given a person's "
    "habit-loop pattern description, decide which 2 to 5 of the following specialist sub-agents (grouped "
    "by category) are genuinely relevant to spawn for THIS specific pattern:\n"
    + _describe_roster_for_planner()
    + "\n\nRespond with STRICT JSON only: "
    '{"selected": ["deadline-planner", "pause-prompt"], "reasoning": "one sentence why these and not others"}. '
    "Pick across categories when the pattern genuinely touches more than one (e.g. a late-night-scrolling-"
    "before-a-deadline pattern might need both a Focus agent and an Academics agent) — do not default to "
    "one category. Only pick agents that would add something DISTINCT for this specific pattern, not every "
    "agent that could vaguely apply. Prefer a real ComputeAgent/SearchAgent (marked by roles mentioning "
    "'real' computation/search) over a generic LLM agent when the pattern gives you the concrete input "
    "(a number, a deadline reference, a code block, notes, past log data) that agent needs to do real work."
)


@dataclass
class OrchestrationResult:
    pattern_description: str
    plan_reasoning: str
    selected_roles: list[str]
    sub_agent_results: list[AgentResult]
    total_duration_ms: int
    plan_error: str | None = None
    role_categories: dict[str, str] | None = None


def _fallback_roles() -> list[str]:
    """A small, safe, cross-category default if planning fails outright —
    not the whole 25-agent roster, and not empty."""
    picks = []
    for category_agents in CATEGORIES.values():
        if category_agents:
            picks.append(next(iter(category_agents)))
        if len(picks) >= 3:
            break
    return picks or list(ALL_AGENTS.keys())[:3]


async def _plan(client: httpx.AsyncClient, api_key: str, model: str, pattern_description: str) -> tuple[list[str], str, str | None]:
    """The orchestrator's own real decision — a genuine Mistral call that picks the sub-agent roster."""
    try:
        response = await client.post(
            MISTRAL_ENDPOINT,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": PLANNER_SYSTEM},
                    {"role": "user", "content": f'The pattern: "{pattern_description}"'},
                ],
                "temperature": 0.4,
                "max_tokens": 300,
                "response_format": {"type": "json_object"},
            },
            timeout=30.0,
        )
    except httpx.RequestError as exc:
        return _fallback_roles(), "", f"Planner network error, defaulting to a small cross-category roster: {exc}"

    if response.status_code != 200:
        return _fallback_roles(), "", f"Planner call failed ({response.status_code}: {extract_error_detail(response)}), defaulting to a small cross-category roster."

    try:
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        selected = [r for r in parsed.get("selected", []) if r in ALL_AGENTS]
        reasoning = parsed.get("reasoning", "")
        if not selected:
            return _fallback_roles(), reasoning, "Planner returned no valid roles, defaulting to a small cross-category roster."
        return selected[:5], reasoning, None
    except (KeyError, IndexError, ValueError, json.JSONDecodeError) as exc:
        return _fallback_roles(), "", f"Could not parse planner output ({exc}), defaulting to a small cross-category roster."


def _instantiate(role: str, model: str):
    """Copy a template agent (dataclasses.replace) rather than mutating the
    shared ALL_AGENTS singletons — those are module-level and reused across
    every request, so mutating .model in place would race between concurrent
    requests using different models. Both Agent and SearchAgent carry a
    `model` field; ComputeAgent doesn't (no LLM call at all), so it's used
    as-is — nothing to swap."""
    template = ALL_AGENTS[role]
    return replace(template, model=model) if hasattr(template, "model") else template


async def _run_many(api_key: str, model: str, roles: list[str], context: str) -> tuple[list[AgentResult], int]:
    """The actual concurrency primitive shared by every orchestration mode
    (planned, custom, or a solo run of one): every agent's run() coroutine is
    scheduled at once via asyncio.gather and they execute in parallel — LLM
    calls, a real web search, and real local computation all racing
    together, each independent of the others."""
    start = time.monotonic()
    agents = [_instantiate(role, model) for role in roles]
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(agent.run(client, api_key, context) for agent in agents))
    return list(results), int((time.monotonic() - start) * 1000)


async def orchestrate(api_key: str, model: str, pattern_description: str) -> OrchestrationResult:
    """
    Real AI-planned orchestration: one planning call decides the roster
    (from all 25 real agents across 8 categories), then every selected
    sub-agent runs CONCURRENTLY — genuinely parallel independent work, not
    sequential, not one combined call pretending to be several agents.
    """
    start = time.monotonic()
    async with httpx.AsyncClient() as client:
        selected_roles, reasoning, plan_error = await _plan(client, api_key, model, pattern_description)

    results, _ = await _run_many(api_key, model, selected_roles, pattern_description)
    total_duration_ms = int((time.monotonic() - start) * 1000)
    return OrchestrationResult(
        pattern_description=pattern_description,
        plan_reasoning=reasoning,
        selected_roles=selected_roles,
        sub_agent_results=results,
        total_duration_ms=total_duration_ms,
        plan_error=plan_error,
        role_categories={role: ROLE_CATEGORY.get(role, "") for role in selected_roles},
    )


async def orchestrate_custom(api_key: str, model: str, roles: list[str], context: str) -> OrchestrationResult:
    """
    Real USER-planned orchestration: no planner call at all — the caller IS
    the planner, hand-picking exactly which agents to run. Still genuinely
    concurrent via the same asyncio.gather path as the AI-planned version;
    only the selection step differs.
    """
    unknown = [r for r in roles if r not in ALL_AGENTS]
    if unknown:
        raise ValueError(f"Unknown agent role(s): {', '.join(unknown)}")
    if not roles:
        raise ValueError("Pick at least one agent to run.")
    if len(roles) > 12:
        raise ValueError("Pick at most 12 agents for one run.")

    results, total_duration_ms = await _run_many(api_key, model, roles, context)
    return OrchestrationResult(
        pattern_description=context,
        plan_reasoning="You picked this roster yourself — no planner ran.",
        selected_roles=roles,
        sub_agent_results=results,
        total_duration_ms=total_duration_ms,
        plan_error=None,
        role_categories={role: ROLE_CATEGORY.get(role, "") for role in roles},
    )


async def run_single(api_key: str, model: str, role: str, context: str) -> AgentResult:
    """Runs exactly one named agent on its own — no planner, no other agents.
    The 'individually' half of playing with the roster."""
    if role not in ALL_AGENTS:
        raise ValueError(f"Unknown agent role: {role}")
    agent = _instantiate(role, model)
    async with httpx.AsyncClient() as client:
        return await agent.run(client, api_key, context)

"""
The orchestrator: a real agent that decides which sub-agents a pattern needs,
then actually runs them concurrently (asyncio.gather — genuine parallel
execution, each sub-agent making its own independent Mistral call).

This follows the orchestrator-worker pattern Anthropic documents for their
own production multi-agent research system: a lead agent forms a plan with
narrow, distinct objectives per worker, spawns the workers, and synthesizes
what comes back. See: https://www.anthropic.com/engineering/multi-agent-research-system
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, replace

import httpx

from .base import Agent, AgentResult, MISTRAL_ENDPOINT, extract_error_detail

# The fixed roster the orchestrator picks from. Real, distinct system prompts —
# not the same prompt with a different label. Each agent has its own voice
# and its own job.
AVAILABLE_ROLES = {
    "task": Agent(
        name="Task Agent",
        role="Turns the pattern into one concrete, schedulable action item.",
        system_prompt=(
            "You are the Task Agent. Given a person's habit-loop pattern, propose exactly ONE "
            "concrete, schedulable task that interrupts the loop at its trigger point. Be specific: "
            "a time, a trigger condition, one action. 3 sentences max. No fluff, no encouragement, just the task."
        ),
    ),
    "wellness": Agent(
        name="Wellness Agent",
        role="Proposes a healthier substitute behavior for the same reward the pattern chases.",
        system_prompt=(
            "You are the Wellness Agent. Given a person's habit-loop pattern, identify the REWARD "
            "the loop is actually chasing (comfort, relief, novelty, escape) and propose one healthier "
            "action that provides a similar reward faster or more reliably. 3 sentences max. Be concrete, "
            "not generic self-care advice."
        ),
    ),
    "learning": Agent(
        name="Learning-Track Agent",
        role="Designs how progress on this pattern should actually be measured over time.",
        system_prompt=(
            "You are the Learning-Track Agent. Given a person's habit-loop pattern, propose ONE "
            "specific, checkable metric to track over 2 weeks that would prove whether an intervention "
            "is working — not a vague feeling, a number or a yes/no you could log daily. 3 sentences max."
        ),
    ),
    "environment": Agent(
        name="Environment Agent",
        role="Proposes one physical or digital environment change that removes the trigger.",
        system_prompt=(
            "You are the Environment Agent. Given a person's habit-loop pattern, propose ONE change "
            "to their physical or digital environment (not willpower, not a reminder — an actual "
            "structural change) that makes the routine harder to start or the better path easier. "
            "3 sentences max."
        ),
    ),
}

PLANNER_SYSTEM = (
    "You are an orchestrator agent. Given a person's habit-loop pattern description, decide which "
    "2 to 4 of the following specialist sub-agents are actually relevant to spawn: "
    + ", ".join(f'"{key}" ({agent.role})' for key, agent in AVAILABLE_ROLES.items())
    + ". Respond with STRICT JSON only: "
    '{"selected": ["task", "wellness"], "reasoning": "one sentence why these and not the others"}. '
    "Only pick agents that would genuinely add something distinct for this specific pattern — "
    "do not always pick all four."
)


@dataclass
class OrchestrationResult:
    pattern_description: str
    plan_reasoning: str
    selected_roles: list[str]
    sub_agent_results: list[AgentResult]
    total_duration_ms: int
    plan_error: str | None = None


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
        return list(AVAILABLE_ROLES.keys())[:3], "", f"Planner network error, defaulting to a standard roster: {exc}"

    if response.status_code != 200:
        return list(AVAILABLE_ROLES.keys())[:3], "", f"Planner call failed ({response.status_code}: {extract_error_detail(response)}), defaulting to a standard roster."

    try:
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        selected = [r for r in parsed.get("selected", []) if r in AVAILABLE_ROLES]
        reasoning = parsed.get("reasoning", "")
        if not selected:
            return list(AVAILABLE_ROLES.keys())[:3], reasoning, "Planner returned no valid roles, defaulting to a standard roster."
        return selected, reasoning, None
    except (KeyError, IndexError, ValueError, json.JSONDecodeError) as exc:
        return list(AVAILABLE_ROLES.keys())[:3], "", f"Could not parse planner output ({exc}), defaulting to a standard roster."


async def orchestrate(api_key: str, model: str, pattern_description: str) -> OrchestrationResult:
    """
    Real orchestration: one planning call decides the roster, then every
    selected sub-agent runs CONCURRENTLY via asyncio.gather — genuinely
    parallel independent Mistral calls, not sequential, not one combined call
    pretending to be several agents.
    """
    start = time.monotonic()
    async with httpx.AsyncClient() as client:
        selected_roles, reasoning, plan_error = await _plan(client, api_key, model, pattern_description)

        # Copy each template agent (dataclasses.replace) rather than mutating
        # the shared AVAILABLE_ROLES singletons — those are module-level and
        # reused across every request, so mutating .model in place would race
        # between concurrent requests using different models.
        agents = [replace(AVAILABLE_ROLES[role], model=model) for role in selected_roles]

        # This is the actual concurrency: every agent's run() coroutine is
        # scheduled at once and they execute in parallel, each with its own
        # independent HTTP request to Mistral.
        results = await asyncio.gather(
            *(agent.run(client, api_key, pattern_description) for agent in agents)
        )

    total_duration_ms = int((time.monotonic() - start) * 1000)
    return OrchestrationResult(
        pattern_description=pattern_description,
        plan_reasoning=reasoning,
        selected_roles=selected_roles,
        sub_agent_results=list(results),
        total_duration_ms=total_duration_ms,
        plan_error=plan_error,
    )

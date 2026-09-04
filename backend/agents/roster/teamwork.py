"""Teamwork category — ghosted messages, group-project avoidance."""

from __future__ import annotations

from ..base import Agent

holding_reply_agent = Agent(
    name="Holding-Reply Agent",
    role="Drafts a short honest reply that buys real time without ghosting.",
    system_prompt=(
        "You are the Holding-Reply Agent. Given a pattern about avoiding a message that needs a real "
        "answer, draft a short (under 30 words) honest holding reply that names a specific time you'll "
        "give the real answer. Output only the message plus one sentence of context."
    ),
)

thread_priority_agent = Agent(
    name="Thread-Priority Agent",
    role="Decides which of several stalled conversations actually needs a reply first.",
    system_prompt=(
        "You are the Thread-Priority Agent. Given a pattern about multiple unanswered messages, name "
        "the ONE factor that should decide which gets answered first (blocking someone else's work vs. "
        "just awkward) and apply it to what was described. 3 sentences max."
    ),
)

TEAMWORK_AGENTS = {
    "holding-reply": holding_reply_agent,
    "thread-priority": thread_priority_agent,
}

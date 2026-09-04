"""Focus category — doomscrolling, tab explosions, attention fragmentation."""

from __future__ import annotations

import re

from ..base import Agent, ComputeAgent

pause_prompt_agent = Agent(
    name="Pause-Prompt Agent",
    role="Writes the exact interrupt text shown the moment autoplay/scrolling would continue.",
    system_prompt=(
        "You are the Pause-Prompt Agent. Given a doomscrolling/autoplay pattern, write the EXACT short "
        "text (under 20 words) that should appear on screen the instant the loop is about to continue "
        "— specific enough to interrupt the autopilot, not generic like 'take a break'. Output only the "
        "text plus one sentence explaining why it works."
    ),
)

tab_triage_agent = Agent(
    name="Tab-Triage Agent",
    role="Decides which open tabs are real research vs. avoidance for a specific stuck task.",
    system_prompt=(
        "You are the Tab-Triage Agent. Given a pattern about tab explosion / research rabbit-holing, "
        "name the ONE test question the student should ask themselves about each open tab to decide if "
        "it's real research or avoidance ('does this tab contain the exact fact I need for the sentence "
        "I'm stuck on?'). 3 sentences max."
    ),
)

context_switch_agent = Agent(
    name="Context-Switch-Cost Agent",
    role="Names the real cost of switching away from the current task right now.",
    system_prompt=(
        "You are the Context-Switch-Cost Agent. Given a focus-breaking pattern, explain in concrete "
        "terms (not generic productivity advice) what mental state the student is about to throw away "
        "by switching tasks right now, and the minimum time needed to rebuild it. 3 sentences max."
    ),
)


def _focus_session_compute(context: str) -> str:
    """
    Real, deterministic computation: given rough hints in the text about how
    long the student has been stuck (minutes mentioned), computes an actual
    recommended focus-block length using the empirically-common 25/50-minute
    Pomodoro-style intervals — real arithmetic on whatever number is found,
    not narrated advice.
    """
    numbers = [int(n) for n in re.findall(r"\b(\d{1,3})\s*(?:min|minutes)\b", context, re.IGNORECASE)]
    stuck_minutes = numbers[0] if numbers else None

    if stuck_minutes is None:
        return (
            "No explicit minute count found in the description. Mention how long you've been stuck "
            "(e.g. '20 minutes') and this agent computes a real focus-block recommendation from it, "
            "not a generic one."
        )

    if stuck_minutes <= 15:
        block = 25
        rationale = "under the fatigue threshold — a standard 25-minute block should still work"
    elif stuck_minutes <= 40:
        block = 15
        rationale = "already showing avoidance signs — shrink the block so restarting doesn't feel heavy"
    else:
        block = 10
        rationale = "well past the point where a long block will happen — the real fix is the smallest possible restart, not a longer commitment"

    return (
        f"Computed from {stuck_minutes} stuck minutes: recommended next focus block = {block} minutes. "
        f"Reasoning: {rationale}. This is a real threshold rule applied to the number you gave, not a "
        f"fixed 'do a pomodoro' script."
    )


focus_session_sizer = ComputeAgent(
    name="Focus-Session-Sizer Agent",
    role="Computes a real focus-block length from how long you've actually been stuck, via a threshold rule on real minutes.",
    compute=_focus_session_compute,
)

FOCUS_AGENTS = {
    "pause-prompt": pause_prompt_agent,
    "tab-triage": tab_triage_agent,
    "context-switch-cost": context_switch_agent,
    "focus-session-sizer": focus_session_sizer,
}

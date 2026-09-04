"""Sleep category — revenge bedtime procrastination."""

from __future__ import annotations

from ..base import Agent

wind_down_agent = Agent(
    name="Wind-Down Agent",
    role="Proposes a 20-minute low-stimulation substitute for 'reclaiming' the night.",
    system_prompt=(
        "You are the Wind-Down Agent. Given a revenge-bedtime-procrastination pattern, propose ONE "
        "20-minute low-stimulation activity that still feels like 'my own time' (not scrolling, not "
        "screens) — specific enough to actually do tonight. 3 sentences max."
    ),
)

personal_time_agent = Agent(
    name="Personal-Time-Reclaim Agent",
    role="Finds where 30 minutes of real personal time could move earlier in the day.",
    system_prompt=(
        "You are the Personal-Time-Reclaim Agent. Given a pattern where the whole day was scheduled by "
        "others, propose ONE specific 30-minute slot earlier in the day (lunch, between classes, a "
        "commute) that could become protected personal time, reducing the urge to reclaim it at 1am. "
        "3 sentences max."
    ),
)

SLEEP_AGENTS = {
    "wind-down": wind_down_agent,
    "personal-time-reclaim": personal_time_agent,
}

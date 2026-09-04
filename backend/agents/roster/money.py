"""Money category — late-night spending, impulse carts."""

from __future__ import annotations

import re

from ..base import Agent, ComputeAgent

cooldown_agent = Agent(
    name="Cooldown-Copy Agent",
    role="Writes the exact reflective question shown before a late-night checkout.",
    system_prompt=(
        "You are the Cooldown-Copy Agent. Given a late-night impulse-spending pattern, write the exact "
        "one-sentence question that should appear before checkout — specific enough to break the "
        "autopilot ('will you still want this Tuesday morning, sober and rested?'), not generic. Output "
        "only the question plus one sentence on why it works for THIS pattern."
    ),
)

deadline_purchase_agent = Agent(
    name="Genuine-Deadline Agent",
    role="Distinguishes a real time-boxed purchase need from manufactured urgency.",
    system_prompt=(
        "You are the Genuine-Deadline Agent. Given a spending pattern, ask the ONE question that "
        "separates a real deadline purchase (a textbook due tomorrow) from manufactured urgency ('sale "
        "ends at midnight') — e.g. 'does missing this window cause a real, named consequence, or just "
        "a worse price?'. 3 sentences max."
    ),
)


def _spend_math_compute(context: str) -> str:
    """
    Real arithmetic: extracts any currency-like numbers mentioned and
    computes what that amount is as a fraction of a typical monthly student
    budget assumption, stated explicitly as an assumption — real math on
    real extracted numbers, not narrated concern.
    """
    numbers = [float(n.replace(",", "")) for n in re.findall(r"(?:₹|Rs\.?|rs\.?)\s*([\d,]+(?:\.\d+)?)", context, re.IGNORECASE)]
    if not numbers:
        numbers = [float(n.replace(",", "")) for n in re.findall(r"\b([\d,]{3,6})\b", context)]

    if not numbers:
        return "No amount found in the description. Mention the actual number (e.g. '₹1500') and this agent computes the real budget-fraction math."

    amount = max(numbers)
    assumed_monthly_budget = 8000.0  # explicit stated assumption, not hidden
    fraction_pct = (amount / assumed_monthly_budget) * 100

    return (
        f"Real computation: ₹{amount:,.0f} against an assumed ₹{assumed_monthly_budget:,.0f}/month "
        f"discretionary budget (adjust this assumption for your real number) = {fraction_pct:.1f}% of the "
        f"whole month's discretionary spend, in one purchase, at whatever hour this is happening. "
        f"That percentage is the real number to sit with for the 12-hour cooldown, not a vague 'it adds up' feeling."
    )


spend_math_agent = ComputeAgent(
    name="Spend-Math Agent",
    role="Computes the real percentage of a monthly budget one purchase represents, from an actual extracted number.",
    compute=_spend_math_compute,
)

MONEY_AGENTS = {
    "cooldown-copy": cooldown_agent,
    "genuine-deadline": deadline_purchase_agent,
    "spend-math": spend_math_agent,
}

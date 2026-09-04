"""
Data category — real pandas analysis on the user's OWN logged app data
(scenario runs, prediction outcomes), when it's included in the request
context as JSON. This is the most literal answer to "use real libraries":
actual pandas groupby/correlation on real numbers, not a narrated guess.

Degrades honestly when no structured log data is present in the context —
never fabricates statistics.
"""

from __future__ import annotations

import json
import re

from ..base import ComputeAgent


def _extract_log_json(context: str) -> list[dict] | None:
    """Look for a fenced ```json [...]``` block in the context — the frontend
    can optionally attach the user's real scenarioLog this way."""
    match = re.search(r"```json\s*\n(.*?)```", context, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(1))
        return parsed if isinstance(parsed, list) else None
    except (json.JSONDecodeError, ValueError):
        return None


def _trend_compute(context: str) -> str:
    try:
        import pandas as pd
    except ImportError:
        return "pandas is not installed in this environment — real trend analysis unavailable."

    records = _extract_log_json(context)
    if not records:
        return (
            "No structured log data found in the description (looked for a fenced ```json [...] ``` "
            "block of past outcomes). This agent runs real pandas analysis when given real logged data "
            "— e.g. your agent's actual scenarioLog — rather than guessing a trend from prose."
        )

    try:
        df = pd.DataFrame(records)
    except Exception as exc:  # noqa: BLE001
        return f"Could not build a DataFrame from the provided log data: {exc}"

    if "predictionResult" not in df.columns or df.empty:
        return "Log data present but missing a 'predictionResult' column — nothing to compute a real trend on."

    counts = df["predictionResult"].value_counts()
    total = len(df)
    correct = int(counts.get("correct", 0))
    accuracy_pct = (correct / total) * 100 if total else 0.0

    trend_note = ""
    if total >= 4:
        half = total // 2
        first_half_acc = (df.iloc[:half]["predictionResult"] == "correct").mean() * 100
        second_half_acc = (df.iloc[half:]["predictionResult"] == "correct").mean() * 100
        direction = "improving" if second_half_acc > first_half_acc else "declining" if second_half_acc < first_half_acc else "flat"
        trend_note = (
            f" Split in half by time: first-half accuracy {first_half_acc:.0f}%, second-half {second_half_acc:.0f}% "
            f"— real trend direction: {direction}."
        )

    return (
        f"Real pandas computation over {total} actual logged runs: {accuracy_pct:.0f}% correct "
        f"({correct}/{total}), breakdown {dict(counts)}.{trend_note} This is arithmetic on your real "
        f"history, not a narrated impression of how you're doing."
    )


trend_agent = ComputeAgent(
    name="Trend-Analysis Agent",
    role="Runs real pandas groupby/trend computation on your actual logged scenario outcomes, when provided.",
    compute=_trend_compute,
)

DATA_AGENTS = {
    "trend-analysis": trend_agent,
}

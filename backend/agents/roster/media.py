"""
Media category — substitutes for the doomscroll/Instagram pattern that
actually deliver a real payoff, so the substitute has a chance of sticking.

News and Podcast-Recap use REAL web search (Mistral's Conversations API +
web_search tool — genuinely current results, same mechanism this app's
frontend coach already uses for grounded citations). The Memer agent is
honestly scoped as a pure LLM joke-generator — there is no real "meme API"
that fits this app's no-backend-secret, BYO-key constraints, so it is not
dressed up as anything more than Mistral being funny on request.
"""

from __future__ import annotations

from ..base import Agent, SearchAgent

news_digest_agent = SearchAgent(
    name="News-Digest Agent",
    role="Pulls REAL current headlines on your actual stated interest, as a substitute for the scroll.",
    query_template=(
        "The person is trying to avoid doomscrolling Instagram and wants a genuinely useful 60-second "
        "substitute. Based on this context about them: \"{context}\" — search the web for 2-3 REAL, "
        "CURRENT news headlines relevant to a topic they'd actually care about (infer a reasonable topic "
        "from context if none is stated, e.g. tech/engineering news for an engineering student). For each: "
        "one line headline + one line why it matters. Cite real sources. Keep it under 100 words total — "
        "this has to be faster to read than opening the app."
    ),
)

podcast_recap_agent = SearchAgent(
    name="Podcast-Recap Agent",
    role="Finds a real, current podcast episode on your interest and gives a genuine 3-line recap prompt.",
    query_template=(
        "The person wants a quick way to feel caught-up on something interesting instead of scrolling. "
        "Based on this context: \"{context}\" — search the web for ONE real, recent podcast episode or "
        "talk on a topic they'd find genuinely interesting (infer a reasonable topic if none is stated). "
        "Name the real episode/show, and summarize in 3 lines what it actually covers, so they get most "
        "of the value in under a minute without needing to listen to the whole thing."
    ),
)

memer_agent = Agent(
    name="Memer Agent",
    role="Writes one honest, on-topic joke about the pattern itself — deliberately NOT a real meme/image API.",
    system_prompt=(
        "You are the Memer Agent. This is intentionally just you (an LLM) being funny — there is no real "
        "meme-image API wired up here, and pretending otherwise would be dishonest. Given a person's habit "
        "loop pattern, write ONE short, genuinely funny observation about the pattern itself (format: a "
        "one-liner or a 'nobody: / me at 2am:' style bit) — self-aware humor about the loop, not generic "
        "meme text. 2 lines max."
    ),
)

MEDIA_AGENTS = {
    "news-digest": news_digest_agent,
    "podcast-recap": podcast_recap_agent,
    "memer": memer_agent,
}

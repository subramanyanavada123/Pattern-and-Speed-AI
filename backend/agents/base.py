"""
Base agent types: real, independently-runnable units of work.

Two kinds exist, both awaitable, both usable interchangeably by the
orchestrator's asyncio.gather() fan-out:

- `Agent` — makes its own real Mistral call with its own system prompt.
- `ComputeAgent` — does real local computation (calendar math, pandas
  analysis, sandboxed code execution, TF-IDF retrieval) with NO Mistral
  call at all. This is the actual answer to "you're not using any real
  libraries" — several agents in the roster do real work in Python, not
  prompt variations of the same LLM call.

A third kind, `SearchAgent`, calls Mistral's Conversations API with the
real web_search tool — genuinely current results, not training-data
improvisation, using the same endpoint/error-shape this app's frontend
(src/mistral.ts's searchWeb) already verified live against the real API.

All three produce the same AgentResult shape, so the orchestrator, the API
response, and the frontend don't need to know which kind ran.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

import httpx

MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions"
MISTRAL_CONVERSATIONS_ENDPOINT = "https://api.mistral.ai/v1/conversations"


class AgentError(Exception):
    """Raised when an agent's work fails outright. Carries a human-readable message."""


@dataclass
class Citation:
    title: str
    url: str


@dataclass
class AgentResult:
    agent_name: str
    role: str
    output: str
    started_at: float
    finished_at: float
    error: str | None = None
    # Real citations (title + url) from Mistral's web_search tool — only
    # ever populated by SearchAgent; every other agent leaves this empty
    # rather than fabricating a source. This is what actually lets the
    # frontend render a clickable link/thumbnail instead of plain prose.
    citations: list[Citation] = field(default_factory=list)

    @property
    def duration_ms(self) -> int:
        return int((self.finished_at - self.started_at) * 1000)


class Runnable(Protocol):
    """Anything the orchestrator can await concurrently: has a name/role and a run() coroutine."""

    name: str
    role: str

    async def run(self, client: httpx.AsyncClient, api_key: str, context: str) -> AgentResult: ...


@dataclass
class Agent:
    """
    A real LLM-backed agent: its own system prompt, its own independent
    Mistral call. `run()` is a coroutine — the orchestrator awaits several
    of these concurrently.
    """

    name: str
    role: str
    system_prompt: str
    model: str = "mistral-small-latest"
    max_tokens: int = 400
    temperature: float = 0.6

    async def run(self, client: httpx.AsyncClient, api_key: str, context: str) -> AgentResult:
        started = time.monotonic()
        try:
            response = await client.post(
                MISTRAL_ENDPOINT,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": self.system_prompt},
                        {"role": "user", "content": context},
                    ],
                    "temperature": self.temperature,
                    "max_tokens": self.max_tokens,
                },
                timeout=30.0,
            )
        except httpx.RequestError as exc:
            finished = time.monotonic()
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"Network error reaching Mistral: {exc}",
            )

        finished = time.monotonic()
        if response.status_code != 200:
            detail = extract_error_detail(response)
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"Mistral returned {response.status_code}: {detail}",
            )

        try:
            body = response.json()
            text = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, ValueError) as exc:
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"Unexpected Mistral response shape: {exc}",
            )

        return AgentResult(
            agent_name=self.name, role=self.role, output=text.strip(),
            started_at=started, finished_at=finished,
        )


@dataclass
class ComputeAgent:
    """
    A real agent that does NOT call an LLM at all — it runs actual Python
    computation (calendar math, pandas, sandboxed exec, TF-IDF, whatever the
    `compute` callable does) and returns a real result. Still awaited
    concurrently alongside LLM-backed Agents by the same asyncio.gather() —
    from the orchestrator's point of view they're interchangeable Runnables.

    `compute` receives the same free-text context every LLM agent gets and
    must return the finished output string (or raise, which run() catches
    and turns into an AgentResult.error). Kept synchronous-callable-typed
    because most of these computations (datetime math, pandas, sklearn) are
    CPU-bound, not I/O-bound — running them directly is fine for the small
    payloads this app deals with; run() still awaits it as required by the
    Runnable protocol via asyncio.to_thread so one slow computation can't
    block the event loop that the concurrent LLM agents are relying on.
    """

    name: str
    role: str
    compute: Callable[[str], str]

    async def run(self, client: httpx.AsyncClient, api_key: str, context: str) -> AgentResult:
        import asyncio
        import functools

        started = time.monotonic()
        try:
            # asyncio.to_thread() is 3.9+; this environment runs 3.8, so use
            # the equivalent run_in_executor call directly for compatibility.
            loop = asyncio.get_running_loop()
            output = await loop.run_in_executor(None, functools.partial(self.compute, context))
        except Exception as exc:  # noqa: BLE001 - a compute agent's internal failure must not crash the whole orchestration
            finished = time.monotonic()
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"{type(exc).__name__}: {exc}",
            )
        finished = time.monotonic()
        return AgentResult(agent_name=self.name, role=self.role, output=output, started_at=started, finished_at=finished)


@dataclass
class SearchAgent:
    """
    A real, web-search-grounded agent via Mistral's Conversations API
    (/v1/conversations, tools:[{type:"web_search"}]) — genuinely current
    results, not an LLM improvising from training data. Same endpoint and
    error envelope ({"detail": ...} on auth failure) this app's frontend
    already confirmed live against the real API (src/mistral.ts searchWeb).
    """

    name: str
    role: str
    query_template: str  # gets .format(context=...) applied
    model: str = "mistral-small-latest"
    max_tokens: int = 500

    async def run(self, client: httpx.AsyncClient, api_key: str, context: str) -> AgentResult:
        started = time.monotonic()
        query = self.query_template.format(context=context)
        try:
            response = await client.post(
                MISTRAL_CONVERSATIONS_ENDPOINT,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json={
                    "model": self.model,
                    "inputs": query,
                    "tools": [{"type": "web_search"}],
                    "completion_args": {"max_tokens": self.max_tokens},
                },
                timeout=30.0,
            )
        except httpx.RequestError as exc:
            finished = time.monotonic()
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"Network error reaching Mistral: {exc}",
            )

        finished = time.monotonic()
        if response.status_code != 200:
            detail = extract_error_detail(response)
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"Mistral web search returned {response.status_code}: {detail}",
            )

        try:
            body = response.json()
        except ValueError as exc:
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error=f"Could not parse Mistral response: {exc}",
            )

        # The Conversations API response shape is still evolving (beta) —
        # parse defensively across the plausible output shapes, same
        # tolerance src/mistral.ts's searchWeb() already applies. Citation
        # chunks (type "tool_reference") are what actually let the frontend
        # render a real clickable link instead of plain prose — dropping
        # them (the previous bug here) meant every search result looked
        # like flat text even when Mistral genuinely found real sources.
        text_parts: list[str] = []
        citations: list[Citation] = []
        seen_urls: set[str] = set()
        for output in body.get("outputs", []) or []:
            content = output.get("content")
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                for chunk in content:
                    if isinstance(chunk, str):
                        text_parts.append(chunk)
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if isinstance(chunk.get("text"), str):
                        text_parts.append(chunk["text"])
                    if chunk.get("type") == "tool_reference" and isinstance(chunk.get("url"), str):
                        url = chunk["url"]
                        if url in seen_urls:
                            continue
                        seen_urls.add(url)
                        title = chunk.get("title") if isinstance(chunk.get("title"), str) else url
                        citations.append(Citation(title=title, url=url))

        text = "".join(text_parts).strip()
        if not text:
            return AgentResult(
                agent_name=self.name, role=self.role, output="",
                started_at=started, finished_at=finished,
                error="Mistral web search returned no readable text.",
            )
        return AgentResult(
            agent_name=self.name, role=self.role, output=text,
            started_at=started, finished_at=finished, citations=citations,
        )


def extract_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    # Mistral's endpoints use different error envelopes depending on which
    # API you hit — chat completions uses {message}, others use {detail} or
    # {error: {message}}. Check all of them rather than assuming one shape.
    return (
        body.get("message")
        or body.get("detail")
        or (body.get("error") or {}).get("message")
        or str(body.get("error", ""))
        or "unknown error"
    )

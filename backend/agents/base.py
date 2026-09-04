"""
Base agent: a real, independently-runnable unit of work.

Each concrete agent below is not a JSON-schema fiction — it is an actual
Python object with its own async run() coroutine, its own system prompt,
and its own call to Mistral. The orchestrator runs several of these
concurrently with asyncio.gather(), so sub-agents genuinely execute in
parallel, not as sections of one combined prompt.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions"


class AgentError(Exception):
    """Raised when an agent's Mistral call fails. Carries a human-readable message."""


@dataclass
class AgentResult:
    agent_name: str
    role: str
    output: str
    started_at: float
    finished_at: float
    error: str | None = None

    @property
    def duration_ms(self) -> int:
        return int((self.finished_at - self.started_at) * 1000)


@dataclass
class Agent:
    """
    One real agent: a name, a role description, a system prompt, and the
    ability to actually call Mistral on its own. `run()` is a coroutine —
    the orchestrator awaits several of these concurrently.
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

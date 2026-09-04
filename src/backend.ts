import { keyStore } from './store'

/**
 * Client for the REAL Python agent backend (backend/main.py). This is
 * genuinely different from every other AI call in this app: everywhere else,
 * Mistral is called directly from the browser. Here, the browser calls a
 * separate FastAPI process that itself runs real, independently-executing
 * concurrent agent coroutines (asyncio.gather) — something a browser tab
 * cannot do on its own (no persistent process, and JS concurrency for
 * network calls, while real, doesn't map to "spawning independent
 * long-lived agent workers" the way a server process does).
 *
 * The backend holds no state and stores no key — your Mistral key travels
 * in the request body only, exactly once, per request. Same "your key,
 * never ours" model as the rest of the app.
 */

const BACKEND_URL = 'http://127.0.0.1:8787'

export class BackendError extends Error {}

export type SubAgentOutput = {
  agentName: string
  role: string
  output: string
  durationMs: number
  error: string | null
}

export type OrchestrationResult = {
  planReasoning: string
  planError: string | null
  selectedRoles: string[]
  subAgents: SubAgentOutput[]
  totalDurationMs: number
}

/** True once we've confirmed the backend is actually reachable this session — avoids a slow timeout on every call if it's simply not running. */
let backendReachable: boolean | null = null

export async function isBackendUp(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal, method: 'GET' })
    backendReachable = res.ok
    return res.ok
  } catch {
    backendReachable = false
    return false
  }
}

export function knownBackendState(): boolean | null {
  return backendReachable
}

/**
 * Ask the real backend to orchestrate a pattern into genuinely concurrent
 * sub-agents. Requires the backend process to be running locally
 * (`uvicorn main:app` inside backend/) — this is not a fallback-able feature
 * the way the browser-only Mistral calls are, since the whole point is real
 * server-side concurrency a static page cannot provide.
 */
export async function orchestratePattern(patternDescription: string, signal?: AbortSignal): Promise<OrchestrationResult> {
  const apiKey = keyStore.get()
  if (!apiKey) throw new BackendError('Add a Mistral key in Settings first — the backend needs it to run the sub-agents.')

  let res: Response
  try {
    res = await fetch(`${BACKEND_URL}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern_description: patternDescription,
        mistral_api_key: apiKey,
        model: keyStore.model(),
      }),
      signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    backendReachable = false
    throw new BackendError(
      "Can't reach the local agent backend at " + BACKEND_URL + '. Start it with: cd backend && pip install -r requirements.txt && uvicorn main:app --reload --port 8787',
    )
  }
  backendReachable = true

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.detail ?? ''
    } catch {
      /* noop */
    }
    throw new BackendError(detail || `Backend returned ${res.status}`)
  }

  const json = await res.json()
  return {
    planReasoning: json.plan_reasoning ?? '',
    planError: json.plan_error ?? null,
    selectedRoles: json.selected_roles ?? [],
    subAgents: (json.sub_agents ?? []).map((s: Record<string, unknown>) => ({
      agentName: s.agent_name,
      role: s.role,
      output: s.output,
      durationMs: s.duration_ms,
      error: s.error ?? null,
    })),
    totalDurationMs: json.total_duration_ms ?? 0,
  }
}

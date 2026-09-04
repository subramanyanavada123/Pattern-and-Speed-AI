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
 * never ours" model as the rest of the app. The one exception is a
 * scheduled job: its key is held in the backend PROCESS's memory only
 * (never written to disk) so it can keep firing on a real interval without
 * a browser tab open — see scheduling functions below.
 */

// Points at your local backend by default (matches backend/README.md's
// `uvicorn main:app --port 8787`). Set VITE_BACKEND_URL at build time (e.g.
// in Vercel's project settings) to point a deployed frontend at a real,
// always-on backend instead (Render/Railway/Fly — see backend/README.md's
// deployment section for why this can't be Vercel itself: APScheduler needs
// a persistent process, which serverless functions don't provide).
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/$/, '') || 'http://127.0.0.1:8787'

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
  roleCategories: Record<string, string>
  subAgents: SubAgentOutput[]
  totalDurationMs: number
}

export type RosterAgent = { key: string; name: string; role: string }
export type RosterCategories = Record<string, RosterAgent[]>

export type ScheduledJob = {
  id: string
  role: string
  roleName: string
  category: string
  label: string
  intervalMinutes: number
  context: string
  createdAt: number
  lastRunAt: number | null
  lastOutput: string | null
  lastError: string | null
  needsKey: boolean
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

async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${BACKEND_URL}${path}`, init)
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
      detail = (await res.clone().json())?.detail ?? ''
    } catch {
      /* noop */
    }
    throw new BackendError(detail || `Backend returned ${res.status}`)
  }
  return res
}

/**
 * Ask the real backend to orchestrate a pattern into genuinely concurrent
 * sub-agents, picked from the full 25-agent roster across 8 student-life
 * categories. Requires the backend process to be running locally
 * (`uvicorn main:app` inside backend/) — this is not a fallback-able feature
 * the way the browser-only Mistral calls are, since the whole point is real
 * server-side concurrency a static page cannot provide.
 */
export async function orchestratePattern(patternDescription: string, signal?: AbortSignal): Promise<OrchestrationResult> {
  const apiKey = keyStore.get()
  if (!apiKey) throw new BackendError('Add a Mistral key in Settings first — the backend needs it to run the sub-agents.')

  const res = await backendFetch('/orchestrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pattern_description: patternDescription,
      mistral_api_key: apiKey,
      model: keyStore.model(),
    }),
    signal,
  })

  const json = await res.json()
  return {
    planReasoning: json.plan_reasoning ?? '',
    planError: json.plan_error ?? null,
    selectedRoles: json.selected_roles ?? [],
    roleCategories: json.role_categories ?? {},
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

/** The full real roster (25 agents across 8 categories) — fetched live from the backend, not hardcoded in the frontend, so it never drifts from what actually runs. */
export async function fetchRoster(signal?: AbortSignal): Promise<RosterCategories> {
  const res = await backendFetch('/roster', { signal })
  const json = await res.json()
  return json.categories ?? {}
}

function jobFromJson(j: Record<string, unknown>): ScheduledJob {
  return {
    id: j.id as string,
    role: j.role as string,
    roleName: j.role_name as string,
    category: j.category as string,
    label: j.label as string,
    intervalMinutes: j.interval_minutes as number,
    context: (j.context as string) ?? '',
    createdAt: j.created_at as number,
    lastRunAt: (j.last_run_at as number) ?? null,
    lastOutput: (j.last_output as string) ?? null,
    lastError: (j.last_error as string) ?? null,
    needsKey: Boolean(j.needs_key),
  }
}

/**
 * Real recurring execution: creates an APScheduler job in the backend
 * process that re-runs the chosen agent every intervalMinutes, independent
 * of this browser tab. Runs once immediately so a real result shows up
 * right away. Your Mistral key is sent once here and held only in the
 * backend process's memory (never written to disk) — see backend/scheduler.py.
 */
export async function createSchedule(opts: { role: string; label: string; intervalMinutes: number; context: string }): Promise<ScheduledJob> {
  const apiKey = keyStore.get()
  if (!apiKey) throw new BackendError('Add a Mistral key in Settings first — scheduled agents need it to run.')

  const res = await backendFetch('/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: opts.role,
      label: opts.label,
      interval_minutes: opts.intervalMinutes,
      context: opts.context,
      mistral_api_key: apiKey,
      model: keyStore.model(),
    }),
  })
  return jobFromJson(await res.json())
}

/** Lists every real scheduled job the backend process currently holds (persisted to backend/schedules.json, minus the key). */
export async function listSchedules(signal?: AbortSignal): Promise<ScheduledJob[]> {
  const res = await backendFetch('/schedule', { signal })
  const json = await res.json()
  return (json.jobs ?? []).map(jobFromJson)
}

/** After a backend restart, a job's definition survives but its key doesn't (never persisted) — this resupplies it so the real interval picks back up. */
export async function resumeSchedule(jobId: string): Promise<ScheduledJob> {
  const apiKey = keyStore.get()
  if (!apiKey) throw new BackendError('Add a Mistral key in Settings first.')
  const res = await backendFetch(`/schedule/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mistral_api_key: apiKey }),
  })
  return jobFromJson(await res.json())
}

export async function deleteSchedule(jobId: string): Promise<void> {
  await backendFetch(`/schedule/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
}

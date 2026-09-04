import type { Pattern, FlagSpec, ActionSpec, Scenario, DayOfWeek } from './types'
import { generate, MistralError, extractJson } from './mistral'
import { keyStore } from './store'
import { isValidScenario } from './engine'

/**
 * Pattern discovery: turn a user's own free-text description of a habit loop
 * into a full, structured Pattern — the same shape as the six hand-authored
 * presets in patterns.ts, so it plugs into Decode/Build/Simulate/Evolve with
 * zero special-casing anywhere else in the app.
 *
 * This is the one place Mistral does more than narrate: it PROPOSES the
 * pattern's entire vocabulary (flags, actions) and an initial scenario bank.
 * But it still never decides whether a rule fires — that stays engine.ts's
 * job unconditionally, once this Pattern exists. And every AI-generated
 * scenario's expectedFire ships as unverified (Scenario.verified = false)
 * until the user confirms it matches their real experience — see
 * confirmScenario() below and Scenario.verified's doc comment in types.ts.
 */

const SYSTEM = `You turn a person's own description of a recurring habit loop into a structured specification for a deterministic rule-testing tool, for engineering students.

You must output STRICT JSON matching this exact shape:
{
  "title": "short punchy name for the loop, e.g. 'The 1am cart'",
  "label": "one or two word category, e.g. 'Money'",
  "icon": "one emoji",
  "trigger": "one sentence: the situation that starts the loop",
  "routine": "one sentence: the automatic action taken",
  "reward": "one sentence: the immediate payoff",
  "cost": "one sentence: the delayed cost",
  "scene": "2-3 sentences, present tense, second person — a concrete moment this loop happens",
  "flags": [ { "id": "camelCaseId", "label": "human-readable label", "defaultValue": false }, ... 3 to 5 flags ... ],
  "actions": [ { "id": "kebab-case-id", "label": "short label", "description": "one sentence describing the move" }, ... exactly 2 actions ... ],
  "scenarios": [
    { "kind": "normal", "title": "...", "sceneText": "2-3 sentences", "clockMin": number 0-1439, "dayOfWeek": number 0-6, "flags": {"<flagId>": true|false, ...every flag...}, "expectedFire": true|false },
    { "kind": "edge", ... same shape ... },
    { "kind": "exception", ... same shape ... },
    { "kind": "stress", ... same shape ... }
  ]
}

Rules:
- Flags must be simple booleans a person could actually check about a moment — never vague feelings.
- Actions must be small and reversible — a nudge, a friction point, a staged draft — never something drastic or irreversible.
- Every scenario's "flags" object must set a value for every flag id you defined, no more, no less.
- The four scenarios must meaningfully differ: normal = the loop clearly fires, edge = a close case where it should NOT fire, exception = a named exception applies, stress = a genuinely tricky case.
- expectedFire is your best-effort judgment call — it will be shown to the user to confirm or correct, so make a real attempt, don't hedge.
- Base everything on what the person actually described. Do not invent an unrelated example.`

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom'
}

type RawFlag = { id?: unknown; label?: unknown; defaultValue?: unknown }
type RawAction = { id?: unknown; label?: unknown; description?: unknown }
type RawScenario = { kind?: unknown; title?: unknown; sceneText?: unknown; clockMin?: unknown; dayOfWeek?: unknown; flags?: unknown; expectedFire?: unknown }
type RawPattern = {
  title?: unknown; label?: unknown; icon?: unknown; trigger?: unknown; routine?: unknown
  reward?: unknown; cost?: unknown; scene?: unknown; flags?: unknown; actions?: unknown; scenarios?: unknown
}

function isValidFlag(f: unknown): f is FlagSpec {
  if (!f || typeof f !== 'object') return false
  const c = f as RawFlag
  return typeof c.id === 'string' && /^[a-zA-Z][a-zA-Z0-9]*$/.test(c.id) && typeof c.label === 'string' && typeof c.defaultValue === 'boolean'
}

function isValidAction(a: unknown): a is ActionSpec {
  if (!a || typeof a !== 'object') return false
  const c = a as RawAction
  return typeof c.id === 'string' && c.id.length > 0 && typeof c.label === 'string' && typeof c.description === 'string'
}

const VALID_KINDS = new Set(['normal', 'edge', 'exception', 'stress'])

/**
 * Validate and normalize the raw Mistral JSON into a real Pattern. Returns
 * null on any structural problem — the caller falls back to asking again or
 * telling the user discovery failed, it never half-builds a broken pattern.
 */
function buildPatternFromRaw(raw: RawPattern, sourceDescription: string): Pattern | null {
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null
  if (typeof raw.label !== 'string' || typeof raw.icon !== 'string') return null
  if (typeof raw.trigger !== 'string' || typeof raw.routine !== 'string') return null
  if (typeof raw.reward !== 'string' || typeof raw.cost !== 'string' || typeof raw.scene !== 'string') return null
  if (!Array.isArray(raw.flags) || raw.flags.length < 2 || raw.flags.length > 6) return null
  if (!raw.flags.every(isValidFlag)) return null
  const flags = raw.flags as FlagSpec[]
  const flagIds = new Set(flags.map((f) => f.id))
  if (flagIds.size !== flags.length) return null // no duplicate flag ids

  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 4) return null
  if (!raw.actions.every(isValidAction)) return null
  const actions = raw.actions as ActionSpec[]
  const actionIds = new Set(actions.map((a) => a.id))
  if (actionIds.size !== actions.length) return null

  if (!Array.isArray(raw.scenarios) || raw.scenarios.length < 1) return null

  const id = `custom-${slugify(raw.title)}-${Date.now().toString(36)}`
  const scenarios: Scenario[] = []
  for (const s of raw.scenarios as RawScenario[]) {
    if (typeof s.kind !== 'string' || !VALID_KINDS.has(s.kind)) return null
    if (typeof s.title !== 'string' || typeof s.sceneText !== 'string') return null
    if (typeof s.clockMin !== 'number' || s.clockMin < 0 || s.clockMin > 1439) return null
    if (typeof s.dayOfWeek !== 'number' || s.dayOfWeek < 0 || s.dayOfWeek > 6) return null
    if (typeof s.expectedFire !== 'boolean') return null
    if (!s.flags || typeof s.flags !== 'object') return null
    const sFlags = s.flags as Record<string, unknown>
    const normalizedFlags: Record<string, boolean> = {}
    for (const f of flags) {
      const v = sFlags[f.id]
      if (typeof v !== 'boolean') return null
      normalizedFlags[f.id] = v
    }
    scenarios.push({
      id: `${id}-${s.kind}-${scenarios.length}`,
      patternId: id,
      kind: s.kind as Scenario['kind'],
      title: s.title,
      sceneText: s.sceneText,
      clockMin: s.clockMin,
      dayOfWeek: s.dayOfWeek as DayOfWeek,
      flags: normalizedFlags,
      expectedFire: s.expectedFire,
      fromMistral: true,
      // Freshly discovered — the user hasn't confirmed these guesses yet.
      verified: false,
    })
  }

  const colorPalette = ['coral', 'lime', 'blue', 'orange', 'violet', 'pink']
  return {
    id,
    icon: raw.icon.trim().slice(0, 4) || '✳',
    label: raw.label.trim().slice(0, 24) || 'Custom',
    title: raw.title.trim(),
    trigger: raw.trigger.trim(),
    routine: raw.routine.trim(),
    reward: raw.reward.trim(),
    cost: raw.cost.trim(),
    color: colorPalette[Math.floor(Math.random() * colorPalette.length)],
    scene: raw.scene.trim(),
    flags,
    actions,
    scenarios,
    custom: true,
    sourceDescription,
  }
}

export type DiscoveryResult =
  | { ok: true; pattern: Pattern }
  | { ok: false; error: string }

/** Extract a full Pattern from the user's own description. Requires a Mistral key — there is no offline path, since this IS the AI-does-real-work feature. */
export async function discoverPattern(description: string, signal?: AbortSignal): Promise<DiscoveryResult> {
  const trimmed = description.trim()
  if (trimmed.length < 12) {
    return { ok: false, error: 'Say a bit more — a sentence or two about when it happens and what you do.' }
  }
  if (!keyStore.has()) {
    return { ok: false, error: 'This needs a Mistral key — add one in Settings. There is no offline fallback for discovering a NEW pattern, since the whole point is Mistral doing the extraction.' }
  }

  try {
    const raw = await generate(`My habit loop, in my own words: "${trimmed}"`, {
      system: SYSTEM, temperature: 0.6, maxTokens: 1400, json: true, signal,
    })
    const parsed = extractJson<RawPattern>(raw)
    if (!parsed) return { ok: false, error: "Mistral's reply wasn't valid JSON. Try rephrasing, or try again." }
    const pattern = buildPatternFromRaw(parsed, trimmed)
    if (!pattern) return { ok: false, error: 'Mistral proposed a pattern that failed validation (bad flag/action shape or scenario mismatch). Try rephrasing your description to be more concrete.' }
    // Double-check every scenario against the engine's own scenario validator
    // as a second, independent gate before this pattern is ever used.
    for (const s of pattern.scenarios) {
      if (!isValidScenario(s, pattern)) return { ok: false, error: 'A generated scenario referenced a flag outside the pattern\'s own vocabulary. Try again.' }
    }
    return { ok: true, pattern }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if (e instanceof MistralError) return { ok: false, error: e.message }
    throw e
  }
}

/** Mark one scenario as user-confirmed (or corrected) — it now counts as real ground truth. */
export function confirmScenario(pattern: Pattern, scenarioId: string, correctedExpectedFire?: boolean): Pattern {
  return {
    ...pattern,
    scenarios: pattern.scenarios.map((s) =>
      s.id === scenarioId
        ? { ...s, verified: true, expectedFire: correctedExpectedFire ?? s.expectedFire }
        : s,
    ),
  }
}

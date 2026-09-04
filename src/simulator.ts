import type { Agent, Pattern, Scenario, MatchTrace, PredictionResult } from './types'
import { generate, MistralError, extractJson } from './mistral'
import { keyStore } from './store'
import { matchScenario, isValidScenario, describeCondition, formatClock } from './engine'

/**
 * The Day Simulator's job now: PICK a scenario, run it through the
 * deterministic engine (matchScenario — always, regardless of key), and
 * optionally dress the result with Mistral-generated narration. Mistral is
 * NEVER asked to decide whether the rule fires — that is engine.ts's job,
 * unconditionally. This file only decides which scenario to run next and how
 * to narrate an already-known, already-correct result.
 */

export type NarratedResult = {
  scenario: Scenario
  trace: MatchTrace
  /** flavor text describing the scene, written to match the deterministic trace */
  sceneNarration: string
  /** flavor text explaining WHY the trace came out this way, in plain language */
  explainNarration: string
  live: boolean
  fallbackReason?: string
}

/** Pick the next scenario for this agent: first any un-run authored scenario, else a random one to re-test. */
export function pickNextScenario(pattern: Pattern, runScenarioIds: Set<string>): Scenario {
  const unrun = pattern.scenarios.find((s) => !runScenarioIds.has(s.id))
  if (unrun) return unrun
  return pattern.scenarios[Math.floor(Math.random() * pattern.scenarios.length)]
}

function scriptedExplain(rules_trace: MatchTrace, pattern: Pattern): string {
  const parts: string[] = []
  for (const c of rules_trace.conditions) {
    parts.push(`condition "${describeCondition(c.condition, pattern.flags)}" was ${c.met ? 'TRUE' : 'FALSE'}`)
  }
  for (const e of rules_trace.exceptions) {
    parts.push(`exception "${describeCondition(e.condition, pattern.flags)}" was ${e.met ? 'TRUE (suppresses firing)' : 'FALSE'}`)
  }
  const verdict = rules_trace.fired
    ? `All conditions held and no exception fired, so the agent fired${rules_trace.actionId ? ` (action: ${pattern.actions.find((a) => a.id === rules_trace.actionId)?.label ?? rules_trace.actionId})` : ''}.`
    : 'The agent did not fire, because ' + (rules_trace.conditions.some((c) => !c.met) ? 'at least one condition was false' : 'an exception suppressed it') + '.'
  return `${parts.join('; ')}. ${verdict}`
}

/**
 * Run one scenario through the deterministic engine and attach narration.
 * The trace (and therefore the verdict) is identical whether or not a key is
 * present — only the flavor text differs.
 */
export async function runScenario(agent: Agent, pattern: Pattern, scenario: Scenario, signal?: AbortSignal): Promise<NarratedResult> {
  const trace = matchScenario(agent.rules, scenario)

  if (!keyStore.has()) {
    return { scenario, trace, sceneNarration: scenario.sceneText, explainNarration: scriptedExplain(trace, pattern), live: false }
  }

  const system = `You narrate the result of a deterministic rule check for a habit-agent training tool, for engineering students.
You are given the EXACT verdict already computed by code — you must not change it, only explain it clearly and naturally.
Output STRICT JSON: { "sceneNarration": "2-3 sentences, present tense, second person, concrete detail, based on the given scene", "explainNarration": "2-3 sentences explaining in plain language why the trace came out this way, referencing the actual condition values given" }
Do not invent a different outcome. Do not moralise. Plain, direct language.`

  const prompt = `Pattern: ${pattern.title} — ${pattern.trigger} -> ${pattern.routine}
Base scene: ${scenario.sceneText}
Trace (already decided, do not change): fired=${trace.fired}, conditions=${JSON.stringify(trace.conditions.map((c) => ({ desc: describeCondition(c.condition, pattern.flags), met: c.met })))}, exceptions=${JSON.stringify(trace.exceptions.map((e) => ({ desc: describeCondition(e.condition, pattern.flags), met: e.met })))}, action=${trace.actionId ? pattern.actions.find((a) => a.id === trace.actionId)?.label : 'none'}
Time: ${formatClock(scenario.clockMin)}`

  try {
    const raw = await generate(prompt, { system, temperature: 0.7, maxTokens: 400, json: true, signal })
    const parsed = extractJson<{ sceneNarration: string; explainNarration: string }>(raw)
    if (!parsed?.sceneNarration || !parsed?.explainNarration) {
      return { scenario, trace, sceneNarration: scenario.sceneText, explainNarration: scriptedExplain(trace, pattern), live: false, fallbackReason: "Mistral's reply wasn't usable, showing the scripted explanation instead." }
    }
    return { scenario, trace, sceneNarration: parsed.sceneNarration, explainNarration: parsed.explainNarration, live: true }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if (e instanceof MistralError) {
      return { scenario, trace, sceneNarration: scenario.sceneText, explainNarration: scriptedExplain(trace, pattern), live: false, fallbackReason: e.message }
    }
    throw e
  }
}

/** Ask Mistral for a fresh, structured stress scenario; validated before use. Falls back to a random authored scenario. */
export async function proposeStressScenario(pattern: Pattern, signal?: AbortSignal): Promise<{ scenario: Scenario; live: boolean; fallbackReason?: string }> {
  const fallback = () => pattern.scenarios[Math.floor(Math.random() * pattern.scenarios.length)]

  if (!keyStore.has()) {
    return { scenario: fallback(), live: false }
  }

  const flagList = pattern.flags.map((f) => `- "${f.id}": ${f.label}`).join('\n')
  const system = `You design ONE new test scenario for a deterministic habit-agent engine, for engineering students.
The ONLY flags you may use are:
${flagList}
Output STRICT JSON exactly: { "title": "short title", "sceneText": "2-3 sentences, present tense, second person", "clockMin": number (0-1439, minutes since midnight), "dayOfWeek": number (0=Sun..6=Sat), "flags": { "<flagId>": true|false, ... every flag above must be present ... }, "expectedFire": true|false }
Make it a genuinely tricky edge case, different from an obvious normal case. You decide expectedFire based on what a well-designed agent for "${pattern.title}" (trigger: ${pattern.trigger}, routine: ${pattern.routine}) should reasonably do.`

  try {
    const raw = await generate(`Design one stress scenario for: ${pattern.title}`, { system, temperature: 0.9, maxTokens: 400, json: true, signal })
    const parsed = extractJson<Record<string, unknown>>(raw)
    if (!parsed) return { scenario: fallback(), live: false, fallbackReason: "Mistral's reply wasn't valid JSON." }
    const candidate = {
      id: `mistral-${Date.now()}`,
      patternId: pattern.id,
      kind: 'stress' as const,
      fromMistral: true,
      ...parsed,
    }
    if (!isValidScenario(candidate, pattern)) {
      return { scenario: fallback(), live: false, fallbackReason: 'Mistral proposed a scenario using an unknown flag or out-of-range value.' }
    }
    return { scenario: candidate as Scenario, live: true }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if (e instanceof MistralError) return { scenario: fallback(), live: false, fallbackReason: e.message }
    throw e
  }
}

export type { PredictionResult }

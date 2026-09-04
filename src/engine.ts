import type { Condition, RuleSet, Scenario, MatchTrace, PredictionResult, RegressionCheck, ActionSpec, FlagSpec } from './types'

/**
 * The deterministic agent runtime. This is the whole point of the rebuild:
 * whether a rule fires is decided HERE, by mechanical condition matching
 * against a scenario's structured world-state — never by an LLM.
 *
 * Hard invariant: this module is pure and synchronous. No `fetch`, no
 * `Promise`, no imports beyond `type`-only from `./types`. Mistral may
 * PROPOSE a Scenario or a RuleSet edit elsewhere in the app, but only this
 * file decides what actually happens with it.
 */

/** Evaluate one Condition against a scenario's world-state. Pure, total, never throws. */
export function evaluateCondition(condition: Condition, scenario: Scenario): boolean {
  switch (condition.type) {
    case 'time-in-range': {
      const { fromMin, toMin } = condition
      const t = scenario.clockMin
      // Wraps past midnight when fromMin > toMin, e.g. 23:30–02:00.
      if (fromMin <= toMin) return t >= fromMin && t <= toMin
      return t >= fromMin || t <= toMin
    }
    case 'day-of-week':
      return condition.days.includes(scenario.dayOfWeek)
    case 'flag':
      return (scenario.flags[condition.flag] ?? false) === condition.equals
  }
}

/** Run the full rule set against one scenario. This IS the agent. */
export function matchScenario(rules: RuleSet, scenario: Scenario): MatchTrace {
  const conditions = rules.conditions.map((condition) => ({ condition, met: evaluateCondition(condition, scenario) }))
  const exceptions = rules.exceptions.map((condition) => ({ condition, met: evaluateCondition(condition, scenario) }))

  const allConditionsMet = conditions.length > 0 && conditions.every((c) => c.met)
  const anyExceptionMet = exceptions.some((e) => e.met)
  const fired = allConditionsMet && !anyExceptionMet

  return { conditions, exceptions, fired, actionId: fired ? rules.actionId || null : null }
}

/** Compare the engine's fired/not-fired against the user's stated prediction. */
export function scorePrediction(trace: MatchTrace, userPredictedFire: boolean): PredictionResult {
  if (trace.fired === userPredictedFire) return 'correct'
  return trace.fired ? 'over-fired' : 'missed'
}

/** Score the agent against the scenario's authored ground truth, not the learner's guess. */
export function scoreAgent(trace: MatchTrace, expectedFire: boolean): PredictionResult {
  if (trace.fired === expectedFire) return 'correct'
  return trace.fired ? 'over-fired' : 'missed'
}

/** Run a rule set against every scenario in a list — used for regression replay. */
export function replayAll(rules: RuleSet, scenarios: Scenario[]): { scenario: Scenario; trace: MatchTrace }[] {
  return scenarios.map((scenario) => ({ scenario, trace: matchScenario(rules, scenario) }))
}

/**
 * Regression gate: given the set of scenarios the CURRENT rules already get
 * right (trace.fired === scenario.expectedFire, tracked via the agent's own
 * run history), replay every one of them under the PROPOSED rules and flag
 * any that flip from correct to incorrect. This is what "don't let an
 * accepted evolution silently break something that used to work" means.
 */
export function checkRegression(
  proposedRules: RuleSet,
  priorScenarios: Scenario[],
  previouslyCorrectScenarioIds: Set<string>,
): RegressionCheck[] {
  return priorScenarios.map((scenario) => {
    const passedBefore = previouslyCorrectScenarioIds.has(scenario.id)
    const afterTrace = matchScenario(proposedRules, scenario)
    const passedAfter = afterTrace.fired === scenario.expectedFire
    return { scenarioId: scenario.id, passedBefore, passedAfter }
  })
}

/** Validate a Scenario-shaped object against a pattern's known flag vocabulary. */
export function isValidScenario(candidate: unknown, pattern: { flags: FlagSpec[] }): candidate is Scenario {
  if (!candidate || typeof candidate !== 'object') return false
  const c = candidate as Record<string, unknown>
  if (typeof c.title !== 'string' || typeof c.sceneText !== 'string') return false
  if (typeof c.clockMin !== 'number' || c.clockMin < 0 || c.clockMin > 1439) return false
  if (typeof c.dayOfWeek !== 'number' || c.dayOfWeek < 0 || c.dayOfWeek > 6) return false
  if (typeof c.expectedFire !== 'boolean') return false
  if (!c.flags || typeof c.flags !== 'object') return false
  const knownFlagIds = new Set(pattern.flags.map((f) => f.id))
  const flags = c.flags as Record<string, unknown>
  for (const [key, value] of Object.entries(flags)) {
    if (!knownFlagIds.has(key) || typeof value !== 'boolean') return false
  }
  return true
}

function isValidCondition(candidate: unknown, knownFlagIds: Set<string>): candidate is Condition {
  if (!candidate || typeof candidate !== 'object') return false
  const c = candidate as Record<string, unknown>
  if (c.type === 'time-in-range') {
    return typeof c.fromMin === 'number' && typeof c.toMin === 'number' && c.fromMin >= 0 && c.fromMin <= 1439 && c.toMin >= 0 && c.toMin <= 1439
  }
  if (c.type === 'day-of-week') {
    return Array.isArray(c.days) && (c.days as unknown[]).every((d) => typeof d === 'number' && d >= 0 && d <= 6)
  }
  if (c.type === 'flag') {
    return typeof c.flag === 'string' && knownFlagIds.has(c.flag) && typeof c.equals === 'boolean'
  }
  return false
}

/** Validate a RuleSet-shaped object against a pattern's known flag/action vocabulary. */
export function isValidRuleSet(candidate: unknown, pattern: { flags: FlagSpec[]; actions: ActionSpec[] }): candidate is RuleSet {
  if (!candidate || typeof candidate !== 'object') return false
  const c = candidate as Record<string, unknown>
  if (!Array.isArray(c.conditions) || !Array.isArray(c.exceptions)) return false
  const knownFlagIds = new Set(pattern.flags.map((f) => f.id))
  const knownActionIds = new Set(pattern.actions.map((a) => a.id))
  if (!c.conditions.every((cond) => isValidCondition(cond, knownFlagIds))) return false
  if (!c.exceptions.every((cond) => isValidCondition(cond, knownFlagIds))) return false
  if (typeof c.actionId !== 'string' || !knownActionIds.has(c.actionId)) return false
  return true
}

/** Format minutes-since-midnight as "HH:MM" for display. */
export function formatClock(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Human-readable summary of one condition, for the Reveal trace and rule summaries. */
export function describeCondition(condition: Condition, flags: FlagSpec[]): string {
  switch (condition.type) {
    case 'time-in-range':
      return `time is between ${formatClock(condition.fromMin)} and ${formatClock(condition.toMin)}`
    case 'day-of-week':
      return `day is ${condition.days.map((d) => DAY_NAMES[d]).join('/')}`
    case 'flag': {
      const label = flags.find((f) => f.id === condition.flag)?.label ?? condition.flag
      return condition.equals ? label : `NOT (${label})`
    }
  }
}

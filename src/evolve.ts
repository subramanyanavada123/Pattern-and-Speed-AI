import type { Agent, Pattern, PredictionResult, EvolutionEntry, RuleSet, Condition } from './types'
import { generate, MistralError, extractJson } from './mistral'
import { keyStore } from './store'
import { checkRegression, isValidRuleSet, describeCondition } from './engine'

/**
 * The return-loop engine. After a Predict/Reveal run, Mistral (or a scripted
 * fallback with no key) proposes ONE structured edit to ONE field of the
 * rule set — never prose. The proposal is validated against the pattern's
 * fixed vocabulary and regression-checked against every scenario the agent
 * has previously run, BEFORE it is ever shown as acceptable. The engine
 * decides safety; Mistral only proposes.
 */

const OUTCOME_LABEL: Record<PredictionResult, string> = {
  correct: 'The prediction was correct — the agent fired exactly when it should have (or correctly stayed quiet).',
  missed: 'The agent should have fired here but did not — it missed a real case.',
  'over-fired': 'The agent fired here but should not have — it is over-triggering.',
}

function ruleSetSystemPrompt(pattern: Pattern): string {
  const flagList = pattern.flags.map((f) => `- flag "${f.id}": ${f.label}`).join('\n')
  const actionList = pattern.actions.map((a) => `- action "${a.id}": ${a.label} — ${a.description}`).join('\n')
  return `You maintain a person's self-built habit agent as a STRUCTURED rule set (never prose).
Given the latest scenario outcome, propose exactly ONE surgical edit to ONE field: "conditions", "exceptions", or "actionId".

The ONLY flags this pattern may reference:
${flagList}

The ONLY actions this pattern may reference:
${actionList}

Output STRICT JSON:
{
  "field": "conditions" | "exceptions" | "actionId",
  "conditions": [ { "type": "flag", "flag": "<id>", "equals": true|false } | { "type": "time-in-range", "fromMin": number, "toMin": number } | { "type": "day-of-week", "days": [0-6] } ],
  "exceptions": [ ...same shape as conditions... ],
  "actionId": "<one of the action ids above>",
  "rationale": "one sentence: what in the outcome forced this change"
}
Only include the array/value for the field you are changing; still include the OTHER current fields unchanged so the full rule set is valid.
Heuristics:
- "over-fired" -> the agent over-fires: narrow conditions (add one) OR add an exception. Never loosen.
- "missed" -> the agent had no hook: broaden conditions (remove one) OR add a missing condition that should have matched.
- "correct" -> minor reinforcement only if truly needed; usually propose no change (still return valid JSON, but keep fields identical).
Keep the edit small — one array entry added, removed, or changed. No wholesale rewrites.`
}

export async function proposeEvolution(
  agent: Agent,
  pattern: Pattern,
  scenarioId: string,
  predictionResult: PredictionResult,
  previouslyCorrectScenarioIds: Set<string>,
  signal?: AbortSignal,
): Promise<EvolutionEntry> {
  if (!keyStore.has()) {
    return scriptedEvolution(agent, pattern, scenarioId, predictionResult, previouslyCorrectScenarioIds)
  }

  const prompt = `Pattern: ${pattern.title}
Agent v${agent.version} current rules:
- conditions: ${JSON.stringify(agent.rules.conditions)}
- exceptions: ${JSON.stringify(agent.rules.exceptions)}
- actionId: ${agent.rules.actionId}

Latest outcome: ${OUTCOME_LABEL[predictionResult]}

Propose the one edit.`

  try {
    const raw = await generate(prompt, { system: ruleSetSystemPrompt(pattern), temperature: 0.4, maxTokens: 500, json: true, signal })
    const parsed = extractJson<{ field: string; conditions?: Condition[]; exceptions?: Condition[]; actionId?: string; rationale?: string }>(raw)
    const field = parsed?.field
    if (!parsed || (field !== 'conditions' && field !== 'exceptions' && field !== 'actionId')) {
      return scriptedFallbackWithReason(agent, pattern, scenarioId, predictionResult, previouslyCorrectScenarioIds, "Mistral's reply wasn't usable")
    }
    const candidateRules: RuleSet = {
      conditions: parsed.conditions ?? agent.rules.conditions,
      exceptions: parsed.exceptions ?? agent.rules.exceptions,
      actionId: parsed.actionId ?? agent.rules.actionId,
    }
    if (!isValidRuleSet(candidateRules, pattern)) {
      return scriptedFallbackWithReason(agent, pattern, scenarioId, predictionResult, previouslyCorrectScenarioIds, "Mistral proposed a rule using an unknown flag or action")
    }
    return buildEntry(agent, pattern, scenarioId, predictionResult, field, candidateRules, parsed.rationale || 'Mistral proposed this edit from the outcome.', true, previouslyCorrectScenarioIds)
  } catch (e) {
    if (e instanceof MistralError) {
      return scriptedFallbackWithReason(agent, pattern, scenarioId, predictionResult, previouslyCorrectScenarioIds, `Mistral call failed (${e.message})`)
    }
    throw e
  }
}

function scriptedFallbackWithReason(
  agent: Agent, pattern: Pattern, scenarioId: string, predictionResult: PredictionResult,
  previouslyCorrectScenarioIds: Set<string>, reason: string,
): EvolutionEntry {
  const entry = scriptedEvolution(agent, pattern, scenarioId, predictionResult, previouslyCorrectScenarioIds)
  entry.rationale = `${reason}, so this edit was scripted instead. ${entry.rationale}`
  return entry
}

function buildEntry(
  agent: Agent, pattern: Pattern, scenarioId: string, predictionResult: PredictionResult,
  field: EvolutionEntry['field'], ruleAfter: RuleSet, rationale: string, fromMistral: boolean,
  previouslyCorrectScenarioIds: Set<string>,
): EvolutionEntry {
  const regression = checkRegression(ruleAfter, pattern.scenarios, previouslyCorrectScenarioIds)
  return {
    at: Date.now(),
    scenarioId,
    predictionResult,
    field,
    ruleBefore: agent.rules,
    ruleAfter,
    rationale,
    fromMistral,
    regression,
  }
}

/** Deterministic, no-key fallback: makes one small, explainable structural edit. */
function scriptedEvolution(
  agent: Agent, pattern: Pattern, scenarioId: string, predictionResult: PredictionResult,
  previouslyCorrectScenarioIds: Set<string>,
): EvolutionEntry {
  const rules = agent.rules
  let field: EvolutionEntry['field'] = 'conditions'
  let ruleAfter: RuleSet = rules
  let rationale = 'No change proposed — nothing safe to adjust automatically.'

  if (predictionResult === 'over-fired') {
    // Narrow: add an unused flag-as-exception if one exists that isn't already an exception.
    const usedFlagIds = new Set([...rules.conditions, ...rules.exceptions].flatMap((c) => (c.type === 'flag' ? [c.flag] : [])))
    const candidateFlag = pattern.flags.find((f) => !usedFlagIds.has(f.id))
    if (candidateFlag) {
      field = 'exceptions'
      ruleAfter = { ...rules, exceptions: [...rules.exceptions, { type: 'flag', flag: candidateFlag.id, equals: true }] }
      rationale = `Over-fired, so added "${describeCondition({ type: 'flag', flag: candidateFlag.id, equals: true }, pattern.flags)}" as a new exception to narrow when this fires.`
    } else {
      field = 'actionId'
      const gentler = pattern.actions.find((a) => a.id !== rules.actionId) ?? pattern.actions[0]
      ruleAfter = { ...rules, actionId: gentler.id }
      rationale = `Over-fired and every flag is already used — switched the action to "${gentler.label}" as a gentler alternative.`
    }
  } else if (predictionResult === 'missed') {
    // Broaden: drop the last condition if there is more than one, so the rule is easier to satisfy.
    if (rules.conditions.length > 1) {
      field = 'conditions'
      const dropped = rules.conditions[rules.conditions.length - 1]
      ruleAfter = { ...rules, conditions: rules.conditions.slice(0, -1) }
      rationale = `Missed a case it should have caught — removed the condition "${describeCondition(dropped, pattern.flags)}" so the rule is easier to satisfy.`
    } else if (rules.exceptions.length > 0) {
      field = 'exceptions'
      const dropped = rules.exceptions[rules.exceptions.length - 1]
      ruleAfter = { ...rules, exceptions: rules.exceptions.slice(0, -1) }
      rationale = `Missed a case — removed the exception "${describeCondition(dropped, pattern.flags)}" that was blocking it.`
    } else {
      rationale = 'Missed a case, but there is only one condition and no exceptions left to loosen — this needs a manual look at the Build screen.'
    }
  } else {
    rationale = 'This run was correct — no change needed. The agent already handles this case.'
  }

  return buildEntry(agent, pattern, scenarioId, predictionResult, field, ruleAfter, rationale, false, previouslyCorrectScenarioIds)
}

export function predictionMeta(p: PredictionResult): { label: string; glyph: string; tone: string } {
  switch (p) {
    case 'correct': return { label: 'Correct', glyph: '✓', tone: 'good' }
    case 'over-fired': return { label: 'Over-fired', glyph: '≈', tone: 'warn' }
    case 'missed': return { label: 'Missed', glyph: '✕', tone: 'bad' }
  }
}

import type { Agent, Pattern, CheckinOutcome, EvolutionEntry } from './types'
import { generate, MistralError, extractJson } from './mistral'
import { keyStore } from './store'

/**
 * The return-loop engine. A real-world check-in ("did your agent fire?") is fed
 * back, and Mistral proposes a concrete rewrite to ONE rule of the agent. The user
 * accepts or declines. Each accepted rewrite bumps the agent's version — the
 * visible "my agent is getting smarter" progression that brings people back.
 */

const SYSTEM = `You maintain a person's self-built habit "agent" (perceive / decide / act / learn rules).
Given the latest real-world outcome, propose exactly ONE surgical edit to ONE rule.

Output STRICT JSON:
{
  "field": "perceive" | "decide" | "act" | "learn",
  "before": "the current text of that rule, verbatim",
  "after": "the rewritten rule - concrete, still one sentence or two, clearly a small delta from before",
  "why": "one sentence: what in the outcome forced this change"
}

Heuristics:
- outcome "fired-annoyed" -> the agent over-fires: narrow 'perceive' OR gentle 'act'. Never strengthen.
- outcome "missed" -> the agent had no hook: add a concrete sense to 'perceive', or add the IF/THEN to 'decide'.
- outcome "fired-helped" -> reinforce: tighten wording, add the exception it's still missing, or extend 'act' slightly.
- outcome "not-needed" -> the loop was quiet: usually adjust 'learn' to watch for drift, keep other rules stable.
Keep 'after' recognisably close to 'before'. No wholesale rewrites.`

const OUTCOME_LABEL: Record<CheckinOutcome, string> = {
  'fired-helped': 'The agent fired and it genuinely helped.',
  'fired-annoyed': 'The agent fired but it annoyed me / felt heavy.',
  missed: 'The loop ran and the agent did nothing.',
  'not-needed': "The loop didn't come up today.",
}

export async function proposeEvolution(
  agent: Agent,
  pattern: Pattern,
  outcome: CheckinOutcome,
  note: string,
  signal?: AbortSignal,
): Promise<EvolutionEntry> {
  if (!keyStore.has()) {
    return scriptedEvolution(agent, outcome, note)
  }

  const prompt = `Pattern: ${pattern.title} (${pattern.trigger} -> ${pattern.routine} -> ${pattern.reward})
Agent v${agent.version}:
- perceive: ${agent.perceive}
- decide: ${agent.decide}
- act: ${agent.act}
- learn: ${agent.learn}

Latest outcome: ${OUTCOME_LABEL[outcome]}
User's note: ${note || '(none)'}

Propose the one edit.`

  try {
    const raw = await generate(prompt, { system: SYSTEM, temperature: 0.5, maxTokens: 500, json: true, signal })
    const parsed = extractJson<{ field: string; before: string; after: string; why: string }>(raw)
    if (!parsed || !['perceive', 'decide', 'act', 'learn'].includes(parsed.field) || !parsed.after) {
      const fallback = scriptedEvolution(agent, outcome, note)
      fallback.note = `Mistral's reply wasn't usable, so this edit was scripted instead. ${fallback.note}`
      return fallback
    }
    const field = parsed.field as EvolutionEntry['field']
    return {
      at: Date.now(),
      outcome,
      note: parsed.why || note,
      ruleBefore: agent[field] || parsed.before || '',
      ruleAfter: parsed.after.trim(),
      field,
      fromMistral: true,
    }
  } catch (e) {
    if (e instanceof MistralError) {
      const fallback = scriptedEvolution(agent, outcome, note)
      fallback.note = `Mistral call failed (${e.message}), so this edit was scripted instead. ${fallback.note}`
      return fallback
    }
    throw e
  }
}

function scriptedEvolution(agent: Agent, outcome: CheckinOutcome, note: string): EvolutionEntry {
  let field: EvolutionEntry['field'] = 'learn'
  let after = agent.learn

  if (outcome === 'fired-annoyed') {
    field = 'act'
    after = `${agent.act} — but only the gentlest version; if it already fired once today, skip it.`
  } else if (outcome === 'missed') {
    field = 'perceive'
    after = `${agent.perceive}${agent.perceive ? '; also' : 'Watch for'} the earliest concrete sign — a specific time on the clock, or an object in the wrong place.`
  } else if (outcome === 'fired-helped') {
    field = 'decide'
    after = /exception/i.test(agent.decide)
      ? agent.decide
      : `${agent.decide} EXCEPTION: if this is a genuine one-off need, allow it and note why.`
  } else {
    field = 'learn'
    after = `${agent.learn} If three quiet days pass, re-check the trigger is still relevant.`
  }

  return {
    at: Date.now(),
    outcome,
    note: note || 'Scripted adjustment (no Mistral key).',
    ruleBefore: agent[field] || '',
    ruleAfter: after.trim(),
    field,
    fromMistral: false,
  }
}

export function outcomeMeta(o: CheckinOutcome): { label: string; glyph: string; tone: string } {
  switch (o) {
    case 'fired-helped': return { label: 'Fired · helped', glyph: '✓', tone: 'good' }
    case 'fired-annoyed': return { label: 'Fired · annoyed me', glyph: '≈', tone: 'warn' }
    case 'missed': return { label: 'Missed it', glyph: '✕', tone: 'bad' }
    case 'not-needed': return { label: "Didn't come up", glyph: '·', tone: 'mute' }
  }
}

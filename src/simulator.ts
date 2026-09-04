import type { Agent, Pattern, SimEvent } from './types'
import { stream, generate, MistralError, extractJson } from './mistral'
import { keyStore } from './store'

/**
 * The Day Simulator — the flagship "see a real agent in action" experience.
 *
 * Mistral role-plays a slice of the user's real day as a live feed. Triggers fire.
 * The user's configured agent (the perceive/decide/act rules THEY wrote) is
 * injected and auto-responds. The user watches perceive -> decide -> act -> outcome,
 * then a debrief that names which rule was weak.
 *
 * With no key: a scripted simulation still plays, using the user's own rule text,
 * so the mechanic is fully understandable offline.
 */

const SIM_SYSTEM = `You are a friendly simulation engine for a pattern-recognition class for young learners.
You role-play a realistic slice of a student's day where a repeating loop is about to happen, then you run THEIR self-written helper against it and explain what happens.

Output STRICT JSON, no prose outside it, shaped exactly:
{
  "scene": "2-3 sentences, present tense, concrete sensory detail, second person. Set the moment just before the loop fires.",
  "trigger": "one sentence: the exact instant the loop's cue lands.",
  "perceive": "one sentence: what the agent, using the user's perceive rule, actually notices here (or fails to notice).",
  "decide": "one sentence: the rule the agent applies, quoting the user's decide rule, and what it resolves to.",
  "act": "one sentence: the concrete move the agent makes, from the user's act rule.",
  "outcome": "2 sentences: what the person does next as a result. Be honest - if the rule is weak, the loop wins. If it's good but the person resists, show that too.",
  "debrief": "2 sentences: name the single weakest rule (perceive/decide/act) by name and say the one change that would most improve the next run.",
  "verdict": "one of: fired-helped | fired-annoyed | missed"
}
Be specific, curious, and kind. No moralising. No lists. Use plain language a 10-14 year old can follow.`

export type SimResult = {
  events: SimEvent[]
  verdict: 'fired-helped' | 'fired-annoyed' | 'missed'
  debrief: string
  live: boolean
  /** set when we wanted to run live but had to fall back — surfaced to the user instead of hidden */
  fallbackReason?: string
}

function ts(): string {
  const d = new Date()
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function specBlock(agent: Agent, pattern: Pattern, twist: string): string {
  return `THE LOOP: ${pattern.title}
Real texture: ${pattern.scene}
Cue: ${pattern.trigger} | Routine: ${pattern.routine} | Reward: ${pattern.reward} | Cost: ${pattern.cost}
${twist ? `Today's twist the user asked for: ${twist}` : ''}

THE USER'S AGENT (run this exactly as written, do not improve it):
- Perceive rule: ${agent.perceive || '(the user left this blank)'}
- Decide rule: ${agent.decide || '(the user left this blank)'}
- Act rule: ${agent.act || '(the user left this blank)'}
- Learn rule: ${agent.learn}
`
}

/**
 * Run one simulation. onEvent is called as each beat becomes available so the UI
 * can reveal them one at a time (the "live feed" feel).
 */
export async function runDay(
  agent: Agent,
  pattern: Pattern,
  twist: string,
  onEvent: (e: SimEvent) => void,
  signal?: AbortSignal,
): Promise<SimResult> {
  if (!keyStore.has()) {
    return runScripted(agent, pattern, twist, onEvent)
  }

  const prompt = specBlock(agent, pattern, twist) + '\nRun one full simulation now.'
  let raw = ''
  try {
    for await (const chunk of stream(prompt, { system: SIM_SYSTEM, temperature: 0.9, maxTokens: 2048, json: true, signal })) {
      raw += chunk
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if (e instanceof MistralError) {
      const fallback = runScripted(agent, pattern, twist, onEvent)
      fallback.fallbackReason = e.message
      return fallback
    }
    throw e
  }

  const parsed = extractJson<{
    scene: string; trigger: string; perceive: string; decide: string
    act: string; outcome: string; debrief: string; verdict: SimResult['verdict']
  }>(raw)

  if (!parsed) {
    const fallback = runScripted(agent, pattern, twist, onEvent)
    fallback.fallbackReason = `Mistral's reply wasn't valid JSON, so this run fell back to the scripted version. Raw start: "${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}"`
    return fallback
  }

  const events: SimEvent[] = []
  const order: [SimEvent['kind'], string][] = [
    ['scene', parsed.scene],
    ['trigger', parsed.trigger],
    ['perceive', parsed.perceive],
    ['decide', parsed.decide],
    ['act', parsed.act],
    ['outcome', parsed.outcome],
    ['debrief', parsed.debrief],
  ]
  for (const [kind, text] of order) {
    const e: SimEvent = { kind, text: text ?? '', ts: ts() }
    events.push(e)
    onEvent(e)
    await beat(kind === 'scene' ? 350 : 650, signal)
  }

  const verdict: SimResult['verdict'] =
    parsed.verdict === 'fired-helped' || parsed.verdict === 'fired-annoyed' || parsed.verdict === 'missed'
      ? parsed.verdict
      : 'missed'

  return { events, verdict, debrief: parsed.debrief ?? '', live: true }
}

/** A second-round "you tuned a rule, run it again" call — same shape. */
export async function rerunDay(
  agent: Agent,
  pattern: Pattern,
  previousDebrief: string,
  onEvent: (e: SimEvent) => void,
  signal?: AbortSignal,
): Promise<SimResult> {
  return runDay(agent, pattern, `This is a RE-RUN. Last time the debrief said: "${previousDebrief}". Show whether the user's edits actually helped.`, onEvent, signal)
}

async function beat(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

// ---- Offline scripted simulation ----

function runScripted(
  agent: Agent,
  pattern: Pattern,
  twist: string,
  onEvent: (e: SimEvent) => void,
): SimResult {
  const vague = /mindful|better choice|try|focus|remember|be good/i
  const perceiveWeak = !agent.perceive || vague.test(agent.perceive)
  const decideWeak = !agent.decide || !/if|when/i.test(agent.decide)
  const actWeak = !agent.act || vague.test(agent.act) || /block|delete|lock|forever|ban/i.test(agent.act)

  let verdict: SimResult['verdict'] = 'fired-helped'
  let weak = 'act'
  if (perceiveWeak) { verdict = 'missed'; weak = 'perceive' }
  else if (decideWeak) { verdict = 'missed'; weak = 'decide' }
  else if (actWeak) { verdict = 'fired-annoyed'; weak = 'act' }

  const events: SimEvent[] = [
    { kind: 'scene', ts: ts(), text: pattern.scene + (twist ? ` (${twist})` : '') },
    { kind: 'trigger', ts: ts(), text: `The cue lands: ${pattern.trigger.toLowerCase()}. The routine — "${pattern.routine}" — is one motion away.` },
    {
      kind: 'perceive', ts: ts(),
      text: perceiveWeak
        ? `Your agent watches for "${agent.perceive || 'nothing specific'}". Nothing observable trips. It stays asleep.`
        : `Your agent checks its sense: "${agent.perceive}". It's true right now. The agent wakes.`,
    },
    {
      kind: 'decide', ts: ts(),
      text: decideWeak
        ? `The decide rule ("${agent.decide || 'blank'}") has no IF/THEN, so there's nothing to resolve. The moment passes to old-you.`
        : `Rule fires: "${agent.decide}". It resolves to one move.`,
    },
    {
      kind: 'act', ts: ts(),
      text: actWeak
        ? `The act — "${agent.act || 'undefined'}" — is too heavy. It works once, then you picture disabling it, and the resistance does the rest.`
        : `The agent does its small thing: "${agent.act}". Five seconds of friction inserted.`,
    },
    {
      kind: 'outcome', ts: ts(),
      text:
        verdict === 'missed'
          ? `The loop runs clean. ${pattern.reward} now, ${pattern.cost} later. The agent never had a hook to grab.`
          : verdict === 'fired-annoyed'
            ? `You comply this time, but you're irritated at your own system. That irritation is a countdown to switching it off.`
            : `You pause. The better path is now the easy one. You take it, a little surprised it worked.`,
    },
    {
      kind: 'debrief', ts: ts(),
      text:
        weak === 'perceive'
          ? `Weakest rule: perceive. Make it something you could photograph — a time on a clock, an object out of place — not a feeling.`
          : weak === 'decide'
            ? `Weakest rule: decide. Rewrite as IF <perceived fact> THEN <one move>, with one named exception.`
            : `Weakest rule: act. Shrink it to a reversible five-second nudge you'd never bother to disable.`,
    },
  ]

  events.forEach(onEvent)
  return { events, verdict, debrief: events[events.length - 1].text, live: false }
}

/** Optional: ask Mistral for a fresh, surprising twist to throw at the agent. */
export async function surpriseTwist(pattern: Pattern): Promise<string> {
  if (!keyStore.has()) {
    const canned = [
      'a friend is texting you through the whole thing',
      "you're travelling and the usual environment cues are missing",
      'you had a genuinely great day, so the loop feels earned',
      "you're exhausted and every decision feels expensive",
    ]
    return canned[Math.floor(Math.random() * canned.length)]
  }
  try {
    return await generate(
      `Give ONE short realistic complication (max 15 words) that would stress-test an agent built to interrupt this loop: "${pattern.title}" (${pattern.trigger} -> ${pattern.routine}). Just the complication, no preamble.`,
      { temperature: 1, maxTokens: 40 },
    )
  } catch {
    return 'the usual environment cues are all different today'
  }
}

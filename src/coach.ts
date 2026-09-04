import type { Agent, Pattern } from './types'
import { generate, MistralError } from './mistral'
import { keyStore } from './store'

/**
 * The Socratic coach. It does NOT give the user the answer — it challenges the
 * spec they wrote, points at the weakest part, and asks one sharp question.
 * Falls back to a scripted critique when there is no key.
 */

const SYSTEM = `You are a terse, sharp coach inside a tool that teaches people to turn bad habit loops into small "agents" (perceive / decide / act / learn).
Your job is Socratic: never hand over a finished answer. Find the single weakest part of what the user wrote and push on it with ONE concrete question or challenge.
Rules:
- 45 words max. No preamble, no "great question", no bullet lists.
- Name the specific weak part ("your perceive step", "the THEN in your rule").
- If a step is vague ("be mindful", "make a better choice"), say so bluntly and ask what the observable version is.
- If it's solid, say which part is strongest and raise the next hardest edge case.
- Second person. Plain language.`

export async function critique(agent: Agent, pattern: Pattern, signal?: AbortSignal): Promise<{ text: string; live: boolean; fallbackReason?: string }> {
  const spec = `Pattern: ${pattern.title} — ${pattern.trigger} -> ${pattern.routine} -> ${pattern.reward} (cost: ${pattern.cost})
User's agent:
- Perceive: ${agent.perceive || '(empty)'}
- Decide: ${agent.decide || '(empty)'}
- Act: ${agent.act || '(empty)'}
- Learn: ${agent.learn || '(empty)'}
- They chose to change the: ${agent.diagnosis || '(not chosen)'}`

  if (!keyStore.has()) {
    return { text: scriptedCritique(agent), live: false }
  }
  try {
    const text = await generate(spec, { system: SYSTEM, temperature: 0.6, maxTokens: 160, signal })
    return { text, live: true }
  } catch (e) {
    if (e instanceof MistralError) return { text: scriptedCritique(agent), live: false, fallbackReason: e.message }
    throw e
  }
}

export async function reply(
  agent: Agent,
  pattern: Pattern,
  history: { role: 'coach' | 'you'; text: string }[],
  userText: string,
  signal?: AbortSignal,
): Promise<{ text: string; live: boolean }> {
  if (!keyStore.has()) {
    return { text: 'Add a Mistral key in Settings to go back and forth with the coach. For now: re-read your weakest step and make it something you could photograph.', live: false }
  }
  const convo = history.map((h) => `${h.role === 'coach' ? 'COACH' : 'USER'}: ${h.text}`).join('\n')
  const prompt = `Pattern: ${pattern.title}
Agent now:
- Perceive: ${agent.perceive}
- Decide: ${agent.decide}
- Act: ${agent.act}
- Learn: ${agent.learn}

Conversation so far:
${convo}
USER: ${userText}

Respond as COACH. Same rules: 45 words, one push, no finished answers.`
  try {
    const text = await generate(prompt, { system: SYSTEM, temperature: 0.6, maxTokens: 160, signal })
    return { text, live: true }
  } catch (e) {
    if (e instanceof MistralError) return { text: `Coach is offline (${e.message}). Keep going without it — tighten one step and move to the simulator.`, live: false }
    throw e
  }
}

function scriptedCritique(agent: Agent): string {
  const vague = /mindful|better choice|try to|be good|focus|remember to/i
  if (!agent.perceive || vague.test(agent.perceive)) {
    return 'Your perceive step is a feeling, not a fact. What is the observable thing — a time, a place, an object out of position — that you could check without being in the loop?'
  }
  if (!agent.decide || !/if|when/i.test(agent.decide)) {
    return 'Your decide step has no IF/THEN shape. Write it as: IF <the thing you perceive> THEN <one move>. What is the one move, exactly?'
  }
  if (!agent.act || vague.test(agent.act)) {
    return 'Your act step is not small or reversible enough to survive a week. What is the five-second version — one piece of friction, one nudge — that you would not switch off?'
  }
  return 'Strongest part is your act. The edge case: what does the agent do the day your perceive condition is true but the pattern genuinely is fine? Name the exception.'
}

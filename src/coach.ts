import type { Agent, Pattern } from './types'
import { generate, MistralError, searchWeb, type Citation } from './mistral'
import { keyStore } from './store'
import { describeCondition } from './engine'

/**
 * The Socratic coach. It does NOT give the user the answer — it challenges the
 * structured rule set they built, points at the weakest part, and asks one
 * sharp question. Falls back to a scripted critique when there is no key.
 */

const SYSTEM = `You are a terse, sharp coach inside a tool that teaches engineering students to turn habit loops into deterministic agents (conditions / exceptions / one action).
Your job is Socratic: never hand over a finished answer. Find the single weakest part of what the user built and push on it with ONE concrete question or challenge.
Rules:
- 45 words max. No preamble, no "great question", no bullet lists.
- Name the specific weak part ("your conditions list", "you have no exception for...").
- If conditions are missing or too broad, say so and ask what would narrow it.
- If it's solid, say which part is strongest and raise the next hardest edge case.
- Second person. Plain language, systems/CS framing is fine for this audience.`

function summariseRules(agent: Agent, pattern: Pattern): string {
  const conds = agent.rules.conditions.length
    ? agent.rules.conditions.map((c) => describeCondition(c, pattern.flags)).join(' AND ')
    : '(no conditions set — this rule can never fire)'
  const excs = agent.rules.exceptions.length
    ? agent.rules.exceptions.map((c) => describeCondition(c, pattern.flags)).join(' OR ')
    : '(none)'
  const action = pattern.actions.find((a) => a.id === agent.rules.actionId)?.label ?? '(no action chosen)'
  return `IF ${conds}\nUNLESS ${excs}\nTHEN ${action}`
}

export async function critique(agent: Agent, pattern: Pattern, signal?: AbortSignal): Promise<{ text: string; live: boolean; fallbackReason?: string }> {
  const spec = `Pattern: ${pattern.title} — ${pattern.trigger} -> ${pattern.routine} -> ${pattern.reward} (cost: ${pattern.cost})
User's agent:
${summariseRules(agent, pattern)}
They chose to change the: ${agent.diagnosis || '(not chosen)'}`

  if (!keyStore.has()) {
    return { text: scriptedCritique(agent, pattern), live: false }
  }
  try {
    const text = await generate(spec, { system: SYSTEM, temperature: 0.6, maxTokens: 160, signal })
    return { text, live: true }
  } catch (e) {
    if (e instanceof MistralError) return { text: scriptedCritique(agent, pattern), live: false, fallbackReason: e.message }
    throw e
  }
}

/**
 * True for questions the coach should ground with a real web search instead
 * of reasoning purely from the prompt — "is this real", "is there research",
 * "what does X actually mean" style asks. Client-side heuristic because
 * chat/completions (what the plain coach conversation uses) doesn't support
 * tool use at all — only the separate Conversations API does — so this
 * decides up front which endpoint to call, rather than the model deciding
 * mid-call.
 */
function needsWebSearch(userText: string): boolean {
  return /\b(research|study|studies|evidence|proof|source|cite|citation|real(ly)?|actual(ly)?|is (this|that) (true|legit)|does this work|works\??$)\b/i.test(userText)
}

export async function reply(
  agent: Agent,
  pattern: Pattern,
  history: { role: 'coach' | 'you'; text: string }[],
  userText: string,
  signal?: AbortSignal,
): Promise<{ text: string; live: boolean; citations?: Citation[] }> {
  if (!keyStore.has()) {
    return { text: 'Add a Mistral key in Settings to go back and forth with the coach. For now: check whether your conditions list is specific enough to avoid over-firing.', live: false }
  }

  if (needsWebSearch(userText)) {
    try {
      const grounded = await searchWeb(
        `In the context of implementation-intention habit research and the pattern "${pattern.title}" (${pattern.trigger} -> ${pattern.routine}), answer briefly and concretely: ${userText}`,
        { maxTokens: 250, signal },
      )
      if (grounded.text) {
        return { text: grounded.text, live: true, citations: grounded.citations }
      }
      // Empty grounded answer — fall through to the normal reasoning path below
      // rather than showing nothing.
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      // Web search failing (wrong model, beta endpoint hiccup, etc.) shouldn't
      // kill the whole coach reply — fall back to the normal ungrounded path.
    }
  }

  const convo = history.map((h) => `${h.role === 'coach' ? 'COACH' : 'USER'}: ${h.text}`).join('\n')
  const prompt = `Pattern: ${pattern.title}
Agent now:
${summariseRules(agent, pattern)}

Conversation so far:
${convo}
USER: ${userText}

Respond as COACH. Same rules: 45 words, one push, no finished answers.`
  try {
    const text = await generate(prompt, { system: SYSTEM, temperature: 0.6, maxTokens: 160, signal })
    return { text, live: true }
  } catch (e) {
    if (e instanceof MistralError) return { text: `Coach is offline (${e.message}). Keep going without it — check your conditions and exceptions against the scenario bank.`, live: false }
    throw e
  }
}

function scriptedCritique(agent: Agent, pattern: Pattern): string {
  if (agent.rules.conditions.length === 0) {
    return 'Your conditions list is empty, so this rule can never fire. Pick at least one flag or time range from the vocabulary that marks the moment this loop starts.'
  }
  if (!agent.rules.actionId) {
    return 'You have not chosen an action. Pick the smallest, most reversible move from the list — the one you would never bother to switch off.'
  }
  if (agent.rules.exceptions.length === 0) {
    return `Strongest part is your conditions. The edge case: is there a flag in "${pattern.flags.map((f) => f.label).join('", "')}" that should suppress this — a genuine exception you have not named yet?`
  }
  return 'Solid shape. Now stress it: pick the scenario in the bank most likely to break this rule and predict what actually happens before you reveal it.'
}

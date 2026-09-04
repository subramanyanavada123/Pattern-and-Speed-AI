import type { SaveState, Agent, Checkin, PartId, CheckinOutcome, EvolutionEntry } from './types'

const SAVE_KEY = 'pattern-machine.save.v2'
const MISTRAL_KEY = 'pattern-machine.mistral-key'
const MODEL_KEY = 'pattern-machine.mistral-model'
// Keep this as a migration fallback only. A newly entered key is validated
// against Mistral's model list before live generation is enabled.
const DEFAULT_MODEL = 'mistral-small-latest'
const DAY = 86_400_000

function blankSave(): SaveState {
  return {
    agents: {},
    activeAgentId: '',
    checkins: [],
    xp: 0,
    completedLessons: [],
    unlockedPatterns: ['scroll', 'gym', 'cart'],
    lastVisit: 0,
    streak: 0,
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / storage disabled — app still works, just no persistence */
  }
}

let state: SaveState = normalise(read<SaveState>(SAVE_KEY, blankSave()))

function normalise(s: SaveState): SaveState {
  const base = blankSave()
  return {
    ...base,
    ...s,
    agents: s.agents ?? {},
    checkins: Array.isArray(s.checkins) ? s.checkins : [],
    completedLessons: Array.isArray(s.completedLessons) ? s.completedLessons : [],
    unlockedPatterns: Array.isArray(s.unlockedPatterns) && s.unlockedPatterns.length ? s.unlockedPatterns : base.unlockedPatterns,
  }
}

// `state` is loaded into memory once per page/tab. If another tab (or a stale
// module instance left over from a hot-reload) writes to localStorage in the
// meantime, a naive `persist()` would blindly overwrite that with our own
// stale in-memory copy and silently lose it. Guard against that: before every
// write, re-read what's actually on disk right now and reconcile.
function persist() {
  state.lastVisit = Date.now()
  const onDisk = read<SaveState>(SAVE_KEY, state)
  state = reconcile(state, onDisk)
  write(SAVE_KEY, state)
}

/** Merge two save states favouring whichever side is further along, field by field. */
function reconcile(mine: SaveState, disk: SaveState): SaveState {
  if (disk === mine) return mine
  const agents: SaveState['agents'] = { ...disk.agents }
  for (const [id, agent] of Object.entries(mine.agents)) {
    const other = agents[id]
    // keep whichever copy of this agent has evolved further / more recently
    if (!other || agent.version > other.version || (agent.version === other.version && agent.updatedAt > other.updatedAt)) {
      agents[id] = agent
    }
  }
  const checkinKey = (c: Checkin) => `${c.at}:${c.outcome}`
  const seen = new Set<string>()
  const checkins = [...disk.checkins, ...mine.checkins]
    .sort((a, b) => a.at - b.at)
    .filter((c) => {
      const k = checkinKey(c)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  return {
    agents,
    activeAgentId: mine.activeAgentId || disk.activeAgentId,
    checkins,
    xp: Math.max(mine.xp, disk.xp),
    completedLessons: Array.from(new Set([...disk.completedLessons, ...mine.completedLessons])),
    unlockedPatterns: Array.from(new Set([...disk.unlockedPatterns, ...mine.unlockedPatterns])),
    lastVisit: Math.max(mine.lastVisit, disk.lastVisit),
    streak: Math.max(mine.streak, disk.streak),
  }
}

type ExternalChangeListener = () => void
const externalChangeListeners = new Set<ExternalChangeListener>()

/** Called by the UI layer to know when it should re-render because another tab changed the save. */
export function onExternalSave(listener: ExternalChangeListener): () => void {
  externalChangeListeners.add(listener)
  return () => externalChangeListeners.delete(listener)
}

// Pick up changes saved by another tab. `storage` only fires in OTHER tabs of
// the same origin, which is exactly the case a single in-memory `state` can't
// see on its own — refresh ours from disk (reconciling, not clobbering) so two
// open tabs converge instead of silently fighting over the last write.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== SAVE_KEY || event.newValue == null) return
    try {
      const theirs = normalise(JSON.parse(event.newValue) as SaveState)
      state = reconcile(state, theirs)
      externalChangeListeners.forEach((fn) => fn())
    } catch {
      /* ignore malformed cross-tab payloads */
    }
  })
}

export const store = {
  get(): SaveState {
    return state
  },

  reset() {
    state = blankSave()
    persist()
  },

  addXp(n: number) {
    state.xp += n
    persist()
  },

  completeLesson(partId: PartId) {
    if (!state.completedLessons.includes(partId)) {
      state.completedLessons.push(partId)
      state.xp += 60
    }
    persist()
  },

  lessonsComplete(): boolean {
    return (['perceive', 'decide', 'act', 'learn'] as PartId[]).every((p) => state.completedLessons.includes(p))
  },

  saveAgent(agent: Agent) {
    agent.updatedAt = Date.now()
    state.agents[agent.patternId] = agent
    state.activeAgentId = agent.patternId
    persist()
  },

  activeAgent(): Agent | null {
    return state.agents[state.activeAgentId] ?? null
  },

  getAgent(patternId: string): Agent | null {
    return state.agents[patternId] ?? null
  },

  unlockPattern(id: string) {
    if (!state.unlockedPatterns.includes(id)) {
      state.unlockedPatterns.push(id)
      persist()
    }
  },

  isUnlocked(id: string): boolean {
    return state.unlockedPatterns.includes(id)
  },

  /** Record a real-world check-in, update streak, return the streak. */
  addCheckin(outcome: CheckinOutcome, note: string): number {
    const now = Date.now()
    const last = state.checkins[state.checkins.length - 1]
    const checkin: Checkin = { at: now, outcome, note }
    state.checkins.push(checkin)

    if (!last) {
      state.streak = 1
    } else {
      const gap = now - last.at
      if (gap <= 2 * DAY) state.streak += 1
      else state.streak = 1
    }
    persist()
    return state.streak
  },

  /** Apply an evolution: rewrite one field of the active agent, bump version, log it. */
  evolveAgent(entry: EvolutionEntry): Agent | null {
    const agent = this.activeAgent()
    if (!agent) return null
    ;(agent as unknown as Record<string, string>)[entry.field] = entry.ruleAfter
    agent.version += 1
    agent.history.push(entry)
    agent.updatedAt = Date.now()
    state.agents[agent.patternId] = agent
    state.xp += 40
    persist()
    return agent
  },

  /** Days since last visit, for the "welcome back" beat. */
  daysAway(): number {
    if (!state.lastVisit) return 0
    return Math.floor((Date.now() - state.lastVisit) / DAY)
  },

  checkinsLast(n: number): Checkin[] {
    return state.checkins.slice(-n)
  },
}

export function newAgent(patternId: string): Agent {
  return {
    patternId,
    perceive: '',
    decide: '',
    act: '',
    learn: 'When an outcome comes in, adjust one part of me: narrow the trigger if I annoyed you, gentle the action if I over-fired, add a sense if I missed.',
    diagnosis: '',
    version: 1,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ---- Mistral key (BYO, browser-only) ----

export const keyStore = {
  get(): string {
    return read<string>(MISTRAL_KEY, '')
  },
  set(k: string) {
    write(MISTRAL_KEY, k.trim())
  },
  clear() {
    try {
      localStorage.removeItem(MISTRAL_KEY)
    } catch {
      /* noop */
    }
  },
  has(): boolean {
    return this.get().length > 20
  },
  model(): string {
    return read<string>(MODEL_KEY, '') || DEFAULT_MODEL
  },
  setModel(m: string) {
    write(MODEL_KEY, m)
  },
}

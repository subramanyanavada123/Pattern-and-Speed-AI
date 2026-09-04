import type { SaveState, Agent, PartId, EvolutionEntry, RuleSet, ScenarioRun } from './types'

const SAVE_KEY = 'pattern-machine.save.v3'
const OLD_SAVE_KEY = 'pattern-machine.save.v2'
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
    xp: 0,
    completedLessons: [],
    unlockedPatterns: ['scroll', 'gym', 'cart'],
    lastVisit: 0,
    streak: 0,
    sawMigrationNotice: false,
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

/**
 * v2 agents stored freeform prose (perceive/decide/act/learn strings) — there
 * is no faithful way to turn prose into structured conditions, so agents are
 * NOT carried forward. What IS safely portable (lesson completion, XP,
 * unlocked patterns, streak) is preserved. `migratedFromV2` flags this run so
 * the UI can show a one-time honest notice instead of silently losing state.
 */
function migrateFromV2(): { save: SaveState; migratedFromV2: boolean } {
  const fresh = blankSave()
  let oldRaw: string | null = null
  try {
    oldRaw = localStorage.getItem(OLD_SAVE_KEY)
  } catch {
    /* noop */
  }
  if (!oldRaw) return { save: fresh, migratedFromV2: false }

  try {
    const old = JSON.parse(oldRaw) as Partial<{
      xp: number
      completedLessons: PartId[]
      unlockedPatterns: string[]
      streak: number
      lastVisit: number
    }>
    const migrated: SaveState = {
      ...fresh,
      xp: typeof old.xp === 'number' ? old.xp : fresh.xp,
      completedLessons: Array.isArray(old.completedLessons) ? old.completedLessons : fresh.completedLessons,
      unlockedPatterns: Array.isArray(old.unlockedPatterns) && old.unlockedPatterns.length ? old.unlockedPatterns : fresh.unlockedPatterns,
      streak: typeof old.streak === 'number' ? old.streak : fresh.streak,
      lastVisit: typeof old.lastVisit === 'number' ? old.lastVisit : fresh.lastVisit,
      sawMigrationNotice: false,
    }
    write(SAVE_KEY, migrated)
    return { save: migrated, migratedFromV2: true }
  } catch {
    return { save: fresh, migratedFromV2: false }
  }
}

function normalise(s: SaveState): SaveState {
  const base = blankSave()
  return {
    ...base,
    ...s,
    agents: s.agents ?? {},
    completedLessons: Array.isArray(s.completedLessons) ? s.completedLessons : [],
    unlockedPatterns: Array.isArray(s.unlockedPatterns) && s.unlockedPatterns.length ? s.unlockedPatterns : base.unlockedPatterns,
  }
}

const existingV3 = read<SaveState | null>(SAVE_KEY, null)
const migration = existingV3 ? { save: existingV3, migratedFromV2: false } : migrateFromV2()
let state: SaveState = normalise(migration.save)
/** True only for this page load, only if a v2 save existed and no v3 save did yet — surfaced once by the UI. */
export const justMigratedFromV2 = migration.migratedFromV2

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
  return {
    agents,
    activeAgentId: mine.activeAgentId || disk.activeAgentId,
    xp: Math.max(mine.xp, disk.xp),
    completedLessons: Array.from(new Set([...disk.completedLessons, ...mine.completedLessons])),
    unlockedPatterns: Array.from(new Set([...disk.unlockedPatterns, ...mine.unlockedPatterns])),
    lastVisit: Math.max(mine.lastVisit, disk.lastVisit),
    streak: Math.max(mine.streak, disk.streak),
    sawMigrationNotice: mine.sawMigrationNotice || disk.sawMigrationNotice,
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

  markMigrationNoticeSeen() {
    state.sawMigrationNotice = true
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

  /** Record one predict/reveal run against the active agent — the objective evidence corpus. */
  recordScenarioRun(run: ScenarioRun): Agent | null {
    const agent = this.activeAgent()
    if (!agent) return null
    agent.scenarioLog.push(run)
    agent.updatedAt = Date.now()
    state.agents[agent.patternId] = agent
    state.xp += run.predictionResult === 'correct' ? 15 : 5
    persist()
    return agent
  },

  /**
   * Apply an accepted, regression-checked evolution: rewrite ONE structured
   * field of the active agent's rules, bump version, log it. Refuses to apply
   * an entry carrying an unacknowledged regression (passedBefore && !passedAfter)
   * as a defensive last line — the UI is expected to gate this too.
   */
  evolveAgent(entry: EvolutionEntry): Agent | null {
    const agent = this.activeAgent()
    if (!agent) return null
    const hasBlockingRegression = entry.regression.some((r) => r.passedBefore && !r.passedAfter)
    if (hasBlockingRegression) return null

    const rules: RuleSet = { ...agent.rules }
    if (entry.field === 'conditions') rules.conditions = entry.ruleAfter.conditions
    else if (entry.field === 'exceptions') rules.exceptions = entry.ruleAfter.exceptions
    else rules.actionId = entry.ruleAfter.actionId

    agent.rules = rules
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
}

export function newAgent(patternId: string): Agent {
  return {
    patternId,
    diagnosis: '',
    rules: { conditions: [], exceptions: [], actionId: '' },
    learnNotes: '',
    version: 1,
    history: [],
    scenarioLog: [],
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

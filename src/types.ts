export type Phase = 'home' | 'choose' | 'decode' | 'build' | 'simulate' | 'evolve'

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** A single atomic, mechanically-checkable fact about a moment — the runtime's only vocabulary. */
export type Condition =
  | { type: 'time-in-range'; fromMin: number; toMin: number } // minutes-since-midnight; wraps past midnight if fromMin > toMin
  | { type: 'day-of-week'; days: DayOfWeek[] }
  | { type: 'flag'; flag: string; equals: boolean }

/** Declares one boolean context flag a pattern's scenarios can set and rules can check. */
export type FlagSpec = {
  id: string
  label: string
  defaultValue: boolean
}

/** One reversible action the agent can take. A small fixed enum per pattern. */
export type ActionSpec = {
  id: string
  label: string
  description: string
}

/** 'live' = built from real-world data (location/weather/time) — there is no
 * trustworthy expectedFire for it, so it's shown and matched like any other
 * scenario but never scored as correct/incorrect and never enters the
 * regression corpus, which requires a reliable ground truth by definition. */
export type ScenarioKind = 'normal' | 'edge' | 'exception' | 'stress' | 'live'

export type Scenario = {
  id: string
  patternId: string
  kind: ScenarioKind
  title: string
  /** narrative dressing only — shown to the user, never parsed by the engine */
  sceneText: string
  clockMin: number
  dayOfWeek: DayOfWeek
  flags: Record<string, boolean>
  /** ground truth: should a correctly-built agent fire here? */
  expectedFire: boolean
  /** true if Mistral proposed this scenario (still fully structured, still validated) */
  fromMistral: boolean
}

export type Pattern = {
  id: string
  icon: string
  label: string
  title: string
  trigger: string
  routine: string
  reward: string
  cost: string
  color: string
  /** the real-world texture the simulator uses to stage a scene */
  scene: string
  flags: FlagSpec[]
  actions: ActionSpec[]
  scenarios: Scenario[]
}

export type LessonChoice = {
  id: string
  text: string
  correct: boolean
  /** shown after the user picks this option — teaches by feedback */
  feedback: string
}

export type Lesson = {
  partId: PartId
  number: string
  title: string
  kicker: string
  /** the teaching body — real content, not a blurb */
  teach: string
  /** a concrete worked example */
  example: string
  /** check for understanding — can be answered wrong */
  question: string
  choices: LessonChoice[]
}

export type PartId = 'perceive' | 'decide' | 'act' | 'learn'

export type DiagnosisId = 'trigger' | 'routine' | 'reward'

/** The runtime contract. Everything the deterministic engine evaluates lives here — no prose. */
export type RuleSet = {
  /** ALL must hold for the rule to be eligible to fire (implicit AND). */
  conditions: Condition[]
  /** ANY exception condition true suppresses firing even if conditions matched (implicit OR-suppress). */
  exceptions: Condition[]
  /** id into the pattern's ActionSpec[] — the one reversible move taken when fired. */
  actionId: string
}

/** The user's agent — the thing that visibly runs and evolves. Rules are structured, not prose. */
export type Agent = {
  patternId: string
  diagnosis: DiagnosisId | ''
  rules: RuleSet
  /** free-text personal reminder about the learning policy — zero effect on execution */
  learnNotes: string
  /** version number — bumps every time an evolution is accepted */
  version: number
  /** log of accepted evolutions, oldest first */
  history: EvolutionEntry[]
  /** every scenario this agent has ever been run against — the regression corpus */
  scenarioLog: ScenarioRun[]
  /** longest unbroken run of correct calls in a single Shift — the score to beat */
  bestShiftLength: number
  createdAt: number
  updatedAt: number
}

export type MatchTrace = {
  conditions: { condition: Condition; met: boolean }[]
  exceptions: { condition: Condition; met: boolean }[]
  fired: boolean
  actionId: string | null
}

export type PredictionResult = 'correct' | 'missed' | 'over-fired'

export type ScenarioRun = {
  at: number
  scenarioId: string
  agentVersion: number
  userPredictedFire: boolean
  /** Whether the learner predicted the deterministic engine result correctly. */
  predictionCorrect?: boolean
  trace: MatchTrace
  predictionResult: PredictionResult
}

export type RegressionCheck = { scenarioId: string; passedBefore: boolean; passedAfter: boolean }

export type EvolutionEntry = {
  at: number
  scenarioId: string
  predictionResult: PredictionResult
  field: 'conditions' | 'exceptions' | 'actionId'
  ruleBefore: RuleSet
  ruleAfter: RuleSet
  /** why — Mistral-authored or scripted rationale; prose only, never executed */
  rationale: string
  fromMistral: boolean
  /** regression replay evidence gate — every prior scenario re-checked under the proposed rules */
  regression: RegressionCheck[]
}

export type SaveState = {
  agents: Record<string, Agent>
  activeAgentId: string
  xp: number
  completedLessons: PartId[]
  unlockedPatterns: string[]
  lastVisit: number
  streak: number
  /** true once the user has seen the v2→v3 migration banner, so it only shows once */
  sawMigrationNotice: boolean
}

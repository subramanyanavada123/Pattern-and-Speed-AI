export type Phase = 'home' | 'choose' | 'decode' | 'build' | 'simulate' | 'evolve'

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

/** The user's agent — the thing that visibly runs and evolves. */
export type Agent = {
  patternId: string
  /** what the agent watches for (perceive) */
  perceive: string
  /** the rule it applies (decide) */
  decide: string
  /** the one small reversible move it makes (act) */
  act: string
  /** the rule that rewrites itself from outcomes (learn) */
  learn: string
  diagnosis: DiagnosisId | ''
  /** version number — bumps every time the learn rule is rewritten */
  version: number
  /** log of evolutions, newest last */
  history: EvolutionEntry[]
  createdAt: number
  updatedAt: number
}

export type EvolutionEntry = {
  at: number
  /** 'fired-helped' | 'fired-annoyed' | 'missed' | 'not-needed' */
  outcome: CheckinOutcome
  note: string
  /** the proposed edit to a rule */
  ruleBefore: string
  ruleAfter: string
  field: keyof Pick<Agent, 'perceive' | 'decide' | 'act' | 'learn'>
  /** true if Mistral generated it, false if scripted fallback */
  fromMistral: boolean
}

export type CheckinOutcome = 'fired-helped' | 'fired-annoyed' | 'missed' | 'not-needed'

export type Checkin = {
  at: number
  outcome: CheckinOutcome
  note: string
}

export type SaveState = {
  agents: Record<string, Agent>
  activeAgentId: string
  checkins: Checkin[]
  xp: number
  completedLessons: PartId[]
  unlockedPatterns: string[]
  lastVisit: number
  streak: number
}

export type SimEvent = {
  kind: 'scene' | 'trigger' | 'perceive' | 'decide' | 'act' | 'outcome' | 'debrief'
  text: string
  ts: string
}

import './style.css'
import type { Phase, PartId, DiagnosisId, Agent, Condition, RuleSet, PredictionResult, Scenario, RegressionCheck, MatchTrace } from './types'
import { patterns, getPattern, diagnosisCopy, lessonFor } from './patterns'
import { discoverPattern, confirmScenario } from './discover'
import { store, newAgent, keyStore, onExternalSave, justMigratedFromV2 } from './store'
import { critique, reply } from './coach'
import { runScenario, proposeStressScenario, pickNextScenario, type NarratedResult } from './simulator'
import { proposeEvolution, predictionMeta } from './evolve'
import { testKey, listModels, type ModelInfo, type Citation } from './mistral'
import { scoreAgent, describeCondition, formatClock } from './engine'
import { fetchRealWorldContext, osmEmbedUrl, RealWorldError, type RealWorldContext } from './realworld'
import { orchestratePattern, isBackendUp, knownBackendState, BackendError, type OrchestrationResult } from './backend'

const app = document.querySelector<HTMLDivElement>('#app')!

// The settings modal lives in its own node OUTSIDE #app so that app re-renders
// (toasts, async unlocks, coach updates) can never wipe the key input mid-paste.
const modalRoot = document.createElement('div')
modalRoot.id = 'modal-root'
document.body.appendChild(modalRoot)

// ---- transient UI state ----
let phase: Phase = 'home'
let workingPatternId = 'gym'
let lessonIndex = 0
let lessonPicked: string | null = null
let lessonRevealed = false
let draftAgent: Agent | null = null
let diagnosis: DiagnosisId | '' = ''
let coachLog: { role: 'coach' | 'you'; text: string; citations?: Citation[] }[] = []
let coachBusy = false
let coachLive: boolean | null = null
let settingsOpen = false
let toast = ''
let fetchedModels: ModelInfo[] | null = null
let modelsLoading = false
let modelsError = ''
let evolving = false
let abort: AbortController | null = null
let migrationBannerDismissed = false
/** Two-step confirm for "Start fresh" in Settings — one click arms it, a second within the same modal session confirms. */
let resetArmed = false

// ---- pattern discovery: turn a free-text description into a real custom Pattern ----
let discoverText = ''
let discoverBusy = false
let discoverError = ''

// ---- team: a REAL Python backend spawning genuinely concurrent sub-agents ----
let teamBusy = false
let teamError = ''
let teamResult: OrchestrationResult | null = null
let teamBackendChecked = false

// ---- simulate (predict / reveal / compare / repair / replay) ----
type SimPhase = 'predicting' | 'revealed'
let simPhase: SimPhase = 'predicting'
let currentScenario: Scenario | null = null
let userPrediction: boolean | null = null
let narratedResult: NarratedResult | null = null
/** Set by "Repair this rule" so returning to Simulate re-tests the SAME scenario that just failed, not a fresh one. */
let scenarioToReplay: Scenario | null = null
/** True for one predicting-phase render right after a repair round-trip, so the UI can say "replaying" instead of "predict". */
let isReplaying = false
let simBusy = false
let pendingEvolution: Awaited<ReturnType<typeof proposeEvolution>> | null = null
let realWorld: RealWorldContext | null = null
let realWorldBusy = false
let realWorldError = ''

// ---- the Shift: chained scenarios, no detour, ends the moment the agent gets one wrong ----
/** Correct calls in a row so far this Shift. Resets to 0 on a wrong call or leaving Simulate. */
let shiftLength = 0
/** Set for exactly one reveal render — the call that just ended the Shift. */
let shiftJustBroke = false
/** The shiftLength value at the moment it broke, so the break screen can say "you got to 7". */
let shiftLengthAtBreak = 0

const LESSON_PARTS: PartId[] = ['perceive', 'decide', 'act', 'learn']

// ---------------------------------------------------------------- helpers

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
}

function showToast(msg: string) {
  toast = msg
  render()
  setTimeout(() => {
    if (toast === msg) {
      toast = ''
      render()
    }
  }, 3200)
}

function go(next: Phase) {
  abort?.abort()
  abort = null
  phase = next
  window.scrollTo({ top: 0, behavior: 'smooth' })
  render()
}

/**
 * `workingPatternId` is only ever explicitly set when a pattern card is
 * clicked in Choose. Every other entry into Simulate/Evolve (in particular
 * Home's "Welcome back" cards) must resync it to whichever pattern the
 * user's actual active agent belongs to — otherwise a stale value from a
 * previous Choose visit makes every downstream screen render one pattern's
 * scenarios/flags/actions against a completely different pattern's saved
 * rules: the scenario says "gym bag", the trace narrates "message reply".
 */
function syncWorkingPatternToActiveAgent() {
  const active = store.activeAgent()
  if (active) workingPatternId = active.patternId
}

/** Scenario ids the active agent has run where the deterministic verdict matched the scenario's ground truth. */
function previouslyCorrectScenarioIds(agent: Agent): Set<string> {
  const ids = new Set<string>()
  for (const run of agent.scenarioLog) {
    if (run.trace.fired === getPattern(agent.patternId).scenarios.find((s) => s.id === run.scenarioId)?.expectedFire) {
      ids.add(run.scenarioId)
    }
  }
  return ids
}

// ---------------------------------------------------------------- chrome

function renderHeader(): string {
  const s = store.get()
  const live = keyStore.has()
  return `<header class="topbar">
    <a class="wordmark" href="#" data-action="home"><span class="wordmark-mark">✳</span> Pattern Machine</a>
    <div class="mission"><span class="mission-dot"></span> Learn how helpers use clues, rules, and actions</div>
    <button class="top-reset" data-action="start-fresh">↺ Reset learning</button>
    <button class="key-pill ${live ? 'on' : ''}" data-action="settings">${live ? '● MISTRAL COACH ON' : '○ ADD AI COACH'}</button>
    <div class="xp"><span>${s.streak > 0 ? `🔥 ${s.streak}-DAY` : 'LEVEL 01'}</span><strong>${s.xp} XP</strong></div>
  </header>`
}

function renderMigrationBanner(): string {
  if (!justMigratedFromV2 || migrationBannerDismissed || store.get().sawMigrationNotice) return ''
  return `<div class="migration-banner">
    <p><b>Pattern Machine got a rebuild.</b> Agents now run on real, checkable rules instead of free text — your old agents can't convert automatically, so they were reset. Your XP, streak, and lesson progress carried over. Rebuilding an agent takes about 2 minutes.</p>
    <button data-action="dismiss-migration">Got it ✕</button>
  </div>`
}

function renderRail(): string {
  const steps: [Phase, string, string][] = [
    ['choose', 'Pick a loop', '01'],
    ['decode', 'Read it', '02'],
    ['build', 'Learn the parts', '03'],
    ['simulate', 'Watch it run', '04'],
    ['evolve', 'Make it smarter', '05'],
  ]
  const order = steps.map((s) => s[0])
  const cur = order.indexOf(phase)
  return `<aside class="sidebar">
    ${phase !== 'home' ? `<button class="back-home" data-action="home">← Home</button>` : ''}
    <button class="start-fresh-link" data-action="start-fresh">↺ Reset learning</button>
    <div class="sidebar-title">YOUR RUN</div>
    <div class="progress-track">${steps
      .map(([key, label, num], i) => {
        const active = key === phase
        const done = cur > i && cur !== -1
        return `<div class="step ${active ? 'active' : ''} ${done ? 'done' : ''}"><span>${done ? '✓' : num}</span>${label}</div>`
      })
      .join('')}</div>
    <div class="score-card">
      <div class="score-eyebrow">AGENT STATUS</div>
      ${renderAgentMini()}
    </div>
    ${renderRunHistoryChart() || `<div class="sidebar-note"><span>◈</span><p>A pattern is not a character flaw. It is a spec waiting for a deterministic system.</p></div>`}
  </aside>`
}

function renderAgentMini(): string {
  const a = store.activeAgent()
  if (!a) return `<p class="mini-empty">No agent yet. Build one — it will show up here and start evolving.</p>`
  const p = getPattern(a.patternId)
  const action = p.actions.find((x) => x.id === a.rules.actionId)?.label ?? '—'
  return `<div class="agent-mini">
    <div class="agent-mini-head"><b>${esc(p.title)}</b><span class="ver">v${a.version}</span></div>
    <div class="agent-mini-row"><i>conditions</i> ${a.rules.conditions.length}</div>
    <div class="agent-mini-row"><i>does</i> ${esc(clip(action, 60))}</div>
    <div class="agent-mini-foot">${a.history.length} evolution${a.history.length === 1 ? '' : 's'} · ${a.scenarioLog.length} run${a.scenarioLog.length === 1 ? '' : 's'}${a.bestShiftLength ? ` · best shift ${a.bestShiftLength}` : ''}</div>
  </div>`
}

function renderRunHistoryChart(): string {
  const a = store.activeAgent()
  if (!a || !a.scenarioLog.length) return ''
  const last = a.scenarioLog.slice(-14)
  const bars = last
    .map((r) => {
      const m = predictionMeta(r.predictionResult)
      return `<i class="tone-${m.tone}" title="${m.label}"></i>`
    })
    .join('')
  return `<div class="streak-chart">
    <div class="score-eyebrow">LAST ${last.length} PREDICTIONS</div>
    <div class="streak-bars">${bars}</div>
    <p>Come back tomorrow to keep the streak and run against more scenarios.</p>
  </div>`
}

function clip(s: string, n: number): string {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ---------------------------------------------------------------- HOME

function renderHome(): string {
  const s = store.get()
  const away = store.daysAway()
  const a = store.activeAgent()
  const returning = a && s.lastVisit > 0

  if (returning) {
    return `<section class="screen home-return">
      <div class="eyebrow">WELCOME BACK${away > 0 ? ` · ${away} DAY${away === 1 ? '' : 'S'} AWAY` : ''}</div>
      <h1>${a!.bestShiftLength > 0 ? `Beat your best:<br><em>${a!.bestShiftLength} in a row.</em>` : `Your agent is<br><em>still running.</em>`}</h1>
      <p class="lede">${esc(getPattern(a!.patternId).title)} — version ${a!.version}, ${a!.history.length} evolution${a!.history.length === 1 ? '' : 's'} in, tested against ${a!.scenarioLog.length} scenario${a!.scenarioLog.length === 1 ? '' : 's'}. ${a!.bestShiftLength > 0 ? 'Every wrong call ends the streak — see how far it holds this time.' : 'Run it against a new case and see how far it holds before it breaks.'}</p>
      <div class="home-cards">
        <button class="home-card accent" data-action="to-simulate"><span class="hc-k">SHIFT</span><strong>${a!.bestShiftLength > 0 ? `Beat ${a!.bestShiftLength}` : 'Start a shift'}</strong><p>Chained scenarios, no detour — one wrong call ends it.</p><span class="hc-go">→</span></button>
        <button class="home-card" data-action="to-evolve"><span class="hc-k">EVOLVE</span><strong>Review the evidence</strong><p>See every accepted edit, with before/after and regression checks.</p><span class="hc-go">→</span></button>
        <button class="home-card" data-action="to-choose"><span class="hc-k">EXPAND</span><strong>Build a second agent</strong><p>${s.unlockedPatterns.length} loop${s.unlockedPatterns.length === 1 ? '' : 's'} unlocked. New ones open as you go.</p><span class="hc-go">→</span></button>
      </div>
    </section>`
  }

  return `<section class="screen home-first">
    <div class="eyebrow">WHAT THIS IS</div>
    <h1>An "agent" is just<br><em>a habit, made explicit.</em></h1>
    <p class="lede">You already run agents in your head, badly: <b>"if it's late and my phone's in reach, I scroll."</b> That's a sense (it's late), a rule (phone in reach → scroll), and an action — just never written down, so it can't be tested or fixed. In this app you'll take one loop like that from your own life and build it as a real one.</p>

    <div class="goal-card">
      <div class="goal-card-head">WHAT YOU'LL HAVE IN ~10 MINUTES</div>
      <div class="goal-example">
        <div class="goal-part"><span>SENSE</span><p>It's after 11pm AND my phone is in my hand</p></div>
        <i>→</i>
        <div class="goal-part"><span>UNLESS</span><p>I'm not actually on call tonight</p></div>
        <i>→</i>
        <div class="goal-part"><span>ACTION</span><p>Pause the video, show me tomorrow's first task</p></div>
      </div>
      <p class="goal-caption">A small rule like this, for a loop <em>you</em> picked — then you'll throw real test cases at it and watch it actually decide, correctly or not, in front of you.</p>
    </div>

    <div class="home-start">
      <button class="primary-action big" data-action="to-choose">Pick your loop <span>→</span></button>
      <button class="ghost-link" data-action="settings">${keyStore.has() ? 'Mistral key connected ·' : ''} ${keyStore.has() ? 'settings' : 'Add a Mistral key later for extra narration + coaching (optional)'}</button>
    </div>

    <div class="home-rail">
      <div><span>01 · NOTICE</span>Name a loop from your own life — trigger, routine, reward, cost</div>
      <div><span>02 · BUILD</span>Turn it into a rule: when this, unless that, do this one thing</div>
      <div><span>03 · TEST</span>Guess what your rule will do, then watch it actually run</div>
      <div><span>04 · IMPROVE</span>Fix what broke, without accidentally breaking what worked</div>
    </div>
  </section>`
}

// ---------------------------------------------------------------- CHOOSE

function renderChoose(): string {
  const custom = store.customPatterns()
  return `<section class="screen">
    <div class="eyebrow">ACT I / SEE THE LOOP</div>
    <h1>Which loop has<br>been <em>running you?</em></h1>
    <p class="lede">Pick one below, or describe your own — Mistral will pull the trigger, routine, reward, and a testable rule structure out of what you actually write.</p>

    <div class="discover-card">
      <div class="discover-head">
        <span class="eyebrow">FIND YOUR OWN</span>
        <h3>Describe a loop in your own words</h3>
      </div>
      <p class="discover-sub">One or two sentences. "I keep checking my phone every time a group project message comes in, even when I have nothing useful to say." Mistral extracts the shape and proposes something you can actually test.</p>
      <textarea id="discover-text" rows="2" placeholder="e.g. Every time I get stuck on an assignment I open five tabs to 'research' and never come back to the doc" ${discoverBusy ? 'disabled' : ''}>${esc(discoverText)}</textarea>
      ${discoverError ? `<p class="discover-error">${esc(discoverError)}</p>` : ''}
      ${!keyStore.has() ? `<p class="discover-hint">Needs a Mistral key — <a href="#" data-action="settings">add one in Settings</a> to use this.</p>` : ''}
      <button class="primary-action ${discoverBusy ? 'disabled' : ''}" data-action="discover-pattern" ${discoverBusy ? 'disabled' : ''}>${discoverBusy ? 'Reading the pattern…' : 'Figure out my pattern'} <span>→</span></button>
    </div>

    ${custom.length ? `<div class="custom-patterns-head"><span class="eyebrow">YOUR DISCOVERED LOOPS</span></div>` : ''}
    <div class="pattern-grid">${custom
      .map((p, i) => `<button class="pattern-card ${p.color} custom" data-pattern="${p.id}" style="--delay:${i * 45}ms">
          <span class="card-top"><span class="pattern-icon">${p.icon}</span><span class="pattern-label">${p.label}</span><span class="card-arrow">✨</span></span>
          <strong>${esc(p.title)}</strong>
          <span class="card-trigger">Trigger: ${esc(p.trigger)}</span>
        </button>`)
      .join('')}</div>

    ${custom.length ? `<div class="custom-patterns-head"><span class="eyebrow">OR START FROM ONE OF THESE</span></div>` : ''}
    <div class="pattern-grid">${patterns
      .map((p, i) => {
        const locked = !store.isUnlocked(p.id)
        return `<button class="pattern-card ${p.color} ${locked ? 'locked' : ''}" data-pattern="${p.id}" ${locked ? 'disabled' : ''} style="--delay:${i * 45}ms">
          <span class="card-top"><span class="pattern-icon">${p.icon}</span><span class="pattern-label">${p.label}</span><span class="card-arrow">${locked ? '🔒' : '↗'}</span></span>
          <strong>${esc(p.title)}</strong>
          <span class="card-trigger">${locked ? 'Evolve an agent to unlock' : 'Trigger: ' + esc(p.trigger)}</span>
        </button>`
      })
      .join('')}</div>
  </section>`
}

// ---------------------------------------------------------------- DECODE

function renderDecode(): string {
  const p = getPattern(workingPatternId)
  const opts: [DiagnosisId, string, string][] = (['trigger', 'routine', 'reward'] as DiagnosisId[]).map((id) => [
    id,
    diagnosisCopy[id].title,
    diagnosisCopy[id].sub,
  ])
  return `<section class="screen">
    <div class="eyebrow">CHECKPOINT 01 / READ THE MACHINE</div>
    <div class="decode-heading">
      <div><h2>Read your loop<br><em>like a machine.</em></h2><p class="lede">Every sticky pattern has four beats. Which one you pick decides what your rule focuses on.</p></div>
      <div class="selected-stamp ${p.color}"><span>${p.icon}</span><b>${esc(p.label)}</b><small>YOUR LOOP</small></div>
    </div>
    <div class="loop-strip">
      <div><span>01 / TRIGGER</span><strong>${esc(p.trigger)}</strong></div><i>→</i>
      <div><span>02 / ROUTINE</span><strong>${esc(p.routine)}</strong></div><i>→</i>
      <div><span>03 / REWARD</span><strong>${esc(p.reward)}</strong></div><i>→</i>
      <div><span>04 / COST</span><strong>${esc(p.cost)}</strong></div>
    </div>
    <div class="checkpoint">
      <div class="checkpoint-title"><span class="checkpoint-number">01</span><div><span class="eyebrow">YOUR CALL</span><h3>Which part do you change first?</h3></div></div>
      <div class="diagnosis-options">${opts
        .map(
          ([id, title, sub]) => `<button class="diagnosis ${diagnosis === id ? 'selected' : ''}" data-diagnosis="${id}">
            <span class="radio">${diagnosis === id ? '✓' : ''}</span>
            <span><strong>${title}</strong><small>${sub}</small></span></button>`,
        )
        .join('')}</div>
      <button class="primary-action ${diagnosis ? '' : 'disabled'}" data-action="to-build">Take this into the build step <span>→</span></button>
    </div>
    <button class="ghost-link team-entry" data-action="to-team">🐍 Or spawn a real multi-agent team for this pattern (separate Python backend) →</button>
  </section>`
}

// ---------------------------------------------------------------- BUILD (lessons + structured rule editor)

function renderBuild(): string {
  const done = store.get().completedLessons
  const lesson = lessonFor(LESSON_PARTS[lessonIndex])
  const p = getPattern(workingPatternId)
  const allDone = LESSON_PARTS.every((x) => done.includes(x))

  if (allDone && !draftAgent) draftAgent = draftAgent ?? seedAgent()

  // Diagnosis makes the build screen mechanically different, not just framed differently:
  // 'trigger' emphasises the conditions editor, 'routine' emphasises the action picker,
  // 'reward' also emphasises the action picker (a substitute reward IS an action choice here).
  const emphasis: DiagnosisId | '' = diagnosis

  return `<section class="screen build-screen">
    <div class="eyebrow">ACT II / PATTERN → AGENT · ${done.length}/4</div>
    <h2>Build the parts that<br><em>move the decision</em> out of the hard moment.</h2>
    <div class="lesson-tabs">${LESSON_PARTS.map((pid, i) => {
      const l = lessonFor(pid)
      return `<button class="lesson-tab ${i === lessonIndex ? 'active' : ''} ${done.includes(pid) ? 'done' : ''}" data-lesson="${i}"><span>${done.includes(pid) ? '✓' : l.number}</span>${l.title}</button>`
    }).join('')}</div>

    <article class="lesson-card">
      <div class="lesson-kicker">${lesson.kicker.toUpperCase()}</div>
      <h3>${lesson.title}</h3>
      <p class="lesson-teach">${esc(lesson.teach)}</p>
      <div class="lesson-example"><span>WORKED EXAMPLE</span><p>${esc(lesson.example)}</p></div>
      <div class="lesson-check">
        <div class="lc-q">${esc(lesson.question)}</div>
        <div class="lc-choices">${lesson.choices
          .map((c) => {
            const picked = lessonPicked === c.id
            const showState = lessonRevealed && picked
            const cls = showState ? (c.correct ? 'right' : 'wrong') : picked ? 'picked' : ''
            return `<button class="lc-choice ${cls}" data-choice="${c.id}" ${lessonRevealed ? 'disabled' : ''}>
              <span class="lc-dot">${showState ? (c.correct ? '✓' : '✕') : ''}</span>
              <span class="lc-text">${esc(c.text)}${lessonRevealed && picked ? `<small>${esc(c.feedback)}</small>` : ''}</span>
            </button>`
          })
          .join('')}</div>
        ${
          lessonRevealed
            ? isPickedCorrect(lesson)
              ? `<button class="primary-action" data-action="lesson-next">${lessonIndex < 3 ? 'Next part' : 'Assemble your agent'} <span>→</span></button>`
              : `<button class="secondary-action" data-action="lesson-retry">Try again <span>↻</span></button>`
            : ''
        }
      </div>
    </article>

    ${allDone ? renderRuleEditor(p, emphasis) : ''}
  </section>`
}

function isPickedCorrect(lesson: ReturnType<typeof lessonFor>): boolean {
  return !!lessonPicked && !!lesson.choices.find((c) => c.id === lessonPicked)?.correct
}

function seedAgent(): Agent {
  const existing = store.getAgent(workingPatternId)
  const a = existing ?? newAgent(workingPatternId)
  a.diagnosis = diagnosis
  return a
}

function conditionKey(c: Condition): string {
  if (c.type === 'flag') return `flag:${c.flag}:${c.equals}`
  if (c.type === 'time-in-range') return `time:${c.fromMin}:${c.toMin}`
  return `day:${c.days.join(',')}`
}

function renderConditionPicker(pattern: ReturnType<typeof getPattern>, list: Condition[], listName: 'conditions' | 'exceptions'): string {
  const activeKeys = new Set(list.map(conditionKey))
  const pills = pattern.flags.map((f) => {
    const cond: Condition = { type: 'flag', flag: f.id, equals: true }
    const active = activeKeys.has(conditionKey(cond))
    return `<button class="cond-pill ${active ? 'active' : ''}" data-cond-toggle="${listName}" data-cond-flag="${f.id}">${esc(f.label)}</button>`
  }).join('')
  return `<div class="cond-picker">${pills}</div>`
}

function renderRuleEditor(p: ReturnType<typeof getPattern>, emphasis: DiagnosisId | ''): string {
  const a = draftAgent!
  const ready = a.rules.conditions.length > 0 && !!a.rules.actionId
  return `<div class="agent-builder">
    <div class="ab-head"><span class="eyebrow">ASSEMBLE / AGENT FOR "${esc(p.title).toUpperCase()}"</span><h3>Write your rule.</h3><p>Pick from the pattern's fixed vocabulary — the engine checks these exactly, no interpretation involved.</p></div>

    <div class="ab-field ${emphasis === 'trigger' ? 'ab-emphasis' : ''}">
      <span class="ab-label">Conditions (IF — all must hold)<i>${emphasis === 'trigger' ? 'you chose to change the trigger — start here' : 'what has to be true for this to fire'}</i></span>
      ${renderConditionPicker(p, a.rules.conditions, 'conditions')}
    </div>

    <div class="ab-field ${emphasis === 'trigger' ? 'ab-emphasis' : ''}">
      <span class="ab-label">Exceptions (UNLESS — any suppresses firing)<i>the named cases where this rule should stay quiet</i></span>
      ${renderConditionPicker(p, a.rules.exceptions, 'exceptions')}
    </div>

    <div class="ab-field ${emphasis === 'routine' || emphasis === 'reward' ? 'ab-emphasis' : ''}">
      <span class="ab-label">Action (THEN — exactly one)<i>${emphasis === 'routine' ? 'you chose to change the routine — pick the replacement move' : emphasis === 'reward' ? 'you chose to change the reward — pick the substitute payoff' : 'the one reversible move it makes'}</i></span>
      <div class="action-picker">${p.actions.map((act) => `
        <button class="action-card ${a.rules.actionId === act.id ? 'active' : ''}" data-action-pick="${act.id}">
          <b>${esc(act.label)}</b><span>${esc(act.description)}</span>
        </button>`).join('')}</div>
    </div>

    <label class="ab-field">
      <span class="ab-label">Notes (optional)<i>your own reminder — does not affect execution</i></span>
      <textarea data-agent-notes rows="2" placeholder="e.g. try this for two weeks before judging it">${esc(a.learnNotes)}</textarea>
    </label>

    <div class="ab-foot">
      <button class="ghost-link" data-action="open-coach">🗣 Ask the coach to poke holes</button>
      <button class="primary-action ${ready ? '' : 'disabled'}" data-action="to-simulate">Save agent &amp; run a scenario <span>→</span></button>
    </div>
  </div>`
}

// ---------------------------------------------------------------- SIMULATE (Predict → Reveal → Compare → Repair → Replay)

/**
 * Real-world grounding panel — genuine browser geolocation + live Open-Meteo
 * weather, no Mistral involved (it has no location/weather tool of its own).
 * hasWeatherFlag gates whether we say the flag was actually applied to this
 * pattern's scenario, since only the gym pattern currently has isRaining.
 */
/**
 * The Shift: chained scenarios with a live streak. This is the actual game —
 * a single flat Predict/Reveal has no stakes, so scenarios now run back to
 * back and the streak breaks the instant the agent calls one wrong. Tone
 * escalates with length so getting deep into a Shift actually feels like
 * something is on the line.
 */
function renderShiftBanner(isLiveScenario: boolean): string {
  if (isLiveScenario) {
    return `<div class="shift-banner shift-live"><span>◉ LIVE CONTEXT — DOESN'T COUNT TOWARD YOUR SHIFT</span></div>`
  }
  const a = store.activeAgent()
  const best = a?.bestShiftLength ?? 0
  if (shiftLength === 0) {
    return `<div class="shift-banner shift-start">
      <span>NEW SHIFT${best > 0 ? ` · BEST RUN: ${best}` : ''}</span>
      <p>Every wrong call ends it. How many can your rule survive in a row?</p>
    </div>`
  }
  const tier = shiftLength >= 8 ? 'shift-blazing' : shiftLength >= 4 ? 'shift-hot' : 'shift-warm'
  const line =
    shiftLength >= 8 ? "This is the longest run you've had. One slip ends it."
    : shiftLength >= 4 ? 'The rule is holding under pressure. Stay sharp.'
    : "It's working — don't get comfortable."
  return `<div class="shift-banner ${tier}">
    <span class="shift-count">${shiftLength} IN A ROW</span>
    <p>${line}${best > 0 ? ` · best: ${best}` : ''}</p>
  </div>`
}

function renderRealWorldPanel(hasWeatherFlag: boolean): string {
  if (realWorldBusy) {
    return `<div class="realworld-panel"><div class="evolving">Getting your location and current weather…</div></div>`
  }
  if (realWorld) {
    const r = realWorld
    return `<div class="realworld-panel">
      <div class="realworld-head">
        <span>📍 REAL-WORLD DATA · ${esc(r.placeLabel)}</span>
        <button class="ghost-link" data-action="clear-realworld">use scenario instead</button>
      </div>
      <div class="realworld-body">
        <iframe class="realworld-map" src="${esc(osmEmbedUrl(r.latitude, r.longitude))}" loading="lazy" referrerpolicy="no-referrer"></iframe>
        <div class="realworld-facts">
          <span>${r.isRaining ? '🌧️' : r.isDay ? '☀️' : '🌙'} ${r.temperatureC.toFixed(0)}°C</span>
          <span>${r.isRaining ? 'Raining now' : 'Not raining'}</span>
          <span>🕐 ${formatClock(r.clockMin)} locally</span>
          ${hasWeatherFlag ? '<span class="realworld-applied">isRaining flag set from live weather ✓</span>' : '<span class="realworld-note">This pattern has no weather flag — shown for context only.</span>'}
        </div>
      </div>
    </div>`
  }
  return `<div class="realworld-cta">
    <button class="ghost-link ${realWorldBusy ? 'disabled' : ''}" data-action="use-realworld" ${realWorldBusy ? 'disabled' : ''}>🌍 Use my real location, weather &amp; time instead</button>
    ${realWorldError ? `<p class="realworld-error">${esc(realWorldError)}</p>` : ''}
  </div>`
}

function renderAgentConsole(agent: Agent, pattern: ReturnType<typeof getPattern>): string {
  return `<div class="agent-console">
    <div class="agent-console-head"><div><span class="eyebrow">AGENT CONSOLE</span><strong>${esc(pattern.title)} · v${agent.version}</strong></div><span class="console-status">● READY</span></div>
    <p class="console-explainer">This is the helper you built. It reads clues, checks its rule, and chooses one small action. The tools below help you test and improve it.</p>
    <div class="tool-grid">
      <button class="tool-tile" data-action="sim-next"><span>⌁</span><b>Scenario Lab</b><small>Give it a new situation and predict what happens.</small></button>
      <button class="tool-tile" data-action="open-coach"><span>?</span><b>Ask the Coach</b><small>Get one question that helps you find a weak spot.</small></button>
      <button class="tool-tile" data-action="use-realworld"><span>◉</span><b>Live Context</b><small>Test with your time and weather, only with permission.</small></button>
      <button class="tool-tile" data-action="test-reminder"><span>→</span><b>Try the Action</b><small>See the helper's action as a permissioned reminder.</small></button>
    </div>
  </div>`
}

function renderSimulate(): string {
  const a = store.activeAgent() ?? draftAgent
  if (!a) return `<section class="screen"><p class="lede">Build an agent first.</p><button class="primary-action" data-action="to-choose">Start →</button></section>`
  // Derive the pattern from the AGENT being shown, not the independently-tracked
  // workingPatternId — that global can go stale (e.g. arriving here from Home's
  // "Welcome back" cards) and would otherwise render one pattern's scenarios
  // against a completely different pattern's actual rules.
  const p = getPattern(a.patternId)

  if (!currentScenario) {
    currentScenario = pickNextScenario(p, new Set(a.scenarioLog.map((r) => r.scenarioId)))
  }
  const scenario = currentScenario

  const ruleSummary = `<div class="sim-agent-strip">
    <span><i>IF</i> ${a.rules.conditions.length ? a.rules.conditions.map((c) => esc(describeCondition(c, p.flags))).join(' AND ') : '(none set)'}</span>
    <span><i>UNLESS</i> ${a.rules.exceptions.length ? a.rules.exceptions.map((c) => esc(describeCondition(c, p.flags))).join(' OR ') : '(none)'}</span>
    <span><i>THEN</i> ${esc(p.actions.find((x) => x.id === a.rules.actionId)?.label ?? '(none)')}</span>
  </div>`

  if (simPhase === 'predicting') {
    const hasWeatherFlag = p.flags.some((f) => f.id === 'isRaining')
    const isLiveScenario = scenario.kind === 'live'
    return `<section class="screen sim-screen">
      <div class="eyebrow">ACT III / ${isReplaying ? 'REPLAY — SAME SCENARIO, EDITED RULE' : 'PREDICT'} · ${scenario.kind.toUpperCase()} CASE</div>
      <h2>${isReplaying ? 'Same case, new rule —' : shiftLength === 0 ? 'One call.' : 'Keep it going —'}<br><em>will it fire?</em></h2>
      ${isReplaying ? '<p class="lede">This is the exact scenario that failed before. Predict again with your edited rule.</p>' : renderShiftBanner(isLiveScenario)}
      ${renderAgentConsole(a, p)}
      ${ruleSummary}
      <div class="scenario-card">
        <div class="scenario-tag">${esc(scenario.title)}${realWorld ? ' · LIVE' : ''}</div>
        <p class="scenario-scene">${esc(scenario.sceneText)}</p>
        <div class="scenario-facts">
          <span>🕐 ${formatClock(scenario.clockMin)}</span>
          ${Object.entries(scenario.flags).map(([k, v]) => `<span class="fact-flag ${v ? 'on' : 'off'}">${esc(p.flags.find((f) => f.id === k)?.label ?? k)}: ${v ? 'YES' : 'NO'}</span>`).join('')}
        </div>
      </div>
      ${renderRealWorldPanel(hasWeatherFlag)}
      ${simBusy ? `<div class="evolving">Checking the engine…</div>` : ''}
      <div class="predict-actions">
        <button class="predict-btn fire ${simBusy ? 'disabled' : ''}" data-predict="true" ${simBusy ? 'disabled' : ''}>It fires <span>✓</span></button>
        <button class="predict-btn quiet ${simBusy ? 'disabled' : ''}" data-predict="false" ${simBusy ? 'disabled' : ''}>It stays quiet <span>·</span></button>
      </div>
    </section>`
  }

  // revealed
  const trace = narratedResult!.trace
  const isLive = scenario.kind === 'live'
  const needsConfirm = !isLive && !scenario.verified
  const result = (isLive || needsConfirm) ? null : scoreAgent(trace, currentScenario!.expectedFire)
  const predictionCorrect = trace.fired === userPrediction
  const meta = result ? predictionMeta(result) : null

  const traceTable = `<div class="trace-table">
      <div class="trace-row trace-head"><span>CHECK</span><span>RESULT</span></div>
      ${trace.conditions.map((c) => `<div class="trace-row"><span>IF ${esc(describeCondition(c.condition, p.flags))}</span><span class="${c.met ? 'trace-true' : 'trace-false'}">${c.met ? 'TRUE' : 'FALSE'}</span></div>`).join('')}
      ${trace.exceptions.map((e) => `<div class="trace-row"><span>UNLESS ${esc(describeCondition(e.condition, p.flags))}</span><span class="${e.met ? 'trace-true' : 'trace-false'}">${e.met ? 'TRUE (suppresses)' : 'FALSE'}</span></div>`).join('')}
      <div class="trace-row trace-verdict"><span>FIRED?</span><span class="${trace.fired ? 'trace-true' : 'trace-false'}">${trace.fired ? 'YES' : 'NO'}</span></div>
    </div>`

  if (needsConfirm) {
    return `<section class="screen sim-screen">
      <div class="eyebrow">ACT III / CONFIRM · MISTRAL'S GUESS, NOT GROUND TRUTH YET</div>
      <div class="sim-source live">✨ AI-GENERATED SCENARIO — expectedFire is a guess until you confirm it</div>
      <h2>Your rule ${trace.fired ? 'fired' : 'stayed quiet'}<br><em>here. Is that actually right?</em></h2>
      ${ruleSummary}
      <div class="scenario-card"><p class="scenario-scene">${esc(narratedResult!.sceneNarration)}</p></div>
      ${traceTable}
      <div class="compare-banner tone-mute">
        <b>Mistral guessed this scenario should ${scenario.expectedFire ? 'fire' : 'stay quiet'}.</b> Your rule actually ${trace.fired ? 'fired' : 'stayed quiet'}. Before this counts as evidence, tell us: based on your real experience of this loop, what SHOULD happen here?
      </div>
      <div class="confirm-actions">
        <button class="secondary-action" data-confirm-fire="true">It should fire ✓</button>
        <button class="secondary-action" data-confirm-fire="false">It should stay quiet ·</button>
      </div>
      <p class="sim-note">Once confirmed, this becomes a real test case for this pattern — reused for future runs and regression checks, exactly like an authored scenario.</p>
    </section>`
  }

  if (isLive) {
    return `<section class="screen sim-screen">
      <div class="eyebrow">ACT III / LIVE REVEAL · YOUR ACTUAL CONDITIONS</div>
      <div class="sim-source live">● PRACTICE MODE · REAL CONTEXT, NO RIGHT ANSWER</div>
      <div class="active-agent-banner"><span class="agent-orbit">✳</span><div><small>YOU ARE TESTING</small><strong>${esc(p.title)}</strong><span>Agent v${a.version} · ${a.rules.conditions.length} clue${a.rules.conditions.length === 1 ? '' : 's'} · ${a.scenarioLog.length} previous test${a.scenarioLog.length === 1 ? '' : 's'}</span></div><button class="ghost-link" data-action="to-choose">Choose another loop</button></div>
      <h2>Right now,<br><em>what does your helper do?</em></h2>
      ${ruleSummary}
      <div class="scenario-card"><p class="scenario-scene">${esc(narratedResult!.sceneNarration)}</p></div>
      ${traceTable}
      <div class="compare-banner tone-mute">
        <b>This is a practice observation.</b> ${predictionCorrect ? 'Your prediction matched the helper.' : 'Your prediction differed from the helper.'} There is no authored right answer here; the point is to notice what your rule would do with real context.
      </div>
      <p class="explain-narration">${esc(narratedResult!.explainNarration)}</p>
      <div class="learning-takeaway"><div class="eyebrow">WHAT YOU JUST LEARNED</div><div class="takeaway-grid"><div><b>NOTICE</b><span>Rules need observable clues, not guesses.</span></div><div><b>THINK</b><span>IF and UNLESS decide whether the helper fires.</span></div><div><b>DO</b><span>THEN names one small action.</span></div><div><b>REMEMBER</b><span>Real practice gives evidence for the next edit.</span></div></div></div>
      <div class="sim-controls">
        <button class="secondary-action" data-action="clear-realworld" ${simBusy ? 'disabled' : ''}>Back to authored scenarios <span>→</span></button>
        <button class="primary-action" data-action="use-realworld" ${simBusy ? 'disabled' : ''}>Refresh real conditions <span>↻</span></button>
      </div>
      <div class="next-moves"><span>NEXT MOVE</span><button class="ghost-link" data-action="sim-next">Test an authored case</button><button class="ghost-link" data-action="test-reminder">Try the action</button><button class="ghost-link" data-action="sim-repair">Tune this helper</button><button class="ghost-link" data-action="to-choose">Build another helper</button></div>
    </section>`
  }

  const broke = shiftJustBroke && result !== 'correct'
  const streakHeadline = result === 'correct'
    ? shiftLength >= 8 ? `Still going.<br><em>${shiftLength} straight.</em>`
      : shiftLength >= 4 ? `Holding.<br><em>${shiftLength} in a row.</em>`
      : `Correct.<br><em>Next one's coming.</em>`
    : meta!.label === 'Missed'
      ? `It went quiet.<br><em>It shouldn't have.</em>`
      : `It fired.<br><em>It shouldn't have.</em>`

  return `<section class="screen sim-screen">
    <div class="eyebrow">ACT III / REVEAL · VERDICT: ${meta!.label.toUpperCase()}</div>
    ${narratedResult!.live ? '<div class="sim-source live">● NARRATED BY MISTRAL — verdict is deterministic either way</div>' : `<div class="sim-source scripted">○ SCRIPTED EXPLANATION${narratedResult!.fallbackReason ? ' — ' + esc(narratedResult!.fallbackReason) : ''}</div>`}
    ${broke ? `<div class="shift-broke"><span>SHIFT ENDED AT ${shiftLengthAtBreak}</span>${shiftLengthAtBreak >= (a.bestShiftLength || 0) && shiftLengthAtBreak > 0 ? '<b>NEW BEST</b>' : ''}</div>` : ''}
    <h2>${streakHeadline}</h2>
    ${renderAgentConsole(a, p)}
    ${ruleSummary}

    <div class="scenario-card">
      <p class="scenario-scene">${esc(narratedResult!.sceneNarration)}</p>
    </div>

    ${traceTable}

    <div class="compare-banner tone-${meta!.tone}">
      <b>Your prediction was ${predictionCorrect ? 'correct' : 'not quite'}.</b> ${meta!.label === 'Correct' ? 'The rule read the moment right.' : meta!.label === 'Missed' ? 'The rule stayed quiet exactly when it needed to act — too narrow, or missing the exception that should never have applied here.' : 'The rule fired when it should have held back — too broad, or missing an exception this case needed.'}
    </div>

    <p class="explain-narration">${esc(narratedResult!.explainNarration)}</p>

    ${evolving ? `<div class="evolving">Drafting a rule edit from this evidence…</div>` : ''}

    <div class="sim-controls">
      ${result === 'correct'
        ? `<button class="secondary-action" data-action="sim-next">Next scenario <span>→</span></button>
           <button class="primary-action" data-action="to-evolve">Bank it — review evidence <span>→</span></button>`
        : `<button class="secondary-action" data-action="sim-next">Start a new shift <span>→</span></button>
           <button class="primary-action ${evolving ? 'disabled' : ''}" data-action="sim-repair">Fix the rule <span>✎</span></button>`
      }
      <button class="ghost-link ${simBusy ? 'disabled' : ''}" data-action="sim-stress" ${simBusy ? 'disabled' : ''}>🎲 Throw a harder case at it</button>
    </div>
    ${a.scenarioLog.length ? `<p class="sim-note">${a.scenarioLog.length} scenario${a.scenarioLog.length === 1 ? '' : 's'} run so far${a.bestShiftLength ? ` · best shift: ${a.bestShiftLength}` : ''}.</p>` : ''}
  </section>`
}

// ---------------------------------------------------------------- TEAM (real backend, real concurrent sub-agents)

/**
 * This screen calls a REAL, separately-running Python process (backend/main.py)
 * that spawns genuinely concurrent sub-agent coroutines — not a simulation,
 * not one JSON blob pretending to be several agents. Requires the backend to
 * be running locally (uvicorn main:app --port 8787); the browser cannot do
 * this on its own.
 */
function renderTeam(): string {
  const p = getPattern(workingPatternId)
  const description = p.custom && p.sourceDescription ? p.sourceDescription : `${p.title}: ${p.trigger} → ${p.routine} → ${p.reward}`

  if (!teamBackendChecked && !teamBusy) {
    // Fire off a reachability check the first time this screen is shown —
    // doesn't block rendering, just informs the CTA state on the next render.
    void checkTeamBackend()
  }

  const backendState = knownBackendState()

  return `<section class="screen team-screen">
    <div class="eyebrow">REAL AGENTS · SEPARATE PYTHON BACKEND</div>
    <h2>Spawn a real<br><em>team of agents.</em></h2>
    <p class="lede">This calls an actual FastAPI process running on your machine — not a browser simulation. It plans which specialist agents your pattern needs, then runs them as genuinely concurrent, independent processes, each with its own Mistral call.</p>

    <div class="team-source-card">
      <span class="eyebrow">PATTERN GOING IN</span>
      <p>${esc(description)}</p>
    </div>

    ${backendState === false ? `
      <div class="team-offline">
        <p><b>Backend not reachable at http://127.0.0.1:8787.</b> Start it in a terminal:</p>
        <pre class="snippet-block">cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8787</pre>
        <button class="secondary-action" data-action="team-recheck">Check again</button>
      </div>
    ` : ''}

    ${teamError ? `<p class="team-error">${esc(teamError)}</p>` : ''}

    <button class="primary-action big ${teamBusy || backendState === false ? 'disabled' : ''}" data-action="run-team" ${teamBusy || backendState === false ? 'disabled' : ''}>
      ${teamBusy ? 'Orchestrating — real agents running…' : 'Spawn the team'} <span>→</span>
    </button>

    ${teamResult ? renderTeamResult(teamResult) : ''}
  </section>`
}

function renderTeamResult(result: OrchestrationResult): string {
  return `<div class="team-result">
    <div class="team-plan">
      <span class="eyebrow">ORCHESTRATOR'S PLAN</span>
      <p>${esc(result.planReasoning || 'No reasoning returned.')}</p>
      ${result.planError ? `<p class="team-plan-error">⚠ ${esc(result.planError)}</p>` : ''}
      <p class="team-timing">Selected ${result.selectedRoles.length} agent${result.selectedRoles.length === 1 ? '' : 's'} · ran in ${result.totalDurationMs}ms total (concurrently, not summed)</p>
    </div>
    <div class="team-grid">
      ${result.subAgents.map((a) => `
        <div class="team-card ${a.error ? 'team-card-error' : ''}">
          <div class="team-card-head"><b>${esc(a.agentName)}</b><span>${a.durationMs}ms</span></div>
          <p class="team-card-role">${esc(a.role)}</p>
          ${a.error ? `<p class="team-card-output team-card-output-error">✕ ${esc(a.error)}</p>` : `<p class="team-card-output">${esc(a.output)}</p>`}
        </div>
      `).join('')}
    </div>
  </div>`
}

async function checkTeamBackend() {
  teamBackendChecked = true
  await isBackendUp()
  render()
}

// ---------------------------------------------------------------- EVOLVE (evidence-gated)

function renderEvolve(): string {
  const a = store.activeAgent()
  if (!a) {
    return `<section class="screen"><div class="eyebrow">MAKE IT SMARTER</div><h2>No saved agent yet.</h2><p class="lede">Run a scenario in the simulator first — this is where the evidence accumulates.</p><button class="primary-action" data-action="to-simulate">Back to the simulator →</button></section>`
  }
  // Same fix as renderSimulate: derive the pattern from the agent, not the
  // possibly-stale workingPatternId global.
  const p = getPattern(a.patternId)

  return `<section class="screen evolve-screen">
    <div class="eyebrow">ACT IV / THE RETURN LOOP</div>
    <h2>Every scenario run<br>makes the agent <em>more precise.</em></h2>
    <p class="lede">Evolutions here are evidence-gated: every proposed edit is replayed against every scenario <b>${esc(p.title)}</b> has ever been tested on. If a fix breaks something that used to work, it's blocked before you can accept it.</p>

    <div class="agent-full">
      <div class="af-head"><b>${esc(p.title)}</b> <span class="ver">v${a.version}</span> ${a.history.length ? `<span class="af-evos">${a.history.length} evolution${a.history.length === 1 ? '' : 's'}</span>` : ''}</div>
      <div class="af-rules">
        <div class="af-rule"><span>IF</span><p>${a.rules.conditions.length ? a.rules.conditions.map((c) => esc(describeCondition(c, p.flags))).join(' AND ') : '—'}</p></div>
        <div class="af-rule"><span>UNLESS</span><p>${a.rules.exceptions.length ? a.rules.exceptions.map((c) => esc(describeCondition(c, p.flags))).join(' OR ') : '—'}</p></div>
        <div class="af-rule"><span>THEN</span><p>${esc(p.actions.find((x) => x.id === a.rules.actionId)?.label ?? '—')}</p></div>
      </div>
    </div>
    <div class="agent-actions"><button class="secondary-action" data-action="share-agent">Share this agent <span>↗</span></button><button class="secondary-action" data-action="download-agent">Download JSON <span>↓</span></button></div>

    ${pendingEvolution ? renderPendingEvolution(p) : `<div class="checkin"><p class="lede">No pending proposal. Run more scenarios in the simulator to generate evidence for the next edit.</p><button class="primary-action" data-action="to-simulate">Back to the simulator →</button></div>`}

    ${a.history.length ? renderEvolutionLog(a, p) : ''}
  </section>`
}

function renderPendingEvolution(pattern: ReturnType<typeof getPattern>): string {
  const e = pendingEvolution!
  const blocking = e.regression.filter((r: RegressionCheck) => r.passedBefore && !r.passedAfter)
  const blocked = blocking.length > 0
  const describeRule = (rs: RuleSet) => {
    if (e.field === 'conditions') return rs.conditions.length ? rs.conditions.map((c) => describeCondition(c, pattern.flags)).join(' AND ') : '(none)'
    if (e.field === 'exceptions') return rs.exceptions.length ? rs.exceptions.map((c) => describeCondition(c, pattern.flags)).join(' OR ') : '(none)'
    return pattern.actions.find((a) => a.id === rs.actionId)?.label ?? '(none)'
  }
  return `<div class="evolution-proposal ${blocked ? 'blocked' : ''}">
    <div class="ep-head"><span class="eyebrow">PROPOSED EDIT · ${e.field.toUpperCase()} ${e.fromMistral ? '· MISTRAL' : '· SCRIPTED'}</span><p>${esc(e.rationale)}</p></div>
    <div class="ep-diff">
      <div class="ep-before"><span>BEFORE</span><p>${esc(describeRule(e.ruleBefore))}</p></div>
      <div class="ep-arrow">→</div>
      <div class="ep-after"><span>AFTER</span><p>${esc(describeRule(e.ruleAfter))}</p></div>
    </div>
    <div class="regression-table">
      <div class="regression-head">REGRESSION CHECK · ${e.regression.length} PRIOR SCENARIO${e.regression.length === 1 ? '' : 'S'}</div>
      ${e.regression.map((r: RegressionCheck) => {
        const s = pattern.scenarios.find((sc) => sc.id === r.scenarioId)
        const status = !r.passedBefore ? 'n/a — was not previously correct' : r.passedAfter ? 'still correct' : 'REGRESSION — was correct, now wrong'
        return `<div class="regression-row ${r.passedBefore && !r.passedAfter ? 'regression-bad' : 'regression-ok'}"><span>${esc(s?.title ?? r.scenarioId)}</span><span>${status}</span></div>`
      }).join('')}
    </div>
    <div class="ep-actions">
      <button class="secondary-action" data-action="evo-reject">Keep current rule</button>
      <button class="primary-action ${blocked ? 'disabled' : ''}" data-action="evo-accept">${blocked ? 'Blocked — revise the edit' : `Apply · agent → v${(store.activeAgent()?.version ?? 1) + 1}`} <span>→</span></button>
    </div>
  </div>`
}

function renderEvolutionLog(a: Agent, pattern: ReturnType<typeof getPattern>): string {
  return `<div class="evo-log">
    <div class="eyebrow">EVOLUTION LOG</div>
    ${a.history
      .slice()
      .reverse()
      .map((h, i) => {
        const m = predictionMeta(h.predictionResult)
        const ver = a.version - i
        const describeRule = (rs: RuleSet) => {
          if (h.field === 'conditions') return rs.conditions.map((c) => describeCondition(c, pattern.flags)).join(' AND ') || '(none)'
          if (h.field === 'exceptions') return rs.exceptions.map((c) => describeCondition(c, pattern.flags)).join(' OR ') || '(none)'
          return pattern.actions.find((a2) => a2.id === rs.actionId)?.label ?? '(none)'
        }
        return `<div class="evo-entry">
          <div class="evo-entry-head"><span class="ver">v${ver - 1}→v${ver}</span><span class="tone-${m.tone}">${m.label}</span><i>${new Date(h.at).toLocaleDateString()}</i></div>
          <p class="evo-why">${esc(h.rationale)}</p>
          <p class="evo-change"><b>${h.field}:</b> ${esc(clip(describeRule(h.ruleBefore), 70))} <b>→</b> ${esc(clip(describeRule(h.ruleAfter), 90))}</p>
        </div>`
      })
      .join('')}
  </div>`
}

// ---------------------------------------------------------------- COACH PANEL

function renderCitations(citations: Citation[] | undefined): string {
  if (!citations?.length) return ''
  return `<div class="coach-citations">${citations
    .map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">🔗 ${esc(c.title)}</a>`)
    .join('')}</div>`
}

function renderCoachPanel(): string {
  if (phase !== 'build' && !coachLog.length && !coachBusy) return ''
  const open = coachLog.length > 0 || coachBusy
  if (!open) return ''
  return `<div class="coach-panel">
    <div class="coach-head"><span>🗣 SOCRATIC COACH ${coachLive === false ? '· offline (scripted)' : coachLive ? '· live' : ''}</span><button data-action="close-coach">✕</button></div>
    <div class="coach-log">${coachLog
      .map((m) => `<div class="coach-msg ${m.role}"><b>${m.role === 'coach' ? 'Coach' : 'You'}</b><p>${esc(m.text)}</p>${renderCitations(m.citations)}</div>`)
      .join('')}${coachBusy ? `<div class="coach-msg coach"><b>Coach</b><p class="dots"><span></span><span></span><span></span></p></div>` : ''}</div>
    <form class="coach-input" data-coach-form>
      <input type="text" data-coach-text placeholder="Answer back, ask why, or ask 'is this real?'…" ${coachBusy ? 'disabled' : ''} autocomplete="off" />
      <button type="submit" ${coachBusy ? 'disabled' : ''}>→</button>
    </form>
  </div>`
}

// ---------------------------------------------------------------- SETTINGS

function renderSettings(): string {
  if (!settingsOpen) return ''
  const k = keyStore.get()
  const masked = k ? k.slice(0, 6) + '…' + k.slice(-4) : ''
  const currentModel = keyStore.model()
  const options = fetchedModels?.length ? fetchedModels.map((m) => m.name) : []
  const allOptions = fetchedModels ? (options.includes(currentModel) ? options : [currentModel, ...options]) : []

  return `<div class="modal-backdrop">
    <div class="modal">
      <div class="modal-head"><h3>Mistral API key</h3><button data-action="close-settings">✕</button></div>
      <p class="modal-p">Mistral only NARRATES the deterministic verdict and proposes candidate edits — it never decides whether a rule fires; the engine does that with plain code, with or without a key. The coach can also search the web for real citations when you ask something like "is this real?" Your key is stored only in this browser's localStorage and sent straight to Mistral.</p>
      <p class="modal-p">"Use my real location" in the simulator is separate from Mistral entirely — it asks your browser for location, then queries the free <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> weather API and embeds a public <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a> view. No key, no account, nothing sent to Mistral.</p>
      <p class="modal-p"><a href="https://console.mistral.ai/api-keys" target="_blank" rel="noopener">Get a Mistral key →</a></p>
      <label class="modal-field"><span>API key</span>
        <input type="password" data-settings-key placeholder="${masked || 'Mistral key…'}" autocomplete="off" />
      </label>
      <label class="modal-field">
        <span>Model ${fetchedModels ? `<i class="field-hint">· ${fetchedModels.length} available to this key</i>` : `<i class="field-hint">· not confirmed yet, click Refresh</i>`}</span>
        <select data-settings-model ${options.length ? '' : 'disabled'}>
          ${allOptions.length ? allOptions.map((m) => `<option value="${m}" ${currentModel === m ? 'selected' : ''}>${esc(m)}</option>`).join('') : '<option value="">Refresh models to load available models</option>'}
        </select>
      </label>
      <button class="ghost-link" data-action="refresh-models" ${modelsLoading ? 'disabled' : ''}>${modelsLoading ? 'Checking with Mistral…' : '↻ Refresh models for this key'}</button>
      ${modelsError ? `<p class="modal-p modal-error">${esc(modelsError)}</p>` : ''}
      <div class="modal-actions">
        ${k ? `<button class="secondary-action" data-action="clear-key">Remove key</button>` : '<span></span>'}
        <div>
          <button class="secondary-action" data-action="test-key">Test</button>
          <button class="primary-action" data-action="save-key">Save</button>
        </div>
      </div>
      <div class="modal-status" data-key-status></div>

      <div class="modal-danger">
        <div class="modal-danger-head">RESET LEARNING PROGRESS</div>
        <p class="modal-p">Erases your agents, scenarios, XP, streak, and lesson progress on this device. Your Mistral API key, selected model, and settings stay saved.</p>
        <button class="secondary-action danger ${resetArmed ? 'armed' : ''}" data-action="reset-progress">${resetArmed ? 'Click again to reset learning ✕' : 'Reset learning progress'}</button>
      </div>
    </div>
  </div>`
}

// ---------------------------------------------------------------- render

let lastFocusedCoachInput = false

function render() {
  const body =
    phase === 'home' ? renderHome()
    : phase === 'choose' ? renderChoose()
    : phase === 'decode' ? renderDecode()
    : phase === 'build' ? renderBuild()
    : phase === 'simulate' ? renderSimulate()
    : phase === 'team' ? renderTeam()
    : renderEvolve()

  app.innerHTML =
    renderHeader() +
    renderMigrationBanner() +
    `<div class="app-layout">${renderRail()}<main>${body}</main></div>` +
    renderCoachPanel() +
    (toast ? `<div class="toast">${esc(toast)}</div>` : '')

  const ci = app.querySelector<HTMLInputElement>('[data-coach-text]')
  if (ci && !coachBusy && !lastFocusedCoachInput) {
    ci.focus()
    lastFocusedCoachInput = true
  } else if (!ci) {
    lastFocusedCoachInput = false
  }

  renderModal()
}

let modalRendered = false

function renderModal() {
  if (!settingsOpen) {
    if (modalRendered) {
      modalRoot.innerHTML = ''
      modalRendered = false
    }
    return
  }
  if (modalRendered) return
  modalRoot.innerHTML = renderSettings()
  modalRendered = true
}

// ---------------------------------------------------------------- modal events

async function refreshModelsForKey(opts: { silent: boolean }) {
  if (!keyStore.has()) {
    if (!opts.silent) {
      modelsError = 'Enter and save an API key first.'
      modalRoot.innerHTML = renderSettings()
    }
    return
  }
  modelsLoading = true
  modelsError = ''
  if (!opts.silent) modalRoot.innerHTML = renderSettings()
  try {
    const models = await listModels()
    fetchedModels = models
    if (models.length) {
      const currentlySelected = keyStore.model()
      const currentIsAvailable = models.some((m) => m.name === currentlySelected)
      if (!currentIsAvailable) {
        const preferred =
          models.find((m) => /small/i.test(m.name) && !/preview|exp/i.test(m.name)) ??
          models.find((m) => !/preview|exp/i.test(m.name)) ??
          models[0]
        if (preferred) {
          keyStore.setModel(preferred.name)
          showToast(`"${currentlySelected}" isn't available to this key — switched to ${preferred.name}.`)
        }
      } else if (opts.silent) {
        showToast(`Confirmed with Mistral — "${currentlySelected}" is available to this key.`)
      }
    } else {
      modelsError = 'Mistral returned no usable models for this key.'
    }
  } catch (e) {
    modelsError = e instanceof Error ? e.message : String(e)
    if (opts.silent && settingsOpen) showToast(`Could not confirm model list: ${modelsError}`)
  } finally {
    modelsLoading = false
    if (settingsOpen) modalRoot.innerHTML = renderSettings()
  }
}

function syncModelFromModal() {
  const model = modalRoot.querySelector<HTMLSelectElement>('[data-settings-model]')
  if (model?.value) keyStore.setModel(model.value)
}

modalRoot.addEventListener('click', async (event) => {
  const t = event.target as HTMLElement
  const action = t.closest<HTMLElement>('[data-action]')?.dataset.action
  if (!action) return

  if (action === 'close-settings') { settingsOpen = false; resetArmed = false; renderModal(); return }
  if (action === 'reset-progress') {
    if (!resetArmed) {
      resetArmed = true
      modalRoot.innerHTML = renderSettings()
      return
    }
    store.reset()
    resetArmed = false
    settingsOpen = false
    // justMigratedFromV2 is fixed true-for-this-session from page load if a v2
    // save existed — without this, resetting mid-session would resurrect the
    // "we rebuilt your agents" banner even though this IS the fresh state now.
    migrationBannerDismissed = true
    // Clear every piece of in-memory UI state tied to the wiped save, so the
    // very next render is a genuine, un-stale first-run screen.
    workingPatternId = patterns[0].id
    draftAgent = null
    diagnosis = ''
    currentScenario = null
    narratedResult = null
    pendingEvolution = null
    realWorld = null
    realWorldError = ''
    shiftLength = 0
    shiftJustBroke = false
    lessonIndex = 0; lessonPicked = null; lessonRevealed = false
    phase = 'home'
    render()
    showToast('Progress erased. This is a genuine first-run state.')
    return
  }
  if (action === 'save-key') {
    const input = modalRoot.querySelector<HTMLInputElement>('[data-settings-key]')
    const model = modalRoot.querySelector<HTMLSelectElement>('[data-settings-model]')
    const newKeyTyped = !!input?.value.trim()
    if (newKeyTyped) keyStore.set(input!.value)
    if (model) keyStore.setModel(model.value)
    settingsOpen = false
    renderModal()
    showToast(keyStore.has() ? 'Mistral key saved.' : 'Model saved.')
    if (newKeyTyped) await refreshModelsForKey({ silent: true })
    return
  }
  if (action === 'clear-key') {
    keyStore.clear()
    fetchedModels = null
    modalRoot.innerHTML = renderSettings()
    showToast('Key removed. Scripted mode.')
    return
  }
  if (action === 'test-key') {
    const statusEl = modalRoot.querySelector<HTMLDivElement>('[data-key-status]')
    const input = modalRoot.querySelector<HTMLInputElement>('[data-settings-key]')
    const typedKey = input?.value.trim()
    if (typedKey) keyStore.set(input!.value)
    syncModelFromModal()
    if (statusEl) statusEl.textContent = 'Testing…'
    const r = await testKey()
    if (statusEl) statusEl.textContent = r.ok ? '✓ Key works.' : `✕ ${r.error}`
    return
  }
  if (action === 'refresh-models') {
    const input = modalRoot.querySelector<HTMLInputElement>('[data-settings-key]')
    if (input?.value.trim()) keyStore.set(input.value)
    syncModelFromModal()
    await refreshModelsForKey({ silent: false })
    return
  }
})

modalRoot.addEventListener('mousedown', (event) => {
  if (event.target === modalRoot.firstElementChild) {
    settingsOpen = false
    resetArmed = false
    renderModal()
  }
})

// ---------------------------------------------------------------- events

app.addEventListener('click', async (event) => {
  const t = event.target as HTMLElement
  const actionEl = t.closest<HTMLElement>('[data-action]')
  const action = actionEl?.dataset.action
  if (actionEl?.tagName === 'A') event.preventDefault()
  const patternId = t.closest<HTMLButtonElement>('[data-pattern]')?.dataset.pattern
  const diag = t.closest<HTMLButtonElement>('[data-diagnosis]')?.dataset.diagnosis
  const lessonTab = t.closest<HTMLButtonElement>('[data-lesson]')?.dataset.lesson
  const choice = t.closest<HTMLButtonElement>('[data-choice]')?.dataset.choice
  const condToggle = t.closest<HTMLButtonElement>('[data-cond-toggle]')
  const actionPick = t.closest<HTMLButtonElement>('[data-action-pick]')?.dataset.actionPick
  const predict = t.closest<HTMLButtonElement>('[data-predict]')?.dataset.predict
  const confirmFire = t.closest<HTMLButtonElement>('[data-confirm-fire]')?.dataset.confirmFire

  if (t.closest('[data-stop]') && !action) return

  // ---- navigation
  if (action === 'home') { go('home'); return }
  if (action === 'start-fresh') { settingsOpen = true; resetArmed = true; render(); return }
  if (action === 'to-evolve') {
    // Coming straight from Home's "Welcome back" cards (no draft in flight)
    // means we're not necessarily still on the pattern from a PREVIOUS visit
    // to Choose — workingPatternId is stale global state otherwise, and every
    // downstream screen would show one pattern's scenarios/vocabulary against
    // a DIFFERENT pattern's actual saved agent. Always resync to the real
    // active agent before entering a screen that operates on "the" agent.
    if (!draftAgent) syncWorkingPatternToActiveAgent()
    pendingEvolution = null
    go('evolve')
    return
  }
  if (action === 'to-simulate') {
    if (!draftAgent) syncWorkingPatternToActiveAgent()
    // Always persist an in-progress draft here — this is also the return path
    // from "Repair this rule", where draftAgent holds edits to an ALREADY
    // saved agent. Gating on "no saved agent yet" would silently discard
    // those edits and run the simulator against stale rules.
    if (draftAgent) store.saveAgent(draftAgent)
    // Replay the SAME scenario that triggered a repair, so the user can see
    // whether their edit actually fixed it — a fresh/random scenario would
    // never confirm that. Otherwise start clean and let the simulator pick.
    currentScenario = scenarioToReplay
    isReplaying = !!scenarioToReplay
    scenarioToReplay = null
    narratedResult = null
    realWorld = null
    realWorldError = ''
    simPhase = 'predicting'
    userPrediction = null
    go('simulate')
    return
  }
  if (action === 'dismiss-migration') { migrationBannerDismissed = true; store.markMigrationNoticeSeen(); render(); return }

  // ---- settings
  if (action === 'settings') { settingsOpen = true; render(); return }

  // ---- choose
  if (action === 'discover-pattern') {
    await doDiscoverPattern()
    return
  }
  if (patternId) {
    workingPatternId = patternId
    diagnosis = store.getAgent(patternId)?.diagnosis || ''
    draftAgent = null
    lessonIndex = 0; lessonPicked = null; lessonRevealed = false
    // A pending repair-replay target belongs to whichever pattern was active
    // when "Repair this rule" was clicked — switching patterns invalidates it.
    scenarioToReplay = null
    isReplaying = false
    realWorld = null
    realWorldError = ''
    go('decode')
    return
  }

  // ---- decode
  if (diag) { diagnosis = diag as DiagnosisId; render(); return }
  if (action === 'to-build') { if (diagnosis) go('build'); return }
  if (action === 'to-team') {
    teamResult = null
    teamError = ''
    teamBackendChecked = false
    go('team')
    return
  }
  if (action === 'run-team') {
    await doRunTeam()
    return
  }
  if (action === 'team-recheck') {
    teamBackendChecked = false
    render()
    return
  }

  // ---- build / lessons
  if (lessonTab !== undefined) {
    lessonIndex = Number(lessonTab); lessonPicked = null; lessonRevealed = false; render(); return
  }
  if (choice) {
    lessonPicked = choice; lessonRevealed = true
    const lesson = lessonFor(LESSON_PARTS[lessonIndex])
    if (isPickedCorrect(lesson)) store.completeLesson(LESSON_PARTS[lessonIndex])
    render(); return
  }
  if (action === 'lesson-retry') { lessonPicked = null; lessonRevealed = false; render(); return }
  if (action === 'lesson-next') {
    if (lessonIndex < 3) { lessonIndex++; lessonPicked = null; lessonRevealed = false }
    else { draftAgent = seedAgent() }
    render(); return
  }

  // ---- structured rule editor
  if (condToggle && draftAgent) {
    const listName = condToggle.dataset.condToggle as 'conditions' | 'exceptions'
    const flagId = condToggle.dataset.condFlag!
    const cond: Condition = { type: 'flag', flag: flagId, equals: true }
    const key = conditionKey(cond)
    const list = draftAgent.rules[listName]
    const idx = list.findIndex((c) => conditionKey(c) === key)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(cond)
    render()
    return
  }
  if (actionPick && draftAgent) {
    draftAgent.rules.actionId = actionPick
    render()
    return
  }

  // ---- coach
  if (action === 'open-coach') {
    if (!draftAgent) draftAgent = seedAgent()
    coachBusy = true; coachLog = []; render()
    try {
      const r = await critique(draftAgent, getPattern(draftAgent.patternId))
      coachLive = r.live
      coachLog.push({ role: 'coach', text: r.text })
      if (r.fallbackReason) showToast(`Mistral unavailable, coach went scripted: ${r.fallbackReason}`)
    } catch (e) {
      coachLog.push({ role: 'coach', text: 'Coach hit an error: ' + (e as Error).message })
    }
    coachBusy = false; render(); return
  }
  if (action === 'close-coach') { coachLog = []; coachBusy = false; render(); return }

  // ---- simulate: predict
  if (predict !== undefined) {
    userPrediction = predict === 'true'
    await doReveal()
    return
  }
  if (confirmFire !== undefined) {
    await doConfirmScenario(confirmFire === 'true')
    return
  }
  if (action === 'sim-next') {
    currentScenario = null
    isReplaying = false
    narratedResult = null
    realWorld = null
    simPhase = 'predicting'
    userPrediction = null
    render()
    return
  }
  if (action === 'sim-stress') {
    await doStressScenario()
    return
  }
  if (action === 'test-reminder') {
    if (!('Notification' in window)) { showToast('This browser does not support reminders.'); return }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') { showToast('Reminder permission was not granted.'); return }
    showToast('Action armed — your helper will remind you in 10 seconds.')
    window.setTimeout(() => new Notification('Pattern Machine', { body: 'Your helper noticed the moment. Try the small action you designed.' }), 10_000)
    return
  }
  if (action === 'use-realworld') {
    await doUseRealWorld()
    return
  }
  if (action === 'clear-realworld') {
    realWorld = null
    realWorldError = ''
    currentScenario = null // re-pick a normal authored scenario
    render()
    return
  }
  if (action === 'to-choose') {
    abort?.abort()
    abort = null
    currentScenario = null
    narratedResult = null
    realWorld = null
    realWorldError = ''
    simPhase = 'predicting'
    userPrediction = null
    isReplaying = false
    shiftLength = 0
    shiftJustBroke = false
    go('choose')
    return
  }
  if (action === 'sim-repair') {
    draftAgent = store.activeAgent() ?? draftAgent
    scenarioToReplay = currentScenario
    go('build')
    setTimeout(() => app.querySelector('.agent-builder')?.scrollIntoView({ behavior: 'smooth' }), 60)
    return
  }

  // ---- evolve
  if (action === 'evo-accept' && pendingEvolution) {
    const blocking = pendingEvolution.regression.some((r: RegressionCheck) => r.passedBefore && !r.passedAfter)
    if (blocking) { showToast('Blocked — this edit regresses a previously-correct scenario.'); return }
    const updated = store.evolveAgent(pendingEvolution)
    pendingEvolution = null
    coachLog = []
    coachLive = null
    coachBusy = false
    simBusy = false
    evolving = false
    userPrediction = null
    scenarioToReplay = null
    isReplaying = false
    showToast(updated ? `Agent evolved to v${updated.version}.` : 'Could not apply — try again.')
    render()
    return
  }
  if (action === 'evo-reject') { pendingEvolution = null; render(); return }
  if (action === 'share-agent' || action === 'download-agent') {
    const agent = store.activeAgent()
    if (!agent) return
    const pattern = getPattern(agent.patternId)
    const payload = {
      app: 'Pattern Machine',
      pattern: pattern.title,
      version: agent.version,
      rule: {
        if: agent.rules.conditions.map((c) => describeCondition(c, pattern.flags)),
        unless: agent.rules.exceptions.map((c) => describeCondition(c, pattern.flags)),
        then: pattern.actions.find((a) => a.id === agent.rules.actionId)?.label ?? 'No action',
      },
      tests: agent.scenarioLog.length,
      evolutions: agent.history.length,
    }
    const readable = `Pattern Machine / ${pattern.title}\nAgent v${agent.version}\nIF ${payload.rule.if.join(' AND ') || '(none)'}\nUNLESS ${payload.rule.unless.join(' OR ') || '(none)'}\nTHEN ${payload.rule.then}\nTests: ${payload.tests} · Evolutions: ${payload.evolutions}`
    if (action === 'download-agent') {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = `${pattern.id}-agent-v${agent.version}.json`; link.click(); URL.revokeObjectURL(url)
      showToast('Agent JSON downloaded.')
    } else if (navigator.share) {
      await navigator.share({ title: `Pattern Machine / ${pattern.title}`, text: readable }).catch(() => undefined)
    } else {
      await navigator.clipboard?.writeText(readable)
      showToast('Agent copied to clipboard.')
    }
    return
  }
})

// coach conversation
app.addEventListener('submit', async (event) => {
  const form = (event.target as HTMLElement).closest('[data-coach-form]')
  if (!form) return
  event.preventDefault()
  const input = form.querySelector<HTMLInputElement>('[data-coach-text]')!
  const text = input.value.trim()
  if (!text || coachBusy) return
  coachLog.push({ role: 'you', text })
  coachBusy = true
  render()
  try {
    const agentForCoach = draftAgent ?? seedAgent()
    const r = await reply(agentForCoach, getPattern(agentForCoach.patternId), coachLog.slice(0, -1), text)
    coachLive = r.live
    coachLog.push({ role: 'coach', text: r.text, citations: r.citations })
  } catch (e) {
    coachLog.push({ role: 'coach', text: 'Error: ' + (e as Error).message })
  }
  coachBusy = false
  render()
})

// keep draft agent notes in sync as the user types
app.addEventListener('input', (event) => {
  const el = event.target as HTMLElement
  if ((el as HTMLElement).hasAttribute?.('data-agent-notes') && draftAgent) {
    draftAgent.learnNotes = (el as HTMLTextAreaElement).value
  }
  if ((el as HTMLElement).id === 'discover-text') {
    discoverText = (el as HTMLTextAreaElement).value
  }
})

/**
 * Score a verified scenario's outcome, record it as evidence, advance/break
 * the Shift, and if the call was wrong, ask for an evolution proposal. Shared
 * by the normal reveal path and the post-confirmation path (a just-confirmed
 * scenario is scored exactly the same way a hand-authored one always was).
 */
async function scoreAndRecord(agent: Agent, scenario: Scenario, trace: MatchTrace, signal?: AbortSignal) {
  const result: PredictionResult = scoreAgent(trace, scenario.expectedFire)
  const predictionCorrect = trace.fired === userPrediction
  const updated = store.recordScenarioRun({
    at: Date.now(), scenarioId: scenario.id, agentVersion: agent.version,
    userPredictedFire: userPrediction!, predictionCorrect, trace, predictionResult: result,
  })
  shiftJustBroke = false
  if (result === 'correct') {
    shiftLength += 1
  } else {
    shiftJustBroke = true
    shiftLengthAtBreak = shiftLength
    store.recordShiftResult(shiftLength)
    shiftLength = 0
  }
  if (result !== 'correct' && updated) {
    evolving = true
    render()
    pendingEvolution = await proposeEvolution(updated, getPattern(updated.patternId), scenario.id, result, previouslyCorrectScenarioIds(updated), signal)
    evolving = false
  }
}

async function doReveal() {
  const agent = store.activeAgent() ?? draftAgent
  if (!agent || !currentScenario) return
  simBusy = true
  abort = new AbortController()
  render()
  try {
    // Use the AGENT's own pattern, not workingPatternId — this is the actual
    // engine call, so a stale global here doesn't just mislabel the UI, it
    // runs the deterministic match against the wrong pattern's vocabulary.
    narratedResult = await runScenario(agent, getPattern(agent.patternId), currentScenario, abort.signal)
    simPhase = 'revealed'
    const trace = narratedResult.trace
    if (narratedResult.fallbackReason) showToast(`Mistral unavailable: ${narratedResult.fallbackReason}`)

    if (currentScenario.kind === 'live') {
      // A real-world moment has no trustworthy expectedFire to score against —
      // show the trace as pure observation, but don't record it as evidence,
      // don't let it drive an evolution proposal off a fabricated verdict, and
      // don't let it affect the Shift streak either way.
    } else if (!currentScenario.verified) {
      // AI-generated expectedFire is a guess, not ground truth yet. Show the
      // trace, but hold off scoring/shift/evolution until the user confirms
      // (or corrects) it — see doConfirmScenario — otherwise the evidence
      // corpus that gates future evolutions would be built on an unverified guess.
    } else {
      await scoreAndRecord(agent, currentScenario, trace, abort.signal)
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('Error: ' + (e as Error).message)
  } finally {
    simBusy = false
    abort = null
    render()
  }
}

/** User confirmed (or corrected) an AI-generated scenario's expectedFire. Persist it as real ground truth, then score the run that's already on screen against it. */
async function doConfirmScenario(userSaysShouldFire: boolean) {
  const agent = store.activeAgent() ?? draftAgent
  if (!agent || !currentScenario || !narratedResult) return
  const pattern = getPattern(agent.patternId)

  const confirmed = confirmScenario(pattern, currentScenario.id, userSaysShouldFire)
  if (pattern.custom) store.updateCustomPattern(confirmed)
  const confirmedScenario = confirmed.scenarios.find((s) => s.id === currentScenario!.id)!
  currentScenario = confirmedScenario

  simBusy = true
  abort = new AbortController()
  render()
  try {
    await scoreAndRecord(agent, confirmedScenario, narratedResult.trace, abort.signal)
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('Error: ' + (e as Error).message)
  } finally {
    simBusy = false
    abort = null
    render()
  }
}

async function doUseRealWorld() {
  const agent = store.activeAgent() ?? draftAgent
  if (!agent || !currentScenario) return
  const p = getPattern(agent.patternId)
  realWorldBusy = true
  realWorldError = ''
  render()
  try {
    const ctx = await fetchRealWorldContext()
    realWorld = ctx
    // Build a live scenario: same identity/action-relevant title as the current
    // one, but clock/day/weather come from reality. Ground truth (expectedFire)
    // for a live scenario is unknown in advance — the engine still decides
    // exactly the same way, we just don't get to pre-validate it against an
    // authored answer, so this scenario's outcome is recorded as an
    // exploratory run rather than treated as unimpeachable ground truth.
    const flags = { ...currentScenario.flags }
    if (p.flags.some((f) => f.id === 'isRaining')) flags.isRaining = ctx.isRaining
    currentScenario = {
      ...currentScenario,
      id: `realworld-${Date.now()}`,
      kind: 'live',
      title: 'Your real conditions, right now',
      sceneText: `It's actually ${formatClock(ctx.clockMin)} where you are, ${ctx.temperatureC.toFixed(0)}°C${ctx.isRaining ? ' and raining' : ''}. This scenario uses your real location's weather and time instead of an authored one.`,
      clockMin: ctx.clockMin,
      dayOfWeek: ctx.dayOfWeek,
      flags,
      // No trustworthy ground truth exists for a live real-world moment — this
      // value is never read because 'live' scenarios skip correctness scoring
      // and never enter the regression corpus. See ScenarioKind's doc comment.
      expectedFire: false,
      verified: false,
    }
    narratedResult = null
    simPhase = 'predicting'
    userPrediction = null
  } catch (e) {
    realWorldError = e instanceof RealWorldError ? e.message : 'Could not get real-world data. Using the scenario as authored.'
  } finally {
    realWorldBusy = false
    render()
  }
}

async function doRunTeam() {
  if (teamBusy) return
  const p = getPattern(workingPatternId)
  const description = p.custom && p.sourceDescription ? p.sourceDescription : `${p.title}: ${p.trigger} → ${p.routine} → ${p.reward}`
  teamBusy = true
  teamError = ''
  render()
  try {
    teamResult = await orchestratePattern(description)
  } catch (e) {
    teamError = e instanceof BackendError ? e.message : e instanceof Error ? e.message : 'Something went wrong contacting the backend.'
  } finally {
    teamBusy = false
    render()
  }
}

async function doDiscoverPattern() {
  if (discoverBusy) return
  discoverBusy = true
  discoverError = ''
  render()
  try {
    const result = await discoverPattern(discoverText)
    if (!result.ok) {
      discoverError = result.error
      return
    }
    store.addCustomPattern(result.pattern)
    discoverText = ''
    showToast(`Found it: "${result.pattern.title}" — pick it below to start building.`)
    workingPatternId = result.pattern.id
    diagnosis = ''
    draftAgent = null
    lessonIndex = 0; lessonPicked = null; lessonRevealed = false
    scenarioToReplay = null
    isReplaying = false
    go('decode')
  } catch (e) {
    discoverError = e instanceof Error ? e.message : 'Something went wrong. Try again.'
  } finally {
    discoverBusy = false
    render()
  }
}

async function doStressScenario() {
  const agent = store.activeAgent() ?? draftAgent
  const p = getPattern(agent?.patternId ?? workingPatternId)
  simBusy = true
  abort = new AbortController()
  render()
  try {
    const { scenario, live, fallbackReason } = await proposeStressScenario(p, abort.signal)
    currentScenario = scenario
    narratedResult = null
    simPhase = 'predicting'
    userPrediction = null
    if (!live && fallbackReason) showToast(`Mistral unavailable, using an authored scenario: ${fallbackReason}`)
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('Error: ' + (e as Error).message)
  } finally {
    simBusy = false
    abort = null
    render()
  }
}

// unlock the next pattern once an agent has evolved at least once
function maybeUnlock() {
  const a = store.activeAgent()
  if (a && a.history.length >= 1) {
    const locked = patterns.find((p) => !store.isUnlocked(p.id))
    if (locked) store.unlockPattern(locked.id)
  }
}
const _origEvolve = store.evolveAgent.bind(store)
store.evolveAgent = ((entry) => {
  const r = _origEvolve(entry)
  if (r) maybeUnlock()
  return r
}) as typeof store.evolveAgent

// Another tab (or window) saved progress — re-render so this tab reflects it
// instead of silently overwriting it on its own next save.
onExternalSave(() => {
  showToast('Synced progress from another tab.')
  render()
})

render()

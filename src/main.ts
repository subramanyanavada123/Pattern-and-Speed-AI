import './style.css'
import type { Phase, PartId, DiagnosisId, Agent, Condition, RuleSet, PredictionResult, Scenario, RegressionCheck } from './types'
import { patterns, getPattern, diagnosisCopy, lessonFor } from './patterns'
import { store, newAgent, keyStore, onExternalSave, justMigratedFromV2 } from './store'
import { critique, reply } from './coach'
import { runScenario, proposeStressScenario, pickNextScenario, type NarratedResult } from './simulator'
import { proposeEvolution, predictionMeta } from './evolve'
import { testKey, listModels, type ModelInfo } from './mistral'
import { scorePrediction, describeCondition, formatClock } from './engine'

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
let coachLog: { role: 'coach' | 'you'; text: string }[] = []
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
    <div class="mission"><span class="mission-dot"></span> Turn a loop that runs you into a deterministic agent</div>
    <button class="key-pill ${live ? 'on' : ''}" data-action="settings">${live ? '● MISTRAL LIVE' : '○ ADD MISTRAL KEY'}</button>
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
    <div class="agent-mini-foot">${a.history.length} evolution${a.history.length === 1 ? '' : 's'} · ${a.scenarioLog.length} run${a.scenarioLog.length === 1 ? '' : 's'}</div>
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
      <h1>Your agent is<br><em>still running.</em></h1>
      <p class="lede">${esc(getPattern(a!.patternId).title)} — version ${a!.version}, ${a!.history.length} evolution${a!.history.length === 1 ? '' : 's'} in, tested against ${a!.scenarioLog.length} scenario${a!.scenarioLog.length === 1 ? '' : 's'}. Run it against a new case, or make it smarter from the evidence so far.</p>
      <div class="home-cards">
        <button class="home-card accent" data-action="to-simulate"><span class="hc-k">PREDICT</span><strong>Run another scenario</strong><p>Predict, reveal, and see exactly which condition decided it.</p><span class="hc-go">→</span></button>
        <button class="home-card" data-action="to-evolve"><span class="hc-k">EVOLVE</span><strong>Review the evidence</strong><p>See every accepted edit, with before/after and regression checks.</p><span class="hc-go">→</span></button>
        <button class="home-card" data-action="to-choose"><span class="hc-k">EXPAND</span><strong>Build a second agent</strong><p>${s.unlockedPatterns.length} loop${s.unlockedPatterns.length === 1 ? '' : 's'} unlocked. New ones open as you go.</p><span class="hc-go">→</span></button>
      </div>
    </section>`
  }

  return `<section class="screen home-first">
    <div class="eyebrow">ACT I / SEE THE LOOP</div>
    <h1>Your day is a program<br><em>you didn't write.</em></h1>
    <p class="lede">Pick a loop you recognise from student life, write it as a real deterministic rule — conditions, exceptions, one action — then watch a rule engine actually evaluate it against test scenarios. Not a chatbot narrating a story: code deciding whether your rule fires.</p>
    <div class="home-start">
      <button class="primary-action big" data-action="to-choose">Start with one loop <span>→</span></button>
      <button class="ghost-link" data-action="settings">${keyStore.has() ? 'Mistral key connected ·' : ''} ${keyStore.has() ? 'settings' : 'Add a Mistral key for narration + coaching'}</button>
    </div>
    <div class="home-rail">
      <div><span>01 / DECODE</span>Trigger, routine, reward, cost</div>
      <div><span>02 / BUILD</span>Conditions, exceptions, one action</div>
      <div><span>03 / PREDICT</span>Guess, then see the real verdict</div>
      <div><span>04 / EVOLVE</span>Edit with regression checks, not guesses</div>
    </div>
  </section>`
}

// ---------------------------------------------------------------- CHOOSE

function renderChoose(): string {
  return `<section class="screen">
    <div class="eyebrow">ACT I / SEE THE LOOP</div>
    <h1>Which loop has<br>been <em>running you?</em></h1>
    <p class="lede">Pick the one that stings a little — that's usually the useful one. Locked loops open as you evolve an agent.</p>
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

function renderSimulate(): string {
  const a = store.activeAgent() ?? draftAgent
  const p = getPattern(workingPatternId)
  if (!a) return `<section class="screen"><p class="lede">Build an agent first.</p><button class="primary-action" data-action="to-choose">Start →</button></section>`

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
    return `<section class="screen sim-screen">
      <div class="eyebrow">ACT III / ${isReplaying ? 'REPLAY — SAME SCENARIO, EDITED RULE' : 'PREDICT'} · ${scenario.kind.toUpperCase()} CASE</div>
      <h2>${isReplaying ? 'Same case, new rule —' : 'Before you look —'}<br><em>will it fire?</em></h2>
      ${isReplaying ? '<p class="lede">This is the exact scenario that failed before. Predict again with your edited rule.</p>' : ''}
      ${ruleSummary}
      <div class="scenario-card">
        <div class="scenario-tag">${esc(scenario.title)}</div>
        <p class="scenario-scene">${esc(scenario.sceneText)}</p>
        <div class="scenario-facts">
          <span>🕐 ${formatClock(scenario.clockMin)}</span>
          ${Object.entries(scenario.flags).map(([k, v]) => `<span class="fact-flag ${v ? 'on' : 'off'}">${esc(p.flags.find((f) => f.id === k)?.label ?? k)}: ${v ? 'YES' : 'NO'}</span>`).join('')}
        </div>
      </div>
      ${simBusy ? `<div class="evolving">Checking the engine…</div>` : ''}
      <div class="predict-actions">
        <button class="predict-btn fire ${simBusy ? 'disabled' : ''}" data-predict="true" ${simBusy ? 'disabled' : ''}>It fires <span>✓</span></button>
        <button class="predict-btn quiet ${simBusy ? 'disabled' : ''}" data-predict="false" ${simBusy ? 'disabled' : ''}>It stays quiet <span>·</span></button>
      </div>
    </section>`
  }

  // revealed
  const trace = narratedResult!.trace
  const result = scorePrediction(trace, userPrediction!)
  const meta = predictionMeta(result)

  return `<section class="screen sim-screen">
    <div class="eyebrow">ACT III / REVEAL · VERDICT: ${meta.label.toUpperCase()}</div>
    ${narratedResult!.live ? '<div class="sim-source live">● NARRATED BY MISTRAL — verdict is deterministic either way</div>' : `<div class="sim-source scripted">○ SCRIPTED EXPLANATION${narratedResult!.fallbackReason ? ' — ' + esc(narratedResult!.fallbackReason) : ''}</div>`}
    <h2>Here's exactly<br><em>why.</em></h2>
    ${ruleSummary}

    <div class="scenario-card">
      <p class="scenario-scene">${esc(narratedResult!.sceneNarration)}</p>
    </div>

    <div class="trace-table">
      <div class="trace-row trace-head"><span>CHECK</span><span>RESULT</span></div>
      ${trace.conditions.map((c) => `<div class="trace-row"><span>IF ${esc(describeCondition(c.condition, p.flags))}</span><span class="${c.met ? 'trace-true' : 'trace-false'}">${c.met ? 'TRUE' : 'FALSE'}</span></div>`).join('')}
      ${trace.exceptions.map((e) => `<div class="trace-row"><span>UNLESS ${esc(describeCondition(e.condition, p.flags))}</span><span class="${e.met ? 'trace-true' : 'trace-false'}">${e.met ? 'TRUE (suppresses)' : 'FALSE'}</span></div>`).join('')}
      <div class="trace-row trace-verdict"><span>FIRED?</span><span class="${trace.fired ? 'trace-true' : 'trace-false'}">${trace.fired ? 'YES' : 'NO'}</span></div>
    </div>

    <div class="compare-banner tone-${meta.tone}">
      <b>You predicted ${userPrediction ? 'it fires' : 'it stays quiet'}.</b> ${meta.label === 'Correct' ? 'That matches the engine exactly.' : meta.label === 'Missed' ? 'The engine stayed quiet — your rule needs a broader condition or one fewer exception.' : 'The engine fired anyway — your rule needs a narrower condition or a new exception.'}
    </div>

    <p class="explain-narration">${esc(narratedResult!.explainNarration)}</p>

    ${evolving ? `<div class="evolving">Drafting a rule edit from this evidence…</div>` : ''}

    <div class="sim-controls">
      ${result === 'correct'
        ? `<button class="secondary-action" data-action="sim-next">Try another scenario <span>→</span></button>
           <button class="primary-action" data-action="to-evolve">Review evidence &amp; evolve <span>→</span></button>`
        : `<button class="secondary-action" data-action="sim-next">Skip for now <span>→</span></button>
           <button class="primary-action ${evolving ? 'disabled' : ''}" data-action="sim-repair">Repair this rule <span>✎</span></button>`
      }
      <button class="ghost-link" data-action="sim-stress">🎲 Try a harder scenario</button>
    </div>
    ${a.scenarioLog.length ? `<p class="sim-note">${a.scenarioLog.length} scenario${a.scenarioLog.length === 1 ? '' : 's'} run so far.</p>` : ''}
  </section>`
}

// ---------------------------------------------------------------- EVOLVE (evidence-gated)

function renderEvolve(): string {
  const a = store.activeAgent()
  const p = getPattern(workingPatternId)
  if (!a) {
    return `<section class="screen"><div class="eyebrow">MAKE IT SMARTER</div><h2>No saved agent yet.</h2><p class="lede">Run a scenario in the simulator first — this is where the evidence accumulates.</p><button class="primary-action" data-action="to-simulate">Back to the simulator →</button></section>`
  }

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

function renderCoachPanel(): string {
  if (phase !== 'build' && !coachLog.length) return ''
  const open = coachLog.length > 0 || coachBusy
  if (!open) return ''
  return `<div class="coach-panel">
    <div class="coach-head"><span>🗣 SOCRATIC COACH ${coachLive === false ? '· offline (scripted)' : coachLive ? '· live' : ''}</span><button data-action="close-coach">✕</button></div>
    <div class="coach-log">${coachLog
      .map((m) => `<div class="coach-msg ${m.role}"><b>${m.role === 'coach' ? 'Coach' : 'You'}</b><p>${esc(m.text)}</p></div>`)
      .join('')}${coachBusy ? `<div class="coach-msg coach"><b>Coach</b><p class="dots"><span></span><span></span><span></span></p></div>` : ''}</div>
    <form class="coach-input" data-coach-form>
      <input type="text" data-coach-text placeholder="Answer back, or ask why…" ${coachBusy ? 'disabled' : ''} autocomplete="off" />
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
      <p class="modal-p">Mistral only NARRATES the deterministic verdict and proposes candidate edits — it never decides whether a rule fires; the engine does that with plain code, with or without a key. Your key is stored only in this browser's localStorage and sent straight to Mistral.</p>
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

  if (action === 'close-settings') { settingsOpen = false; renderModal(); return }
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

  if (t.closest('[data-stop]') && !action) return

  // ---- navigation
  if (action === 'home') { go('home'); return }
  if (action === 'to-choose') { go('choose'); return }
  if (action === 'to-evolve') {
    pendingEvolution = null
    go('evolve')
    return
  }
  if (action === 'to-simulate') {
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
    simPhase = 'predicting'
    userPrediction = null
    go('simulate')
    return
  }
  if (action === 'dismiss-migration') { migrationBannerDismissed = true; store.markMigrationNoticeSeen(); render(); return }

  // ---- settings
  if (action === 'settings') { settingsOpen = true; render(); return }

  // ---- choose
  if (patternId) {
    workingPatternId = patternId
    diagnosis = store.getAgent(patternId)?.diagnosis || ''
    draftAgent = null
    lessonIndex = 0; lessonPicked = null; lessonRevealed = false
    // A pending repair-replay target belongs to whichever pattern was active
    // when "Repair this rule" was clicked — switching patterns invalidates it.
    scenarioToReplay = null
    isReplaying = false
    go('decode')
    return
  }

  // ---- decode
  if (diag) { diagnosis = diag as DiagnosisId; render(); return }
  if (action === 'to-build') { if (diagnosis) go('build'); return }

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
      const r = await critique(draftAgent, getPattern(workingPatternId))
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
  if (action === 'sim-next') {
    currentScenario = null
    isReplaying = false
    narratedResult = null
    simPhase = 'predicting'
    userPrediction = null
    render()
    return
  }
  if (action === 'sim-stress') {
    await doStressScenario()
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
    showToast(updated ? `Agent evolved to v${updated.version}.` : 'Could not apply — try again.')
    render()
    return
  }
  if (action === 'evo-reject') { pendingEvolution = null; render(); return }
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
    const r = await reply(draftAgent ?? seedAgent(), getPattern(workingPatternId), coachLog.slice(0, -1), text)
    coachLive = r.live
    coachLog.push({ role: 'coach', text: r.text })
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
})

async function doReveal() {
  const agent = store.activeAgent() ?? draftAgent
  if (!agent || !currentScenario) return
  simBusy = true
  abort = new AbortController()
  render()
  try {
    narratedResult = await runScenario(agent, getPattern(workingPatternId), currentScenario, abort.signal)
    simPhase = 'revealed'
    const trace = narratedResult.trace
    const result: PredictionResult = scorePrediction(trace, userPrediction!)
    const updated = store.recordScenarioRun({
      at: Date.now(), scenarioId: currentScenario.id, agentVersion: agent.version,
      userPredictedFire: userPrediction!, trace, predictionResult: result,
    })
    if (narratedResult.fallbackReason) showToast(`Mistral unavailable: ${narratedResult.fallbackReason}`)
    if (result !== 'correct' && updated) {
      evolving = true
      render()
      pendingEvolution = await proposeEvolution(updated, getPattern(workingPatternId), currentScenario.id, result, previouslyCorrectScenarioIds(updated), abort.signal)
      evolving = false
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('Error: ' + (e as Error).message)
  } finally {
    simBusy = false
    abort = null
    render()
  }
}

async function doStressScenario() {
  const p = getPattern(workingPatternId)
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

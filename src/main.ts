import './style.css'
import type { Phase, PartId, DiagnosisId, Agent, SimEvent, CheckinOutcome } from './types'
import { patterns, getPattern, diagnosisCopy, lessonFor } from './patterns'
import { store, newAgent, keyStore, onExternalSave } from './store'
import { critique, reply } from './coach'
import { runDay, rerunDay, surpriseTwist, type SimResult } from './simulator'
import { proposeEvolution, outcomeMeta } from './evolve'
import { testKey, listModels, type ModelInfo } from './mistral'

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
let simEvents: SimEvent[] = []
let simRunning = false
let simResult: SimResult | null = null
let simTwist = ''
let simRunCount = 0
let settingsOpen = false
let toast = ''
let fetchedModels: ModelInfo[] | null = null
let modelsLoading = false
let modelsError = ''
let pendingEvolution: Awaited<ReturnType<typeof proposeEvolution>> | null = null
let evolving = false
let abort: AbortController | null = null

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

// ---------------------------------------------------------------- chrome

function renderHeader(): string {
  const s = store.get()
  const live = keyStore.has()
  return `<header class="topbar">
    <a class="wordmark" href="#" data-action="home"><span class="wordmark-mark">✳</span> Pattern Machine</a>
    <div class="mission"><span class="mission-dot"></span> Turn a loop that runs you into an agent that works for you</div>
    <button class="key-pill ${live ? 'on' : ''}" data-action="settings">${live ? '● MISTRAL LIVE' : '○ ADD MISTRAL KEY'}</button>
    <div class="xp"><span>${s.streak > 0 ? `🔥 ${s.streak}-DAY` : 'LEVEL 01'}</span><strong>${s.xp} XP</strong></div>
  </header>`
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
  const s = store.get()
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
    ${s.checkins.length ? renderStreakChart() : `<div class="sidebar-note"><span>◈</span><p>A pattern is not a character flaw. It is a spec waiting for a better system.</p></div>`}
  </aside>`
}

function renderAgentMini(): string {
  const a = store.activeAgent()
  if (!a) return `<p class="mini-empty">No agent yet. Build one — it will show up here and start evolving.</p>`
  const p = getPattern(a.patternId)
  return `<div class="agent-mini">
    <div class="agent-mini-head"><b>${esc(p.title)}</b><span class="ver">v${a.version}</span></div>
    <div class="agent-mini-row"><i>sees</i> ${esc(clip(a.perceive, 60))}</div>
    <div class="agent-mini-row"><i>does</i> ${esc(clip(a.act, 60))}</div>
    <div class="agent-mini-foot">${a.history.length} evolution${a.history.length === 1 ? '' : 's'}</div>
  </div>`
}

function renderStreakChart(): string {
  const last = store.checkinsLast(14)
  const bars = last
    .map((c) => {
      const m = outcomeMeta(c.outcome)
      return `<i class="tone-${m.tone}" title="${m.label}"></i>`
    })
    .join('')
  return `<div class="streak-chart">
    <div class="score-eyebrow">LAST ${last.length} CHECK-INS</div>
    <div class="streak-bars">${bars}</div>
    <p>Come back tomorrow to keep the streak and let the agent learn from today.</p>
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
      <p class="lede">${esc(getPattern(a!.patternId).title)} — version ${a!.version}, ${a!.history.length} evolution${a!.history.length === 1 ? '' : 's'} in. Feed it today's outcome and watch it adjust, or take it into another simulated day.</p>
      <div class="home-cards">
        <button class="home-card accent" data-action="to-evolve"><span class="hc-k">DAILY</span><strong>Check in on today</strong><p>One tap. The agent rewrites a rule from what actually happened.</p><span class="hc-go">→</span></button>
        <button class="home-card" data-action="to-simulate"><span class="hc-k">PRACTICE</span><strong>Run another day</strong><p>Watch the current version handle a fresh, harder scenario.</p><span class="hc-go">→</span></button>
        <button class="home-card" data-action="to-choose"><span class="hc-k">EXPAND</span><strong>Build a second agent</strong><p>${s.unlockedPatterns.length} loop${s.unlockedPatterns.length === 1 ? '' : 's'} unlocked. New ones open as you go.</p><span class="hc-go">→</span></button>
      </div>
    </section>`
  }

  return `<section class="screen home-first">
    <div class="eyebrow">ACT I / SEE THE LOOP</div>
    <h1>Your day is a program<br><em>you didn't write.</em></h1>
    <p class="lede">You are a <b>Pattern Detective</b>. Find a loop from everyday life, teach a tiny AI helper how to notice it, choose a move, and learn from what happens next. No perfect answers needed.</p>
    <div class="home-start">
      <button class="primary-action big" data-action="to-choose">Start with one loop <span>→</span></button>
      <button class="ghost-link" data-action="settings">${keyStore.has() ? 'Mistral helper connected ·' : ''} ${keyStore.has() ? 'settings' : 'Add a Mistral key for the live helper'}</button>
    </div>
    <div class="home-rail">
      <div><span>01 / NOTICE</span>Spot what repeats</div>
      <div><span>02 / PREDICT</span>Guess what happens next</div>
      <div><span>03 / BUILD</span>Give your helper senses and hands</div>
      <div><span>04 / TEST</span>Try it, learn, improve</div>
    </div>
  </section>`
}

// ---------------------------------------------------------------- CHOOSE

function renderChoose(): string {
  return `<section class="screen">
    <div class="eyebrow">ACT I / SEE THE LOOP</div>
    <h1>Which loop has<br>been <em>running you?</em></h1>
    <p class="lede">Choose a loop you recognise from school, games, friends, or home. You are not being graded on the habit — you are investigating how the pattern works.</p>
    <div class="pattern-grid">${patterns
      .map((p, i) => {
        const locked = !store.isUnlocked(p.id)
        return `<button class="pattern-card ${p.color} ${locked ? 'locked' : ''}" data-pattern="${p.id}" ${locked ? 'disabled' : ''} style="--delay:${i * 45}ms">
          <span class="card-top"><span class="pattern-icon">${p.icon}</span><span class="pattern-label">${p.label}</span><span class="card-arrow">${locked ? '🔒' : '↗'}</span></span>
          <strong>${esc(p.title)}</strong>
          <span class="card-trigger">${locked ? 'Finish an agent to unlock' : 'Trigger: ' + esc(p.trigger)}</span>
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
      <div><h2>Read your loop<br><em>like a detective.</em></h2><p class="lede">Every repeating pattern has four clues: what starts it, what you do, what you get, and what it costs later.</p></div>
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
      <button class="primary-action ${diagnosis ? '' : 'disabled'}" data-action="to-build">Choose your experiment <span>→</span></button>
    </div>
  </section>`
}

// ---------------------------------------------------------------- BUILD (lessons)

function renderBuild(): string {
  const done = store.get().completedLessons
  const lesson = lessonFor(LESSON_PARTS[lessonIndex])
  const p = getPattern(workingPatternId)
  const allDone = LESSON_PARTS.every((x) => done.includes(x))

  if (allDone && !draftAgent) draftAgent = draftAgent ?? seedAgent()

  return `<section class="screen build-screen">
    <div class="eyebrow">ACT II / TRAIN YOUR HELPER · ${done.length}/4</div>
    <h2>Teach your helper<br><em>how to think.</em></h2>
    <div class="concept-strip"><div><b>NOTICE</b><span>What is happening?</span></div><i>→</i><div><b>THINK</b><span>What should happen?</span></div><i>→</i><div><b>DO</b><span>What small move helps?</span></div><i>→</i><div><b>REMEMBER</b><span>What did we learn?</span></div></div>
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

    ${allDone ? renderAgentBuilder(p) : ''}
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

function renderAgentBuilder(p: ReturnType<typeof getPattern>): string {
  const a = draftAgent!
  const field = (key: keyof Agent, label: string, hint: string, ph: string) => `
    <label class="ab-field">
      <span class="ab-label">${label}<i>${hint}</i></span>
      <textarea data-agent-field="${key}" rows="2" placeholder="${ph}">${esc(String(a[key] ?? ''))}</textarea>
    </label>`
  const ready = a.perceive.trim() && a.decide.trim() && a.act.trim()
  return `<div class="agent-builder">
    <div class="ab-head"><span class="eyebrow">ASSEMBLE / HELPER FOR "${esc(p.title).toUpperCase()}"</span><h3>Build a tiny thinking machine.</h3><p>Every agent has four jobs: notice, think, do, and remember. Make each job small enough to test.</p></div>
    ${field('perceive', 'Perceive / notice', 'a clue it can actually observe', 'e.g. the homework tab is open and no typing happened for 5 minutes')}
    ${field('decide', 'Decide / think', 'IF <clue> THEN <one move>, plus an exception', 'IF stuck for 5 minutes THEN show one hint. EXCEPTION: class has ended.')}
    ${field('act', 'Act / do', 'one small, reversible move', 'show one hint and start a 5-minute timer')}
    ${field('learn', 'Learn / remember', 'what should change after a test', 'if the hint helped, keep it; if it annoyed me, make it smaller')}
    <div class="ab-foot">
      <button class="ghost-link" data-action="open-coach">🗣 Ask the coach to poke holes</button>
      <button class="primary-action ${ready ? '' : 'disabled'}" data-action="to-simulate">Boot the agent &amp; run a day <span>→</span></button>
    </div>
  </div>`
}

// ---------------------------------------------------------------- SIMULATE

function renderSimulate(): string {
  const a = store.activeAgent() ?? draftAgent
  if (!a) return `<section class="screen"><p class="lede">Build an agent first.</p><button class="primary-action" data-action="to-choose">Start →</button></section>`

  const kindMeta: Record<SimEvent['kind'], { tag: string; cls: string }> = {
    scene: { tag: 'THE MOMENT', cls: 'ev-scene' },
    trigger: { tag: 'TRIGGER', cls: 'ev-trigger' },
    perceive: { tag: 'AGENT · PERCEIVE', cls: 'ev-perceive' },
    decide: { tag: 'AGENT · DECIDE', cls: 'ev-decide' },
    act: { tag: 'AGENT · ACT', cls: 'ev-act' },
    outcome: { tag: 'WHAT YOU DID', cls: 'ev-outcome' },
    debrief: { tag: 'DEBRIEF', cls: 'ev-debrief' },
  }

  const feed = simEvents.length
    ? simEvents
        .map(
          (e) => `<div class="sim-ev ${kindMeta[e.kind].cls}"><div class="sim-ev-tag">${kindMeta[e.kind].tag}<i>${e.ts}</i></div><p>${esc(e.text)}</p></div>`,
        )
        .join('') + (simRunning ? `<div class="sim-ev ev-typing"><span></span><span></span><span></span></div>` : '')
    : `<div class="sim-empty">
        <p>Your agent v${a.version} is loaded.${keyStore.has() ? ' Mistral will role-play a slice of your day and run your rules against it, live.' : ' No key — a scripted day will run using your exact rule text.'}</p>
      </div>`

  return `<section class="screen sim-screen">
    <div class="eyebrow">ACT III / WATCH THE AGENT RUN${simResult ? ` · VERDICT: ${verdictLabel(simResult.verdict).toUpperCase()}` : ''}</div>
    ${simResult ? `<div class="sim-source ${simResult.live ? 'live' : 'scripted'}">${simResult.live ? '● LIVE — MISTRAL RAN THIS' : '○ SCRIPTED FALLBACK' + (simResult.fallbackReason ? ' — ' + esc(simResult.fallbackReason) : ' — no key set')}</div>` : ''}
    <h2>A day, simulated.<br><em>Your rules, live.</em></h2>
    <div class="sim-agent-strip">
      <span><i>SEES</i> ${esc(clip(a.perceive, 80))}</span>
      <span><i>DECIDES</i> ${esc(clip(a.decide, 80))}</span>
      <span><i>ACTS</i> ${esc(clip(a.act, 80))}</span>
    </div>

    ${simTwist ? `<div class="sim-twist">TODAY'S TWIST · ${esc(simTwist)}</div>` : ''}

    <div class="sim-feed">${feed}</div>

    <div class="sim-controls">
      ${
        simRunning
          ? `<button class="secondary-action" data-action="sim-stop">Stop <span>■</span></button>`
          : simResult
            ? `<button class="secondary-action" data-action="sim-twist">Harder day <span>🎲</span></button>
               <button class="secondary-action" data-action="sim-rerun">Re-run <span>↻</span></button>
               <button class="primary-action" data-action="sim-tune">Tune a rule &amp; re-run <span>✎</span></button>
               <button class="primary-action" data-action="to-evolve">This agent is good — save it <span>→</span></button>`
            : `<button class="primary-action big" data-action="sim-run">▶ Run the day</button>`
      }
    </div>
    ${simRunCount === 0 && !simRunning ? '' : `<p class="sim-note">Watched runs done: ${simRunCount}. Each run is different. Tune rules between runs and watch the outcome change.</p>`}
  </section>`
}

function verdictLabel(v: SimResult['verdict']): string {
  return v === 'fired-helped' ? 'agent won' : v === 'fired-annoyed' ? 'won but annoying' : 'loop won'
}

// ---------------------------------------------------------------- EVOLVE

function renderEvolve(): string {
  const a = store.activeAgent()
  const p = getPattern(workingPatternId)
  if (!a) {
    return `<section class="screen"><div class="eyebrow">MAKE IT SMARTER</div><h2>No saved agent yet.</h2><p class="lede">Run a simulation you're happy with, then save the agent — this is where it starts learning from your real days.</p><button class="primary-action" data-action="to-simulate">Back to the simulator →</button></section>`
  }

  const outcomes: CheckinOutcome[] = ['fired-helped', 'fired-annoyed', 'missed', 'not-needed']

  return `<section class="screen evolve-screen">
    <div class="eyebrow">ACT IV / THE RETURN LOOP</div>
    <h2>Every real day makes<br>the agent <em>more yours.</em></h2>
    <p class="lede">Tell it what actually happened with <b>${esc(p.title)}</b>. It proposes one surgical edit to one rule. Accept the ones that ring true — the version number is your progress.</p>

    <div class="agent-full">
      <div class="af-head"><b>${esc(p.title)}</b> <span class="ver">v${a.version}</span> ${a.history.length ? `<span class="af-evos">${a.history.length} evolution${a.history.length === 1 ? '' : 's'}</span>` : ''}</div>
      <div class="af-rules">
        ${(['perceive', 'decide', 'act', 'learn'] as const)
          .map((k) => `<div class="af-rule ${pendingEvolution?.field === k ? 'targeted' : ''}"><span>${k.toUpperCase()}</span><p>${esc(a[k] || '—')}</p></div>`)
          .join('')}
      </div>
    </div>

    ${
      pendingEvolution
        ? renderPendingEvolution()
        : `<div class="checkin">
            <div class="checkin-q">How did it go today?</div>
            <div class="checkin-opts">${outcomes
              .map((o) => {
                const m = outcomeMeta(o)
                return `<button class="checkin-opt tone-${m.tone}" data-checkin="${o}"><span>${m.glyph}</span>${m.label}</button>`
              })
              .join('')}</div>
            <textarea id="checkin-note" class="checkin-note" rows="2" placeholder="One line on what happened (optional but the agent uses it)"></textarea>
            ${evolving ? `<div class="evolving">Agent is rewriting a rule…</div>` : ''}
          </div>`
    }

    ${a.history.length ? renderEvolutionLog(a) : ''}
  </section>`
}

function renderPendingEvolution(): string {
  const e = pendingEvolution!
  return `<div class="evolution-proposal">
    <div class="ep-head"><span class="eyebrow">PROPOSED EDIT · ${e.field.toUpperCase()} ${e.fromMistral ? '· MISTRAL' : '· SCRIPTED'}</span><p>${esc(e.note)}</p></div>
    <div class="ep-diff">
      <div class="ep-before"><span>BEFORE</span><p>${esc(e.ruleBefore || '—')}</p></div>
      <div class="ep-arrow">→</div>
      <div class="ep-after"><span>AFTER</span><p>${esc(e.ruleAfter)}</p></div>
    </div>
    <div class="ep-actions">
      <button class="secondary-action" data-action="evo-reject">Keep current rule</button>
      <button class="primary-action" data-action="evo-accept">Apply · agent → v${(store.activeAgent()?.version ?? 1) + 1} <span>→</span></button>
    </div>
  </div>`
}

function renderEvolutionLog(a: Agent): string {
  return `<div class="evo-log">
    <div class="eyebrow">EVOLUTION LOG</div>
    ${a.history
      .slice()
      .reverse()
      .map((h, i) => {
        const m = outcomeMeta(h.outcome)
        const ver = a.version - i
        return `<div class="evo-entry">
          <div class="evo-entry-head"><span class="ver">v${ver - 1}→v${ver}</span><span class="tone-${m.tone}">${m.label}</span><i>${new Date(h.at).toLocaleDateString()}</i></div>
          <p class="evo-why">${esc(h.note)}</p>
          <p class="evo-change"><b>${h.field}:</b> ${esc(clip(h.ruleBefore, 70))} <b>→</b> ${esc(clip(h.ruleAfter, 90))}</p>
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
  // Never present a stale saved model as confirmed. Refresh is the source of truth.
  const allOptions = fetchedModels ? (options.includes(currentModel) ? options : [currentModel, ...options]) : []

  return `<div class="modal-backdrop">
    <div class="modal">
      <div class="modal-head"><h3>Mistral API key</h3><button data-action="close-settings">✕</button></div>
      <p class="modal-p">The live agent — the simulated day, the Socratic coach, and the rule-rewrites — run on <b>your own</b> Mistral key. It is stored only in this browser's localStorage and sent straight to Mistral, never to us. The whole tool still works without one; you just get scripted versions.</p>
      <p class="modal-p"><a href="https://console.mistral.ai/api-keys" target="_blank" rel="noopener">Get a Mistral key →</a> — Studio is available in Free mode by default.</p>
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
    `<div class="app-layout">${renderRail()}<main>${body}</main></div>` +
    renderCoachPanel() +
    (toast ? `<div class="toast">${esc(toast)}</div>` : '')

  // Only steal focus into the coach input right after it first appears —
  // never on every re-render, or typing there would also get interrupted.
  const ci = app.querySelector<HTMLInputElement>('[data-coach-text]')
  if (ci && !coachBusy && !lastFocusedCoachInput) {
    ci.focus()
    lastFocusedCoachInput = true
  } else if (!ci) {
    lastFocusedCoachInput = false
  }

  renderModal()
}

// The settings modal is rendered into its own root, independently of app
// re-renders, and only rebuilt when it actually needs to open/close/re-key —
// so a paste into the key field is never interrupted by an unrelated render().
let modalRendered = false

function renderModal() {
  if (!settingsOpen) {
    if (modalRendered) {
      modalRoot.innerHTML = ''
      modalRendered = false
    }
    return
  }
  if (modalRendered) return // already showing — leave the live input alone
  modalRoot.innerHTML = renderSettings()
  modalRendered = true
}

// ---------------------------------------------------------------- modal events

/**
 * Ask Google what models this key can actually reach and select a sensible
 * default from that real list — this is what prevents a hardcoded, possibly
 * region/tier-unavailable model name from
 * sitting selected indefinitely.
 */
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
      // Never override a model the user explicitly selected (or that's already
      // saved) if it's actually available to this key — only step in when the
      // current selection is confirmed dead, so "I picked 2.5" never silently
      // becomes "using 3.6" just because 3.6 is our general preference order.
      if (!currentIsAvailable) {
        // Prefer a stable, cost-effective "flash" model as the suggested default —
        // this is what a long-lived, non-preview base model looks like in Google's
        // naming: no "preview"/"exp" in the name, "flash" over "pro" for cost.
        const preferred =
          models.find((m) => /flash/i.test(m.name) && !/preview|exp|thinking/i.test(m.name)) ??
          models.find((m) => !/preview|exp/i.test(m.name)) ??
          models[0]
        if (preferred) {
          keyStore.setModel(preferred.name)
          showToast(`"${currentlySelected}" isn't available to this key — switched to ${preferred.name}.`)
        }
      } else if (opts.silent) {
        showToast(`Confirmed with Google — "${currentlySelected}" is available to this key.`)
      }
    } else {
      modelsError = 'Google returned no usable models for this key.'
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

// Isolated from app's click handler and app's render() cycle entirely, so
// nothing outside the modal can ever wipe the key input while you're pasting.
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
    showToast(keyStore.has() ? 'Mistral key saved — live agent enabled.' : 'Model saved.')
    // A freshly-entered key almost certainly hasn't had its model list checked
    // yet — this is exactly how a stale/unavailable hardcoded model name (like
    // the 404 case) gets picked. Confirm against Google right away instead of
    // silently leaving a guessed model selected until something fails.
    if (newKeyTyped) await refreshModelsForKey({ silent: true })
    return
  }
  if (action === 'clear-key') {
    keyStore.clear()
    fetchedModels = null
    modalRoot.innerHTML = renderSettings() // re-key: safe, this is a deliberate click, not a paste-in-progress
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

// Backdrop click closes the modal; clicking inside the modal box must not.
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
  const checkin = t.closest<HTMLButtonElement>('[data-checkin]')?.dataset.checkin

  if (t.closest('[data-stop]') && !action) return

  // ---- navigation
  if (action === 'home') { go('home'); return }
  if (action === 'to-choose') { go('choose'); return }
  if (action === 'to-evolve') { go('evolve'); return }
  if (action === 'to-simulate') {
    if (draftAgent && !store.getAgent(workingPatternId)) store.saveAgent(draftAgent)
    simEvents = []; simResult = null; simTwist = ''
    go('simulate'); return
  }

  // ---- settings (open only here; all in-modal actions are handled by modalRoot's own listener)
  if (action === 'settings') { settingsOpen = true; render(); return }

  // ---- choose
  if (patternId) {
    workingPatternId = patternId
    diagnosis = store.getAgent(patternId)?.diagnosis || ''
    draftAgent = null
    lessonIndex = 0; lessonPicked = null; lessonRevealed = false
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

  // ---- simulate
  if (action === 'sim-run' || action === 'sim-rerun') {
    await doSimRun(action === 'sim-rerun')
    return
  }
  if (action === 'sim-twist') {
    simTwist = await surpriseTwist(getPattern(workingPatternId))
    render()
    await doSimRun(false)
    return
  }
  if (action === 'sim-stop') { abort?.abort(); simRunning = false; render(); return }
  if (action === 'sim-tune') {
    // jump back to the builder with the live agent loaded
    draftAgent = store.activeAgent() ?? draftAgent
    go('build')
    setTimeout(() => {
      app.querySelector('.agent-builder')?.scrollIntoView({ behavior: 'smooth' })
    }, 60)
    return
  }

  // ---- evolve
  if (checkin) {
    const note = app.querySelector<HTMLTextAreaElement>('#checkin-note')?.value ?? ''
    await doCheckin(checkin as CheckinOutcome, note)
    return
  }
  if (action === 'evo-accept' && pendingEvolution) {
    const updated = store.evolveAgent(pendingEvolution)
    pendingEvolution = null
    showToast(updated ? `Agent evolved to v${updated.version}.` : 'Saved.')
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

// keep draft agent fields in sync as the user types
app.addEventListener('input', (event) => {
  const el = event.target as HTMLElement
  const field = (el as HTMLTextAreaElement).dataset?.agentField
  if (field && draftAgent) {
    ;(draftAgent as unknown as Record<string, string>)[field] = (el as HTMLTextAreaElement).value
  }
})

async function doSimRun(isRerun: boolean) {
  const agent = store.activeAgent() ?? draftAgent
  if (!agent) return
  const priorDebrief = simResult?.debrief ?? ''
  simEvents = []
  simResult = null
  simRunning = true
  abort = new AbortController()
  render()
  try {
    const onEvent = (e: SimEvent) => {
      simEvents = [...simEvents, e]
      render()
    }
    const result = isRerun
      ? await rerunDay(agent, getPattern(workingPatternId), priorDebrief, onEvent, abort.signal)
      : await runDay(agent, getPattern(workingPatternId), simTwist, onEvent, abort.signal)
    simResult = result
    simRunCount++
    store.addXp(20)
    if (result.fallbackReason) {
      showToast(`Mistral unavailable, this run was scripted: ${result.fallbackReason}`)
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      showToast('Simulation error: ' + (e as Error).message)
    }
  } finally {
    simRunning = false
    abort = null
    render()
  }
}

async function doCheckin(outcome: CheckinOutcome, note: string) {
  const agent = store.activeAgent()
  if (!agent) return
  const streak = store.addCheckin(outcome, note)
  evolving = true
  render()
  try {
    pendingEvolution = await proposeEvolution(agent, getPattern(workingPatternId), outcome, note)
  } catch (e) {
    showToast('Could not draft an edit: ' + (e as Error).message)
  } finally {
    evolving = false
    render()
    if (streak > 1) showToast(`🔥 ${streak}-day streak.`)
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
  maybeUnlock()
  return r
}) as typeof store.evolveAgent

// Another tab (or window) saved progress — re-render so this tab reflects it
// instead of silently overwriting it on its own next save.
onExternalSave(() => {
  showToast('Synced progress from another tab.')
  render()
})

render()

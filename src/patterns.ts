import type { Pattern, Lesson, DiagnosisId } from './types'

/**
 * Six loops common to engineering-student life, each with a small fixed
 * vocabulary of flags/actions and a hand-authored scenario bank (normal,
 * edge, exception, stress). The deterministic engine (engine.ts) evaluates
 * rules against these scenarios — nothing here is prose the runtime parses.
 */
export const patterns: Pattern[] = [
  {
    id: 'scroll', icon: '◒', label: 'Focus', title: 'The one-more-reel loop',
    trigger: 'A lab report is open and a short video finishes', routine: 'Tap the next video "just once"',
    reward: 'A quick hit of something funny or surprising', cost: 'The report is still blank at 1am', color: 'coral',
    scene: 'It is 9:40pm. Your lab report doc is open in the other tab, cursor blinking on section 3. The video app just autoplayed another clip. Submission is at 9am.',
    flags: [
      { id: 'deadlineWithin24h', label: 'A deadline is due within 24 hours', defaultValue: false },
      { id: 'phoneInHand', label: 'Phone/device is already in hand', defaultValue: false },
      { id: 'alreadyOnBreak', label: 'You already took a scheduled break this hour', defaultValue: false },
    ],
    actions: [
      { id: 'pause-and-prompt', label: 'Pause autoplay + show one open task', description: 'When autoplay would continue, pause it and surface the single next line of the report instead.' },
      { id: 'timer-nudge', label: 'Start a 5-minute return timer', description: 'Let the video play, but start a 5-minute timer that nudges you back to the report.' },
    ],
    scenarios: [
      { id: 'scroll-normal', patternId: 'scroll', kind: 'normal', title: 'Late-night autoplay, deadline tomorrow',
        sceneText: 'It is 9:40pm, the report is due at 9am, and a video just ended with your phone already in hand.',
        clockMin: 21 * 60 + 40, dayOfWeek: 2, flags: { deadlineWithin24h: true, phoneInHand: true, alreadyOnBreak: false }, expectedFire: true, fromMistral: false },
      { id: 'scroll-edge', patternId: 'scroll', kind: 'edge', title: 'Scheduled break, deadline tomorrow',
        sceneText: 'Same deadline pressure, but you deliberately started your one scheduled break 10 minutes ago.',
        clockMin: 21 * 60 + 40, dayOfWeek: 2, flags: { deadlineWithin24h: true, phoneInHand: true, alreadyOnBreak: true }, expectedFire: false, fromMistral: false },
      { id: 'scroll-exception', patternId: 'scroll', kind: 'exception', title: 'No deadline this week',
        sceneText: 'It is a quiet Tuesday evening with nothing due for a week. A video ends, phone in hand.',
        clockMin: 21 * 60 + 40, dayOfWeek: 2, flags: { deadlineWithin24h: false, phoneInHand: true, alreadyOnBreak: false }, expectedFire: false, fromMistral: false },
      { id: 'scroll-stress', patternId: 'scroll', kind: 'stress', title: 'Deadline in 24h, but phone is face-down across the room',
        sceneText: 'Deadline is tomorrow, but your phone is charging across the room, not in hand.',
        clockMin: 21 * 60 + 40, dayOfWeek: 2, flags: { deadlineWithin24h: true, phoneInHand: false, alreadyOnBreak: false }, expectedFire: false, fromMistral: false },
    ],
  },
  {
    id: 'gym', icon: '↗', label: 'Body', title: 'The skipped gym session',
    trigger: 'Back-to-back lectures and labs leave you drained', routine: 'Decide "tomorrow instead" and open a series',
    reward: 'Immediate relief, no cold walk to the gym', cost: 'A promise to future-you, broken again', color: 'lime',
    scene: 'It is 6:10pm. Your last lab just ended late. Your gym bag is still in your room. The couch is right there.',
    flags: [
      { id: 'labRanLate', label: 'A lab or lecture ran past its scheduled end', defaultValue: false },
      { id: 'bagPacked', label: 'Gym bag is already packed and by the door', defaultValue: false },
      { id: 'alreadyTrainedToday', label: 'You already trained earlier today', defaultValue: false },
      { id: 'isRaining', label: 'It is raining right now', defaultValue: false },
    ],
    actions: [
      { id: 'bag-by-door', label: 'Move the bag to the door before the day starts', description: 'A morning routine step: pack and stage the bag before the first class, removing the evening decision.' },
      { id: 'ten-minute-minimum', label: 'Commit to showing up for only 10 minutes', description: 'Lower the bar to just walking in and doing 10 minutes — momentum usually carries past it.' },
      { id: 'indoor-backup', label: 'Switch to a 15-minute room workout instead', description: 'Rain-proof fallback: skip the walk entirely and do a short bodyweight session wherever you are.' },
    ],
    scenarios: [
      { id: 'gym-normal', patternId: 'gym', kind: 'normal', title: 'Late lab, bag not staged',
        sceneText: 'Lab ran 40 minutes over. The gym bag is still upstairs, untouched since this morning.',
        clockMin: 18 * 60 + 10, dayOfWeek: 3, flags: { labRanLate: true, bagPacked: false, alreadyTrainedToday: false, isRaining: false }, expectedFire: true, fromMistral: false },
      { id: 'gym-edge', patternId: 'gym', kind: 'edge', title: 'Late lab, but bag already staged',
        sceneText: 'Same late lab, but the bag has been sitting packed by the door since 8am.',
        clockMin: 18 * 60 + 10, dayOfWeek: 3, flags: { labRanLate: true, bagPacked: true, alreadyTrainedToday: false, isRaining: false }, expectedFire: false, fromMistral: false },
      { id: 'gym-exception', patternId: 'gym', kind: 'exception', title: 'Already trained this morning',
        sceneText: 'Lab ran late again, but you already did a 6am session before class.',
        clockMin: 18 * 60 + 10, dayOfWeek: 3, flags: { labRanLate: true, bagPacked: false, alreadyTrainedToday: true, isRaining: false }, expectedFire: false, fromMistral: false },
      { id: 'gym-stress', patternId: 'gym', kind: 'stress', title: 'On time day, bag not staged',
        sceneText: 'No lab overrun today, everything ended on schedule, but the bag is still upstairs.',
        clockMin: 18 * 60 + 10, dayOfWeek: 3, flags: { labRanLate: false, bagPacked: false, alreadyTrainedToday: false, isRaining: false }, expectedFire: false, fromMistral: false },
      { id: 'gym-rain', patternId: 'gym', kind: 'stress', title: 'Late lab, and it is pouring outside',
        sceneText: 'Lab ran late again, and the walk to the gym is now genuinely unpleasant — it is raining hard.',
        clockMin: 18 * 60 + 10, dayOfWeek: 3, flags: { labRanLate: true, bagPacked: false, alreadyTrainedToday: false, isRaining: true }, expectedFire: true, fromMistral: false },
    ],
  },
  {
    id: 'cart', icon: '◌', label: 'Money', title: 'The 1am cart',
    trigger: 'A stressful day and one browser tab open', routine: 'Add to cart, checkout, call it a "treat"',
    reward: 'A parcel arriving in 2 days', cost: 'A thinner month and quiet regret', color: 'blue',
    scene: 'It is 12:50am. Assignments were rough today. A cart with three items is sitting open, and free shipping ends at midnight, apparently.',
    flags: [
      { id: 'cartHasItems', label: 'Cart has unpurchased items in it', defaultValue: false },
      { id: 'hadStressfulDayToday', label: 'Today included a stressful deadline or exam', defaultValue: false },
      { id: 'hasGenuineDeadlinePurchase', label: 'This purchase has a real deadline (textbook due, gift date)', defaultValue: false },
    ],
    actions: [
      { id: 'move-to-tomorrow-list', label: 'Move cart items to a "decide tomorrow" list', description: 'Clear the cart into a separate saved list and close the tab — nothing is bought tonight.' },
      { id: 'cooldown-timer', label: 'Start a 24-hour cooldown before checkout', description: 'Lock the checkout button behind a 24-hour timer that starts now.' },
    ],
    scenarios: [
      { id: 'cart-normal', patternId: 'cart', kind: 'normal', title: 'Late night, stressful day, full cart',
        sceneText: 'It is 12:50am after a genuinely rough day, and the cart has three items ready to buy.',
        clockMin: 0 * 60 + 50, dayOfWeek: 4, flags: { cartHasItems: true, hadStressfulDayToday: true, hasGenuineDeadlinePurchase: false }, expectedFire: true, fromMistral: false },
      { id: 'cart-edge', patternId: 'cart', kind: 'edge', title: 'Late night, calm day, full cart',
        sceneText: 'Same time, same cart, but today was actually a good, low-stress day.',
        clockMin: 0 * 60 + 50, dayOfWeek: 4, flags: { cartHasItems: true, hadStressfulDayToday: false, hasGenuineDeadlinePurchase: false }, expectedFire: false, fromMistral: false },
      { id: 'cart-exception', patternId: 'cart', kind: 'exception', title: 'Textbook needed for tomorrow\'s exam',
        sceneText: 'Stressful day, cart is full, but it is the required textbook for tomorrow\'s open-book exam.',
        clockMin: 0 * 60 + 50, dayOfWeek: 4, flags: { cartHasItems: true, hadStressfulDayToday: true, hasGenuineDeadlinePurchase: true }, expectedFire: false, fromMistral: false },
      { id: 'cart-stress', patternId: 'cart', kind: 'stress', title: 'Stressful day, but cart is empty',
        sceneText: 'Rough day, browser open, but nothing is actually in the cart yet — just browsing.',
        clockMin: 0 * 60 + 50, dayOfWeek: 4, flags: { cartHasItems: false, hadStressfulDayToday: true, hasGenuineDeadlinePurchase: false }, expectedFire: false, fromMistral: false },
    ],
  },
  {
    id: 'tabs', icon: '▦', label: 'Rabbit hole', title: 'The 15-tab detour',
    trigger: 'A hard part of an assignment', routine: 'Open five "quick lookup" tabs and lose the thread',
    reward: 'The feeling of being productive', cost: 'The actual assignment, still untouched', color: 'orange',
    scene: 'Your assignment doc has one paragraph you cannot finish. You just opened your seventh tab. None of them are the assignment.',
    flags: [
      { id: 'sevenPlusTabsOpen', label: 'Seven or more research tabs are open', defaultValue: false },
      { id: 'originalTaskUntouched', label: 'The original task has had no edits in 10+ minutes', defaultValue: false },
      { id: 'isScheduledResearchTime', label: 'This is deliberately scheduled research/reading time', defaultValue: false },
    ],
    actions: [
      { id: 'prompt-and-timer', label: 'Ask "what are you avoiding?" + offer a 5-min timer', description: 'Surface the original task and a short timer to re-engage with it, without closing any tabs.' },
      { id: 'snooze-tabs', label: 'Snooze all but the original task tab for 20 minutes', description: 'Temporarily hide the research tabs (not close them) for a fixed window.' },
    ],
    scenarios: [
      { id: 'tabs-normal', patternId: 'tabs', kind: 'normal', title: 'Stuck paragraph, tab explosion',
        sceneText: 'Seven tabs open, the assignment doc hasn\'t changed in 12 minutes.',
        clockMin: 14 * 60 + 20, dayOfWeek: 2, flags: { sevenPlusTabsOpen: true, originalTaskUntouched: true, isScheduledResearchTime: false }, expectedFire: true, fromMistral: false },
      { id: 'tabs-edge', patternId: 'tabs', kind: 'edge', title: 'Many tabs, but still actively writing',
        sceneText: 'Seven tabs open, but the assignment doc is being actively edited between lookups.',
        clockMin: 14 * 60 + 20, dayOfWeek: 2, flags: { sevenPlusTabsOpen: true, originalTaskUntouched: false, isScheduledResearchTime: false }, expectedFire: false, fromMistral: false },
      { id: 'tabs-exception', patternId: 'tabs', kind: 'exception', title: 'Scheduled literature review session',
        sceneText: 'This is a dedicated hour deliberately set aside for reading around the topic.',
        clockMin: 14 * 60 + 20, dayOfWeek: 2, flags: { sevenPlusTabsOpen: true, originalTaskUntouched: true, isScheduledResearchTime: true }, expectedFire: false, fromMistral: false },
      { id: 'tabs-stress', patternId: 'tabs', kind: 'stress', title: 'Doc untouched, but only 3 tabs open',
        sceneText: 'The doc hasn\'t moved in 15 minutes, but there are only three tabs open, not seven.',
        clockMin: 14 * 60 + 20, dayOfWeek: 2, flags: { sevenPlusTabsOpen: false, originalTaskUntouched: true, isScheduledResearchTime: false }, expectedFire: false, fromMistral: false },
    ],
  },
  {
    id: 'sleep', icon: '☾', label: 'Sleep', title: 'Revenge bedtime procrastination',
    trigger: 'The day felt entirely scheduled by lectures and deadlines', routine: 'Stay up to "get some time back"',
    reward: 'A few hours that feel like yours', cost: 'A slower, foggier tomorrow, then the cycle repeats', color: 'violet',
    scene: 'It is 1:15am. You know the 8am lecture is real. But today was wall-to-wall classes and labs, and this is the first hour that felt like your own.',
    flags: [
      { id: 'dayWasFullySchedule', label: 'Today had back-to-back classes/labs with no personal time', defaultValue: false },
      { id: 'hasEarlyClassTomorrow', label: 'There is a class before 9am tomorrow', defaultValue: false },
      { id: 'hadPersonalTimeToday', label: 'You already had some unscheduled personal time today', defaultValue: false },
    ],
    actions: [
      { id: 'set-cutoff', label: 'Set a fixed wind-down cutoff time', description: 'A hard stop time each night for screens, regardless of how the day went.' },
      { id: 'schedule-personal-time', label: 'Block 30 minutes of personal time earlier in the day', description: 'Proactively reserve a slot for unscheduled time before the evening, reducing the urge to reclaim it at 1am.' },
    ],
    scenarios: [
      { id: 'sleep-normal', patternId: 'sleep', kind: 'normal', title: 'Fully scheduled day, early class tomorrow',
        sceneText: 'Back-to-back classes all day, nothing personal, and an 8am lecture tomorrow.',
        clockMin: 1 * 60 + 15, dayOfWeek: 1, flags: { dayWasFullySchedule: true, hasEarlyClassTomorrow: true, hadPersonalTimeToday: false }, expectedFire: true, fromMistral: false },
      { id: 'sleep-edge', patternId: 'sleep', kind: 'edge', title: 'Fully scheduled day, no early class tomorrow',
        sceneText: 'Same packed day, but tomorrow\'s first class isn\'t until noon.',
        clockMin: 1 * 60 + 15, dayOfWeek: 5, flags: { dayWasFullySchedule: true, hasEarlyClassTomorrow: false, hadPersonalTimeToday: false }, expectedFire: false, fromMistral: false },
      { id: 'sleep-exception', patternId: 'sleep', kind: 'exception', title: 'Already had personal time today',
        sceneText: 'Packed schedule, but you had a genuine hour to yourself at lunch today.',
        clockMin: 1 * 60 + 15, dayOfWeek: 1, flags: { dayWasFullySchedule: true, hasEarlyClassTomorrow: true, hadPersonalTimeToday: true }, expectedFire: false, fromMistral: false },
      { id: 'sleep-stress', patternId: 'sleep', kind: 'stress', title: 'Light day, early class tomorrow',
        sceneText: 'Today was actually a light day with free periods, and there\'s an 8am class tomorrow.',
        clockMin: 1 * 60 + 15, dayOfWeek: 1, flags: { dayWasFullySchedule: false, hasEarlyClassTomorrow: true, hadPersonalTimeToday: false }, expectedFire: false, fromMistral: false },
    ],
  },
  {
    id: 'reply', icon: '⌁', label: 'Teamwork', title: 'The group-project ghost',
    trigger: 'A teammate message needs a real answer', routine: 'Leave it "until I know exactly what to say"',
    reward: 'Avoiding the awkward admission right now', cost: 'The team loses time, and it gets more awkward', color: 'pink',
    scene: 'Your group chat has a message from Thursday: "hey, how\'s your part of the project going?" It is now Sunday. You have not started your part.',
    flags: [
      { id: 'messageOlderThan48h', label: 'The message has been unanswered for 48+ hours', defaultValue: false },
      { id: 'messageNeedsRealAnswer', label: 'The message needs a substantive, not one-line, answer', defaultValue: false },
      { id: 'alreadyRepliedToThisThread', label: 'You already sent a reply in this thread today', defaultValue: false },
    ],
    actions: [
      { id: 'schedule-reply-slot', label: 'Block 15 minutes tomorrow AM specifically for this reply', description: 'Put a concrete calendar slot on tomorrow morning dedicated to writing the real answer.' },
      { id: 'send-holding-reply', label: 'Send a short holding reply now', description: '"Saw this — my part is behind, will have a real update by [specific time]." Buys honest time without ghosting.' },
    ],
    scenarios: [
      { id: 'reply-normal', patternId: 'reply', kind: 'normal', title: 'Three days unanswered, needs a real update',
        sceneText: 'The teammate\'s question has sat for three days and genuinely needs more than a one-liner.',
        clockMin: 20 * 60, dayOfWeek: 0, flags: { messageOlderThan48h: true, messageNeedsRealAnswer: true, alreadyRepliedToThisThread: false }, expectedFire: true, fromMistral: false },
      { id: 'reply-edge', patternId: 'reply', kind: 'edge', title: 'Only a few hours old',
        sceneText: 'The message arrived a few hours ago, well under the 48-hour mark.',
        clockMin: 20 * 60, dayOfWeek: 0, flags: { messageOlderThan48h: false, messageNeedsRealAnswer: true, alreadyRepliedToThisThread: false }, expectedFire: false, fromMistral: false },
      { id: 'reply-exception', patternId: 'reply', kind: 'exception', title: 'Already replied today',
        sceneText: 'Old message, but you already sent a substantive reply in this thread earlier today.',
        clockMin: 20 * 60, dayOfWeek: 0, flags: { messageOlderThan48h: true, messageNeedsRealAnswer: true, alreadyRepliedToThisThread: true }, expectedFire: false, fromMistral: false },
      { id: 'reply-stress', patternId: 'reply', kind: 'stress', title: 'Old message, but just needs a thumbs-up',
        sceneText: 'The message is three days old, but it only needs a quick acknowledgment, not a real update.',
        clockMin: 20 * 60, dayOfWeek: 0, flags: { messageOlderThan48h: true, messageNeedsRealAnswer: false, alreadyRepliedToThisThread: false }, expectedFire: false, fromMistral: false },
    ],
  },
]

export function getPattern(id: string): Pattern {
  return patterns.find((p) => p.id === id) ?? patterns[0]
}

export const diagnosisCopy: Record<DiagnosisId, { title: string; sub: string }> = {
  trigger: { title: 'Change the trigger', sub: 'Detect the situation earlier, before autopilot takes over — focus on conditions.' },
  routine: { title: 'Change the routine', sub: 'Keep the trigger, swap the automatic response for a better action.' },
  reward: { title: 'Change the reward', sub: 'Get a similar payoff through a cleaner action, so the old routine loses its pull.' },
}

/** Real micro-lessons. Each is teachable, has a worked example, and a check that can be wrong. */
export const lessons: Lesson[] = [
  {
    partId: 'perceive', number: '01', title: 'Perceive', kicker: 'Give it senses',
    teach:
      'An agent can only act on what it can sense, and a sense has to be something a program can actually check — a boolean flag, a time range, a day of week. "I feel like giving up" is not checkable. "No commit to the report doc in 12 minutes, and a deadline is within 24 hours" is checkable. This is the condition vocabulary your agent runs on.',
    example:
      'For the reel-scrolling loop: "I feel bored" is not a valid condition. "deadlineWithin24h = true AND phoneInHand = true" is — two flags the engine can evaluate against any scenario, with no ambiguity.',
    question: 'Which is a valid condition for a deterministic agent to check?',
    choices: [
      { id: 'a', text: '"I don\'t feel like starting the report"', correct: false,
        feedback: 'Not checkable — there is no flag or measurement behind this. A condition must map to something the engine can evaluate as true or false against a scenario.' },
      { id: 'b', text: 'deadlineWithin24h = true AND clock is between 21:00–02:00', correct: true,
        feedback: 'Exactly. Both are checkable: a boolean flag and a time range. The engine can evaluate this against any scenario with no interpretation needed.' },
      { id: 'c', text: '"It has been a stressful week"', correct: false,
        feedback: 'Too vague to encode as a flag — "stressful" would need to be decomposed into something concrete first, like a specific flag such as hadStressfulDayToday.' },
    ],
  },
  {
    partId: 'decide', number: '02', title: 'Decide', kicker: 'Give it judgment',
    teach:
      'The decision rule is: fire only if ALL listed conditions hold AND NO exception holds. This is a plain boolean expression — conditions are ANDed together, exceptions are ORed and then negated. Writing "IF X THEN Y" without an exception means the rule will misfire on legitimate edge cases, and you will learn to ignore it.',
    example:
      'For the gym pattern: conditions = [labRanLate=true, bagPacked=false], exceptions = [alreadyTrainedToday=true]. If you already trained this morning, the exception suppresses the rule even though the conditions matched.',
    question: 'A rule has conditions [A, B] and exceptions [C]. Scenario: A=true, B=true, C=true. Does it fire?',
    choices: [
      { id: 'a', text: 'Yes — both conditions are true', correct: false,
        feedback: 'Conditions matching is necessary but not sufficient. Any exception being true suppresses firing regardless of the conditions.' },
      { id: 'b', text: 'No — the exception is true, so it does not fire', correct: true,
        feedback: 'Right. fired = (all conditions met) AND (no exception met). C=true blocks firing even though A and B both hold.' },
      { id: 'c', text: 'It depends on the order the conditions were written in', correct: false,
        feedback: 'Order does not matter — conditions are combined with AND and exceptions with OR-then-negate, which are both order-independent boolean operations.' },
    ],
  },
  {
    partId: 'act', number: '03', title: 'Act', kicker: 'Give it hands',
    teach:
      'The action is chosen from a small, fixed set defined per pattern — never invented on the fly. It must be small and reversible: a heavy, irreversible action (a hard site block) invites resistance and gets disabled the first time it is inconvenient. A light action (a prompt, a timer, a staged object) survives contact with a bad day.',
    example:
      'For the tab-explosion pattern, "block every site except the doc for 2 hours" is a heavy action a user disables. "prompt-and-timer" — surfacing the original task with a 5-minute timer — is light, reversible, and does not provoke resistance.',
    question: 'Why does the agent pick its action from a fixed list instead of generating one freely each time?',
    choices: [
      { id: 'a', text: 'Because free-text actions look untidy in the UI', correct: false,
        feedback: 'That is a cosmetic reason, not the real one — the real constraint is about what the engine can execute and verify.' },
      { id: 'b', text: 'Because the engine can only run actions it knows about and can test are reversible/small', correct: true,
        feedback: 'Right. A fixed ActionSpec list means every action has been vetted as small and reversible ahead of time, and the engine can reliably reference it by id — no ambiguity about what "the action" actually does.' },
      { id: 'c', text: 'Because free-text actions would cost more API calls', correct: false,
        feedback: 'Not the reason — this constraint holds even in the fully offline, no-API-key mode.' },
    ],
  },
  {
    partId: 'learn', number: '04', title: 'Learn', kicker: 'Close the loop',
    teach:
      'Without a feedback loop, the agent is a static rule you write once and stop trusting. The learning step here is a replay: every time you edit a rule, the engine re-runs it against every scenario the agent has previously been tested on. If the edit fixes what you meant to fix but breaks something that used to work, that is a regression — and it is caught before you accept the change, not after.',
    example:
      'You narrow a condition to stop over-firing on weekends. Replay shows the narrowed rule now also misses a weekday case it used to catch. That is a regression — the fix needs another look before it is accepted, not blind acceptance.',
    question: 'An edit fixes a "missed" case but the replay shows one previously-correct scenario now fails. What should happen?',
    choices: [
      { id: 'a', text: 'Accept it anyway — it fixed the case you cared about', correct: false,
        feedback: 'That trades one bug for another silently. The whole point of replay is to make trade-offs visible before they are locked in, not to accept the first fix that looks right.' },
      { id: 'b', text: 'Treat it as a blocked evolution and revise the edit before accepting', correct: true,
        feedback: 'Yes. A regression means the edit is too broad or too narrow in the wrong dimension. Revise it — often by adding a more specific condition or exception — until replay shows no regressions.' },
      { id: 'c', text: 'Delete the regressing scenario from the test bank', correct: false,
        feedback: 'That hides the evidence instead of using it. The scenario is real signal about a case your agent needs to handle correctly.' },
    ],
  },
]

export function lessonFor(partId: string): Lesson {
  return lessons.find((l) => l.partId === partId) ?? lessons[0]
}

import type { Pattern, Lesson, DiagnosisId } from './types'

export const patterns: Pattern[] = [
  {
    id: 'scroll', icon: '◒', label: 'Attention', title: 'The one-more-video loop',
    trigger: 'Homework is open and a video finishes', routine: 'Tap the next video "just once"',
    reward: 'A quick hit of funny or surprising', cost: 'The homework is still waiting', color: 'coral',
    scene: 'It is 5:10pm. Your homework page is open, but a funny video just ended. The next one is already loading. Dinner is in an hour.',
  },
  {
    id: 'gym', icon: '↗', label: 'School', title: 'The homework dodge',
    trigger: 'A tricky question makes you stuck', routine: 'Get water, check messages, do anything else',
    reward: 'Relief from the hard question', cost: 'Less time for the fun stuff later', color: 'lime',
    scene: 'It is 6:20pm. Your maths worksheet has one question you cannot crack. Your pencil stops. Your tablet is right beside you, unlocked.',
  },
  {
    id: 'cart', icon: '◌', label: 'Choices', title: 'The snack-and-scroll loop',
    trigger: 'You feel bored while waiting', routine: 'Grab a snack and open a game',
    reward: 'Something tasty and something to do', cost: 'You miss the thing you meant to start', color: 'blue',
    scene: 'The bus is late. You have ten minutes before practice. The corner shop is nearby and your favourite game is one tap away.',
  },
  {
    id: 'tabs', icon: '▦', label: 'Focus', title: 'The tab explosion',
    trigger: 'A project gets confusing', routine: 'Open five tabs and forget the first task',
    reward: 'The feeling of being busy', cost: 'The project becomes even harder to see', color: 'orange',
    scene: 'Your science project has one confusing paragraph. You open a search tab, then a video, then three more pages. Your project is now hidden underneath them.',
  },
  {
    id: 'sleep', icon: '☾', label: 'Morning', title: 'The snooze spiral',
    trigger: 'The alarm rings on a school morning', routine: 'Snooze, hide under the blanket, snooze again',
    reward: 'A few more cosy minutes', cost: 'A rushed and grumpy start', color: 'violet',
    scene: 'It is 7:05am. Your alarm is buzzing. Your uniform is ready, but the blanket is warm and school does not start for another forty minutes.',
  },
  {
    id: 'reply', icon: '⌁', label: 'Teamwork', title: 'The group-project ghost',
    trigger: 'A teammate asks what your part is', routine: 'Leave the message until you know the perfect answer',
    reward: 'No awkward conversation right now', cost: 'The team has less time to finish', color: 'pink',
    scene: 'Your group project chat has a new message: “Who is doing the poster?” You have not started yet. Everyone can see that you read it.',
  },
]

export function getPattern(id: string): Pattern {
  return patterns.find((p) => p.id === id) ?? patterns[0]
}

export const diagnosisCopy: Record<DiagnosisId, { title: string; sub: string }> = {
  trigger: { title: 'Change the clue', sub: 'Notice the loop earlier, before autopilot takes over.' },
  routine: { title: 'Change the move', sub: 'Keep the clue, but swap the automatic action for a better one.' },
  reward: { title: 'Change the payoff', sub: 'Find a cleaner way to get the good feeling you were chasing.' },
}

/** Real micro-lessons. Each is teachable, has an example, and a check that can be wrong. */
export const lessons: Lesson[] = [
  {
    partId: 'perceive', number: '01', title: 'Perceive', kicker: 'Give it senses',
    teach:
      'An agent needs senses before it can help. A feeling like "I do not want to start" is hard for a computer to check. A clue like "the homework tab is open and no typing happened for five minutes" is observable. Pattern detectives turn fuzzy feelings into clues they can point to.',
    example:
      'For a homework helper, "I feel stuck" is vague. "The same question is open and no answer changed for five minutes" is better: earlier, observable, and something a helper can check.',
    question: 'Which is the best clue for a homework helper to notice?',
    choices: [
      { id: 'a', text: '"I feel like giving up"', correct: false,
        feedback: 'That feeling matters, but it is fuzzy and arrives late. A useful sense is something you can point to or measure.' },
      { id: 'b', text: 'The same question is open and no answer changed for five minutes', correct: true,
        feedback: 'Exactly. It is specific, observable, and early enough for the helper to offer one small next step.' },
      { id: 'c', text: 'The whole homework sheet is still unfinished', correct: false,
        feedback: 'That tells you the loop already won. A good sense spots the moment where a tiny action can still help.' },
    ],
  },
  {
    partId: 'decide', number: '02', title: 'Decide', kicker: 'Give it judgment',
    teach:
      'The decision rule should be small, written in advance, and boring. "Do the right thing" is not a rule. A rule is: IF <perceived condition> THEN <one specific move>, plus an explicit exception. Deciding in advance means you are not negotiating with yourself in the hard moment — the negotiation already happened, on your terms, when you were calm.',
    example:
      'For the one-more-video loop: "IF a video ends while homework is open, THEN pause autoplay and do one question. EXCEPTION: if homework is already finished." One move. One named exception.',
    question: 'What is wrong with the rule "IF I\'m stuck, THEN make a better choice"?',
    choices: [
      { id: 'a', text: 'Nothing — it correctly describes the goal', correct: false,
        feedback: 'A goal is not yet an agent rule. The helper needs one concrete move it can carry out.' },
      { id: 'b', text: 'It has no specific action and no exception, so it collapses into willpower', correct: true,
        feedback: 'Right. Replace "make a better choice" with one move, such as pausing autoplay and doing one question, then name when that rule should not fire.' },
      { id: 'c', text: 'Being stuck is impossible to notice', correct: false,
        feedback: 'Being stuck can be noticed through clues: no typing, the same question open, or repeated tab switching.' },
    ],
  },
  {
    partId: 'act', number: '03', title: 'Act', kicker: 'Give it hands',
    teach:
      'The action must be small, reversible, and low-drama. Big irreversible moves ("delete all social apps forever") trigger resistance and get undone within a week. The agent\'s job is not to win the war in one move — it is to reliably insert one gentle piece of friction or one nudge, every time, so the better path becomes the easy path.',
    example:
      'Weak act: "lock every game until Friday" (drastic, you will disable it). Strong act: "pause the game and show one five-minute homework challenge" — a tiny on-ramp that is reversible and repeatable.',
    question: 'Your "tab explosion" agent needs an action. Which is the right kind of move?',
    choices: [
      { id: 'a', text: 'A site blocker that locks you out of everything but the document for 2 hours', correct: false,
        feedback: 'Too drastic and not reversible in the moment. The first time you genuinely need to look something up, you disable it — and it stays disabled. Resistance kills big moves.' },
      { id: 'b', text: 'When a 7th tab opens, a note pops up: "what sentence are you avoiding?" and offers a 5-min timer', correct: true,
        feedback: 'Small, reversible, repeatable. It does not stop you — it re-surfaces the real task and offers a tiny on-ramp. You can ignore it, but every time it makes the avoidance conscious.' },
      { id: 'c', text: 'A rule that you must finish the document before lunch or skip lunch', correct: false,
        feedback: 'Punishment, not friction. It adds stakes and dread, which usually makes the avoidance worse. The act should lower the cost of the good path, not raise the cost of the bad one.' },
    ],
  },
  {
    partId: 'learn', number: '04', title: 'Learn', kicker: 'Close the loop',
    teach:
      'Without a learning rule, the agent is a static habit tracker and you stop opening it. The learning rule takes each real outcome — it fired and helped, it fired and annoyed you, it missed entirely — and rewrites one part of the agent. Over weeks the agent stops being someone\'s generic advice and becomes specifically yours. That evolution is the reason to come back.',
    example:
      'Outcome: "the five-minute challenge fired, but it was too big and I ignored it." Learning rule output: tighten the *act* step — make the first challenge one easy question. The agent got more useful because reality pushed back.',
    question: 'After a check-in where the agent "fired but annoyed you", what should the learning rule usually do?',
    choices: [
      { id: 'a', text: 'Delete that agent and start over', correct: false,
        feedback: 'Throwing it out loses everything it learned. "Annoyed you" is signal, not failure — it means one part is slightly wrong, usually the act being too heavy or the trigger too broad.' },
      { id: 'b', text: 'Make the action gentler or the trigger narrower, and log why', correct: true,
        feedback: 'Yes. Annoyance almost always means over-firing: soften the act or tighten the perceive condition so it only fires when it truly matters, and record the reason so the next edit has context.' },
      { id: 'c', text: 'Make the action stronger so it works next time', correct: false,
        feedback: 'That is the instinct, and it is usually wrong. A stronger action on an already-annoying agent gets the whole thing switched off. Escalate only after "missed", never after "annoyed".' },
    ],
  },
]

export function lessonFor(partId: string): Lesson {
  return lessons.find((l) => l.partId === partId) ?? lessons[0]
}

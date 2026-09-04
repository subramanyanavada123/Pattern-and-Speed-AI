import { describe, it, expect } from 'vitest'
import { evaluateCondition, matchScenario, scorePrediction, scoreAgent, checkRegression, isValidRuleSet, isValidScenario, formatClock, describeCondition } from './engine'
import type { Condition, RuleSet, Scenario, FlagSpec, ActionSpec } from './types'

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 's1', patternId: 'gym', kind: 'normal', title: 't', sceneText: 'x',
    clockMin: 12 * 60, dayOfWeek: 1, flags: {}, expectedFire: true, fromMistral: false,
    ...overrides,
  }
}

describe('evaluateCondition', () => {
  it('matches a simple time-in-range', () => {
    const c: Condition = { type: 'time-in-range', fromMin: 600, toMin: 720 }
    expect(evaluateCondition(c, scenario({ clockMin: 650 }))).toBe(true)
    expect(evaluateCondition(c, scenario({ clockMin: 800 }))).toBe(false)
  })

  it('handles a time range that wraps past midnight', () => {
    const c: Condition = { type: 'time-in-range', fromMin: 23 * 60 + 30, toMin: 2 * 60 } // 23:30–02:00
    expect(evaluateCondition(c, scenario({ clockMin: 23 * 60 + 45 }))).toBe(true) // 23:45
    expect(evaluateCondition(c, scenario({ clockMin: 60 }))).toBe(true) // 01:00
    expect(evaluateCondition(c, scenario({ clockMin: 12 * 60 }))).toBe(false) // noon
    expect(evaluateCondition(c, scenario({ clockMin: 23 * 60 }))).toBe(false) // 23:00, just before window
  })

  it('is inclusive at both range boundaries', () => {
    const c: Condition = { type: 'time-in-range', fromMin: 600, toMin: 720 }
    expect(evaluateCondition(c, scenario({ clockMin: 600 }))).toBe(true)
    expect(evaluateCondition(c, scenario({ clockMin: 720 }))).toBe(true)
  })

  it('matches day-of-week', () => {
    const c: Condition = { type: 'day-of-week', days: [0, 6] }
    expect(evaluateCondition(c, scenario({ dayOfWeek: 6 }))).toBe(true)
    expect(evaluateCondition(c, scenario({ dayOfWeek: 3 }))).toBe(false)
  })

  it('matches a flag, both equals true and equals false', () => {
    const isTrue: Condition = { type: 'flag', flag: 'isRaining', equals: true }
    const isFalse: Condition = { type: 'flag', flag: 'isRaining', equals: false }
    expect(evaluateCondition(isTrue, scenario({ flags: { isRaining: true } }))).toBe(true)
    expect(evaluateCondition(isTrue, scenario({ flags: { isRaining: false } }))).toBe(false)
    expect(evaluateCondition(isFalse, scenario({ flags: { isRaining: false } }))).toBe(true)
  })

  it('treats a missing flag as false', () => {
    const c: Condition = { type: 'flag', flag: 'unset', equals: true }
    expect(evaluateCondition(c, scenario({ flags: {} }))).toBe(false)
  })
})

describe('matchScenario', () => {
  const rules: RuleSet = {
    conditions: [
      { type: 'time-in-range', fromMin: 23 * 60 + 30, toMin: 2 * 60 },
      { type: 'flag', flag: 'phoneInBedroom', equals: true },
    ],
    exceptions: [{ type: 'flag', flag: 'onCallTonight', equals: true }],
    actionId: 'move-charger',
  }

  it('fires when all conditions hold and no exception holds', () => {
    const s = scenario({ clockMin: 60, flags: { phoneInBedroom: true, onCallTonight: false } })
    const trace = matchScenario(rules, s)
    expect(trace.fired).toBe(true)
    expect(trace.actionId).toBe('move-charger')
  })

  it('does not fire when one condition fails', () => {
    const s = scenario({ clockMin: 60, flags: { phoneInBedroom: false, onCallTonight: false } })
    const trace = matchScenario(rules, s)
    expect(trace.fired).toBe(false)
    expect(trace.actionId).toBeNull()
  })

  it('does not fire when an exception holds, even if all conditions hold', () => {
    const s = scenario({ clockMin: 60, flags: { phoneInBedroom: true, onCallTonight: true } })
    const trace = matchScenario(rules, s)
    expect(trace.fired).toBe(false)
  })

  it('never fires with zero conditions (an empty AND is not vacuously true here)', () => {
    const empty: RuleSet = { conditions: [], exceptions: [], actionId: 'x' }
    const trace = matchScenario(empty, scenario())
    expect(trace.fired).toBe(false)
  })

  it('trace records the met/unmet state of every individual condition and exception', () => {
    const s = scenario({ clockMin: 60, flags: { phoneInBedroom: false, onCallTonight: true } })
    const trace = matchScenario(rules, s)
    expect(trace.conditions).toHaveLength(2)
    expect(trace.conditions[0].met).toBe(true) // time
    expect(trace.conditions[1].met).toBe(false) // phoneInBedroom
    expect(trace.exceptions[0].met).toBe(true) // onCallTonight
  })
})

describe('scorePrediction', () => {
  it('is correct when prediction matches firing', () => {
    expect(scorePrediction({ conditions: [], exceptions: [], fired: true, actionId: 'a' }, true)).toBe('correct')
    expect(scorePrediction({ conditions: [], exceptions: [], fired: false, actionId: null }, false)).toBe('correct')
  })
  it('is missed when it fired but user predicted no-fire... wait, missed means engine did not fire but should have', () => {
    // scorePrediction only knows the ENGINE's fired state vs the USER's prediction, not ground truth.
    expect(scorePrediction({ conditions: [], exceptions: [], fired: false, actionId: null }, true)).toBe('missed')
  })
  it('is over-fired when engine fired but user predicted no-fire', () => {
    expect(scorePrediction({ conditions: [], exceptions: [], fired: true, actionId: 'a' }, false)).toBe('over-fired')
  })
})

describe('scoreAgent', () => {
  it('scores the agent against scenario ground truth, even when the learner predicted it correctly', () => {
    const overFiringTrace = { conditions: [], exceptions: [], fired: true, actionId: 'a' }
    expect(scoreAgent(overFiringTrace, false)).toBe('over-fired')
  })

  it('marks a correctly firing agent as correct against ground truth', () => {
    const firingTrace = { conditions: [], exceptions: [], fired: true, actionId: 'a' }
    expect(scoreAgent(firingTrace, true)).toBe('correct')
  })
})

describe('checkRegression', () => {
  const scenarios: Scenario[] = [
    scenario({ id: 'a', clockMin: 60, flags: { phoneInBedroom: true }, expectedFire: true }),
    scenario({ id: 'b', clockMin: 12 * 60, flags: { phoneInBedroom: true }, expectedFire: false }),
  ]

  it('flags a scenario that used to pass and now fails as a regression', () => {
    const looseRules: RuleSet = { conditions: [{ type: 'flag', flag: 'phoneInBedroom', equals: true }], exceptions: [], actionId: 'x' }
    // Under looseRules, scenario 'b' (noon) now ALSO fires, which is wrong (expectedFire: false) —
    // and 'b' was previously correct (passedBefore true) under some narrower rule, so this is a regression.
    const result = checkRegression(looseRules, scenarios, new Set(['a', 'b']))
    const bCheck = result.find((r) => r.scenarioId === 'b')!
    expect(bCheck.passedBefore).toBe(true)
    expect(bCheck.passedAfter).toBe(false)
  })

  it('does not flag a scenario that was already failing before the edit', () => {
    const looseRules: RuleSet = { conditions: [{ type: 'flag', flag: 'phoneInBedroom', equals: true }], exceptions: [], actionId: 'x' }
    const result = checkRegression(looseRules, scenarios, new Set(['a'])) // 'b' was NOT previously correct
    const bCheck = result.find((r) => r.scenarioId === 'b')!
    expect(bCheck.passedBefore).toBe(false)
    expect(bCheck.passedAfter).toBe(false) // still fails, but that's not a NEW regression
  })

  it('passes a scenario that remains correct under the new rules', () => {
    const tightRules: RuleSet = {
      conditions: [{ type: 'time-in-range', fromMin: 23 * 60, toMin: 4 * 60 }, { type: 'flag', flag: 'phoneInBedroom', equals: true }],
      exceptions: [], actionId: 'x',
    }
    const result = checkRegression(tightRules, scenarios, new Set(['a', 'b']))
    const aCheck = result.find((r) => r.scenarioId === 'a')!
    expect(aCheck.passedBefore).toBe(true)
    expect(aCheck.passedAfter).toBe(true)
  })
})

describe('isValidRuleSet', () => {
  const pattern = {
    flags: [{ id: 'phoneInBedroom', label: 'x', defaultValue: false }] as FlagSpec[],
    actions: [{ id: 'move-charger', label: 'x', description: 'x' }] as ActionSpec[],
  }

  it('accepts a well-formed rule set using known flags and actions', () => {
    const rs = { conditions: [{ type: 'flag', flag: 'phoneInBedroom', equals: true }], exceptions: [], actionId: 'move-charger' }
    expect(isValidRuleSet(rs, pattern)).toBe(true)
  })

  it('rejects a rule set referencing an unknown flag', () => {
    const rs = { conditions: [{ type: 'flag', flag: 'madeUpFlag', equals: true }], exceptions: [], actionId: 'move-charger' }
    expect(isValidRuleSet(rs, pattern)).toBe(false)
  })

  it('rejects a rule set referencing an unknown action', () => {
    const rs = { conditions: [], exceptions: [], actionId: 'not-a-real-action' }
    expect(isValidRuleSet(rs, pattern)).toBe(false)
  })

  it('rejects malformed shapes without throwing', () => {
    expect(isValidRuleSet(null, pattern)).toBe(false)
    expect(isValidRuleSet('a string', pattern)).toBe(false)
    expect(isValidRuleSet({}, pattern)).toBe(false)
    expect(isValidRuleSet({ conditions: 'nope', exceptions: [], actionId: 'move-charger' }, pattern)).toBe(false)
  })

  it('rejects an out-of-range time condition', () => {
    const rs = { conditions: [{ type: 'time-in-range', fromMin: -5, toMin: 100 }], exceptions: [], actionId: 'move-charger' }
    expect(isValidRuleSet(rs, pattern)).toBe(false)
  })
})

describe('isValidScenario', () => {
  const pattern = { flags: [{ id: 'isRaining', label: 'x', defaultValue: false }] as FlagSpec[] }

  it('accepts a well-formed scenario', () => {
    const s = { title: 't', sceneText: 's', clockMin: 100, dayOfWeek: 2, flags: { isRaining: true }, expectedFire: true }
    expect(isValidScenario(s, pattern)).toBe(true)
  })

  it('rejects a scenario referencing an unknown flag', () => {
    const s = { title: 't', sceneText: 's', clockMin: 100, dayOfWeek: 2, flags: { notAFlag: true }, expectedFire: true }
    expect(isValidScenario(s, pattern)).toBe(false)
  })

  it('rejects out-of-range clock/day values', () => {
    expect(isValidScenario({ title: 't', sceneText: 's', clockMin: 5000, dayOfWeek: 2, flags: {}, expectedFire: true }, pattern)).toBe(false)
    expect(isValidScenario({ title: 't', sceneText: 's', clockMin: 100, dayOfWeek: 9, flags: {}, expectedFire: true }, pattern)).toBe(false)
  })
})

describe('formatClock', () => {
  it('formats minutes-since-midnight as HH:MM', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(90)).toBe('01:30')
    expect(formatClock(23 * 60 + 59)).toBe('23:59')
  })
})

describe('describeCondition', () => {
  const flags: FlagSpec[] = [{ id: 'isRaining', label: 'It is raining', defaultValue: false }]

  it('describes a time range', () => {
    expect(describeCondition({ type: 'time-in-range', fromMin: 60, toMin: 120 }, flags)).toContain('01:00')
  })
  it('describes a flag using its label', () => {
    expect(describeCondition({ type: 'flag', flag: 'isRaining', equals: true }, flags)).toBe('It is raining')
    expect(describeCondition({ type: 'flag', flag: 'isRaining', equals: false }, flags)).toContain('NOT')
  })
})

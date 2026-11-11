import { describe, expect, it } from 'vitest'
import { closestMealTime, initialMealTimeState, transitionMealTime } from './mealTime'

describe('cash food expense time', () => {
  it('selects the nearest of 08:00, 12:00 and 18:00, including future slots and earlier ties', () => {
    expect(['07:00', '10:00', '11:30', '15:00', '16:30', '19:00'].map(closestMealTime))
      .toEqual(['08:00', '08:00', '12:00', '12:00', '18:00', '18:00'])
  })

  it('restores the clock captured when eligibility began, then recalculates on re-entry', () => {
    const entered = transitionMealTime('11:00', initialMealTimeState(), true, '12:10', true)
    expect(entered.time).toBe('12:00')
    const left = transitionMealTime(entered.time, entered.state, false, '12:20', true)
    expect(left.time).toBe('12:10')
    const returned = transitionMealTime(left.time, left.state, true, '16:30', true)
    expect(returned.time).toBe('18:00')
    expect(returned.state.everEligible).toBe(true)
  })

  it('does not overwrite a manually chosen time or round an edited record', () => {
    const entered = transitionMealTime('11:30', initialMealTimeState(), true, '11:30', true)
    const manual = { ...entered.state, manuallyChanged: true }
    expect(transitionMealTime('13:00', manual, false, '11:40', true).time).toBe('13:00')
    expect(transitionMealTime('09:17', initialMealTimeState(), true, '11:30', false).time).toBe('09:17')
  })
})

/** The three approximate times used only when starting a cash-paid food expense. */
const MEAL_TIMES = ['08:00', '12:00', '18:00'] as const

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))

/** Nearest clock time wins; a tie keeps the earlier time. */
export function closestMealTime(clock: string): string {
  const current = minutes(clock)
  return MEAL_TIMES.reduce<string>((best, candidate) =>
    Math.abs(minutes(candidate) - current) < Math.abs(minutes(best) - current) ? candidate : best,
  MEAL_TIMES[0])
}

export interface MealTimeState {
  eligible: boolean
  everEligible: boolean
  manuallyChanged: boolean
  /** The clock at the moment eligibility began, restored if the user switches away. */
  originalTime?: string
}

export const initialMealTimeState = (): MealTimeState => ({ eligible: false, everEligible: false, manuallyChanged: false })

/** A draft transition. `automatic` is false for edits, which keep their recorded time. */
export function transitionMealTime(
  time: string,
  state: MealTimeState,
  eligible: boolean,
  clock: string,
  automatic: boolean,
): { time: string; state: MealTimeState } {
  if (eligible === state.eligible) return { time, state }
  const next: MealTimeState = { ...state, eligible, everEligible: state.everEligible || eligible }
  if (!automatic || state.manuallyChanged) return { time, state: next }
  if (eligible) return { time: closestMealTime(clock), state: { ...next, originalTime: clock } }
  return { time: state.originalTime ?? time, state: { ...next, originalTime: undefined } }
}

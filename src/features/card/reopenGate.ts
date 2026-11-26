export type ReopenGate = {
  phase: 'locked' | 'unlocked' | 'confirming'
  taps: number
  lastTapAt: number | null
  lastActivityAt: number | null
}

export const initialReopenGate: ReopenGate = { phase: 'locked', taps: 0, lastTapAt: null, lastActivityAt: null }

export function advanceReopenGate(gate: ReopenGate, now: number): ReopenGate {
  if (gate.phase === 'confirming') return gate
  const expired = gate.phase === 'unlocked' && gate.lastActivityAt !== null && now - gate.lastActivityAt >= 10_000
  const current = expired ? initialReopenGate : gate
  const continuous = current.lastTapAt !== null && now - current.lastTapAt <= 2_000
  const taps = continuous ? current.taps + 1 : 1
  if (current.phase === 'locked' && taps >= 10) return { phase: 'unlocked', taps: 0, lastTapAt: null, lastActivityAt: now }
  if (current.phase === 'unlocked' && taps >= 5) return { phase: 'confirming', taps: 0, lastTapAt: null, lastActivityAt: now }
  return { ...current, taps, lastTapAt: now, lastActivityAt: now }
}

export function cancelReopenGate(gate: ReopenGate, now: number): ReopenGate {
  return gate.phase === 'confirming'
    ? { phase: 'unlocked', taps: 0, lastTapAt: null, lastActivityAt: now }
    : gate
}

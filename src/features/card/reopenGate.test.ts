import { describe, expect, it } from 'vitest'
import { advanceReopenGate, cancelReopenGate, initialReopenGate, type ReopenGate } from './reopenGate'

describe('reconciliation reopen gate', () => {
  it('needs ten quick taps to unlock and five more to request confirmation', () => {
    let gate = initialReopenGate
    for (let i = 0; i < 9; i++) gate = advanceReopenGate(gate, i * 100)
    expect(gate.phase).toBe('locked')
    gate = advanceReopenGate(gate, 900)
    expect(gate.phase).toBe('unlocked')
    for (let i = 0; i < 4; i++) gate = advanceReopenGate(gate, 1000 + i * 100)
    expect(gate.phase).toBe('unlocked')
    expect(advanceReopenGate(gate, 1400).phase).toBe('confirming')
  })

  it('restarts the current stage after a two-second gap', () => {
    let gate = advanceReopenGate(initialReopenGate, 0)
    gate = advanceReopenGate(gate, 2001)
    expect(gate.taps).toBe(1)
    for (let i = 2; i <= 10; i++) gate = advanceReopenGate(gate, 2001 + i * 100)
    expect(gate.phase).toBe('unlocked')
    gate = advanceReopenGate(gate, 4000)
    gate = advanceReopenGate(gate, 6001)
    expect(gate.taps).toBe(1)
  })

  it('cancelling confirmation keeps the button unlocked but restarts five taps', () => {
    let gate: ReopenGate = { phase: 'unlocked', taps: 4, lastTapAt: 100, lastActivityAt: 100 }
    gate = advanceReopenGate(gate, 200)
    const cancelled = cancelReopenGate(gate, 300)
    expect(cancelled).toEqual({ phase: 'unlocked', taps: 0, lastTapAt: null, lastActivityAt: 300 })
  })

  it('returns to the locked stage after ten seconds without activity', () => {
    const unlocked: ReopenGate = { phase: 'unlocked', taps: 2, lastTapAt: 100, lastActivityAt: 100 }
    expect(advanceReopenGate(unlocked, 10_100)).toEqual({ phase: 'locked', taps: 1, lastTapAt: 10_100, lastActivityAt: 10_100 })
  })
})

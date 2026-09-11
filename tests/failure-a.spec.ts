/**
 * FAILURE TEST A — confidently wrong evidence. Caught.
 *
 * The scenario: a customer wants $1,240 back for a laptop they say they
 * returned. Our warehouse system has a receipt scan saying the return was
 * booked in, and that scan carries 95% source confidence — the strongest piece
 * of evidence in the room by some distance.
 *
 * It is also 41 days old, and the carrier's tracking, scanned six hours ago,
 * says the parcel is still in transit. The warehouse scan was a mis-scan of a
 * different parcel.
 *
 * An engine that reads confidence without reading freshness pays out $1,240 to
 * someone still holding the laptop. This test pins both halves: that the naive
 * reading executes, and that ours does not, and exactly which mechanism stops
 * it.
 */

import { describe, expect, it } from 'vitest'
import { naiveDecide } from '@/core/naive'
import { halfLifeFor, scoreSignals } from '@/core/scoring'
import { registry } from '@/engine'
import { refundsPolicy } from '@/policies/refunds.policy'
import { fixtureById } from '@/fixtures'
import { decideFixture } from './support'

const fixture = fixtureById('refund-stale-warehouse-receipt')!

describe('failure A: a 41-day-old record that still says 95%', () => {
  it('the naive reading executes, paying out $1,240', async () => {
    const signals = await registry.refunds.gather(fixture.envelope)
    const naive = naiveDecide(signals)

    expect(naive.outcome).toBe('execute')
    // It leans on exactly the signal you would expect it to lean on.
    expect(naive.dominantSignal).toBe('return_received_at_warehouse')
    expect(naive.confidence).toBeGreaterThanOrEqual(0.75)
  })

  it('our engine asks instead', async () => {
    const decision = await decideFixture(fixture)
    expect(decision.outcome).toBe('ask')
    expect(decision.confidence).toBeLessThan(refundsPolicy.thresholds.minConfidence)
    expect(decision.support).toBeLessThan(refundsPolicy.thresholds.minSupport)
  })

  it('mechanism 1: freshness decay strips the stale scan of almost all its weight', async () => {
    const signals = await registry.refunds.gather(fixture.envelope)
    const scored = scoreSignals(signals, refundsPolicy)
    const warehouse = scored.find((s) => s.signal.name === 'return_received_at_warehouse')!

    // 41 days against a 7-day half-life is just under six halvings.
    expect(warehouse.signal.freshnessSec).toBeGreaterThan(40 * 86400)
    expect(halfLifeFor(refundsPolicy, 'return_received_at_warehouse')).toBe(7 * 86400)
    expect(warehouse.signal.confidence).toBeGreaterThan(0.9)
    expect(warehouse.effectiveConfidence).toBeLessThan(0.03)
    expect(warehouse.stale).toBe(true)

    // The carrier scan, six hours old, keeps most of what it had.
    const carrier = scored.find((s) => s.signal.name === 'return_carrier_status')!
    expect(carrier.effectiveConfidence).toBeGreaterThan(0.7)
    expect(carrier.stale).toBe(false)
  })

  it('mechanism 2: the two sources are recorded as contradicting, not averaged', async () => {
    const decision = await decideFixture(fixture)
    const clash = decision.contradictions.find((c) => c.proposition === 'return_in_our_possession')

    expect(clash).toBeDefined()
    expect(clash!.explanation).toContain('return_received_at_warehouse')
    expect(clash!.explanation).toContain('return_carrier_status')

    // Honest about scale: decay has already settled this disagreement, so the
    // contradiction penalty itself is small. Recording it still matters — the
    // reviewer needs to see that two systems disagreed.
    expect(clash!.severity).toBeLessThan(0.1)
  })

  it('mechanism 3: it asks the one question that would actually resolve it', async () => {
    const decision = await decideFixture(fixture)
    const gap = decision.missingInformation.find((g) => g.field === 'return_tracking_number')!

    expect(gap.blocking).toBe(true)
    expect(gap.obtainableBy).toBe('user')
    expect(gap.question).toContain('tracking number')
    expect(decision.summary).toContain('tracking number')
  })

  it('the counterfactual names the staleness in plain language', async () => {
    const decision = await decideFixture(fixture)
    const refresh = decision.counterfactual.find((c) => c.id === 'fresh:return_received_at_warehouse')

    expect(refresh).toBeDefined()
    expect(refresh!.label).toContain('41 days')
  })
})

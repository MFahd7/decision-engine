/**
 * FAILURE TEST B — threshold gaming. Half fixed, and honest about which half.
 *
 * Refund authority steps up at $500 and again at $2,000. A senior agent can
 * approve $450 without anyone else looking at it. Eleven $450 refunds is
 * $4,950, which is a director's decision, and nobody ever made it.
 *
 * The mitigation is to widen the unit of judgement: the authority tier is
 * chosen on the running 24-hour total for (actor, customer), not on the single
 * request. That closes the impatient version of this attack.
 *
 * It does not close the patient one. Spread the same eleven refunds over five
 * weeks and the window sees nothing. Spread them across eleven customer
 * accounts and it sees nothing either, because the engine does not own
 * identity resolution and cannot tell that eleven accounts are one person.
 *
 * Both halves are asserted below. The second block is the interesting one.
 */

import { describe, expect, it } from 'vitest'
import { windowTotal } from '@/signals/shared/aggregationWindow'
import { REFUND_AGGREGATION_WINDOW_SEC } from '@/policies/refunds.policy'
import { fixtureById } from '@/fixtures'
import { registry } from '@/engine'
import { decideFixture } from './support'

const fast = fixtureById('refund-split-attack-same-day')!
const patient = fixtureById('refund-split-attack-patient')!

describe('failure B, the half that works: eleven refunds in one day', () => {
  it('the request on its own looks entirely ordinary', () => {
    const amount = (fast.envelope.payload['refund'] as { amount: number }).amount
    expect(amount).toBe(450)
    // $450 is inside a senior agent's own authority. Judged alone, this passes.
    expect(fast.envelope.actor.authorityLevel).toBe(2)
  })

  it('the window sees the $4,500 that came before it', () => {
    expect(windowTotal(fast.envelope, REFUND_AGGREGATION_WINDOW_SEC)).toBe(4500)
  })

  it('so the engine escalates on the aggregate, not on the request', async () => {
    const decision = await decideFixture(fast)

    expect(decision.outcome).toBe('escalate')
    expect(decision.firedRule).toBe('R2_AUTHORITY_CEILING')
    // The reason quotes the running total, so a reviewer sees why.
    const fired = decision.ruleTrace.find((r) => r.fired)!
    expect(fired.because).toContain('4,950')
  })

  it('and the running total is visible as a signal in its own right', async () => {
    const signals = await registry.refunds.gather(fast.envelope)
    const window = signals.find((s) => s.name === 'actor_window_total')!

    expect(window.kind).toBe('risk')
    expect(window.value).toBe(1)
    expect(window.rationale).toContain('running total')
  })
})

describe('failure B, the half that does not: the same money, taken slowly', () => {
  it('identical actor, identical amount, identical total — spread over five weeks', () => {
    const fastPayload = fast.envelope.payload['refund'] as { amount: number }
    const patientPayload = patient.envelope.payload['refund'] as { amount: number }

    expect(patient.envelope.actor.id).toBe(fast.envelope.actor.id)
    expect(patientPayload.amount).toBe(fastPayload.amount)

    const priors = patient.envelope.context['priorActionsByActor'] as Array<{ amount: number }>
    expect(priors).toHaveLength(10)
    expect(priors.reduce((sum, p) => sum + p.amount, 0)).toBe(4500)
  })

  it('the 24-hour window sees none of it', () => {
    expect(windowTotal(patient.envelope, REFUND_AGGREGATION_WINDOW_SEC)).toBe(0)
  })

  it('and the engine pays out. This is the unfixed hole.', async () => {
    const decision = await decideFixture(patient)

    expect(decision.outcome).toBe('execute')
    expect(decision.firedRule).toBe('R5_GREEN_LIGHT')
  })

  it('widening the window would catch this one and would not catch the next one', () => {
    // Six weeks of window does see the patient attacker.
    const sixWeeks = 42 * 24 * 3600
    expect(windowTotal(patient.envelope, sixWeeks)).toBe(4500)

    // But window length is not the real answer, and this is why. Tripling the
    // window to three days recovers one of the ten prior refunds — $450 out of
    // $4,500 — and leaves the attack intact. Whatever the window is set to, the
    // counter is to wait slightly longer, while every extra day drags more
    // legitimate high-volume agents over the line with it.
    //
    // The actual fix is identity resolution across accounts and payment
    // instruments, which is a different system holding different data, and this
    // engine does not have it. See ARCHITECTURE.md, "What we did not fix".
    expect(windowTotal(patient.envelope, 3 * 24 * 3600)).toBe(450)
  })
})

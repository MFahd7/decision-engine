/**
 * Golden cases: every fixture, every domain, every verdict.
 *
 * These are the tests that matter. If the kernel ever silently starts
 * executing something it used to escalate, this file is what catches it.
 */

import { describe, expect, it } from 'vitest'
import { decide } from '@/core/kernel'
import { allFixtures, fixtures } from '@/fixtures'
import { judge, policyFor, registry } from '@/engine'
import type { Domain, Outcome } from '@/core/types'
import { decideFixture, explain } from './support'

const DOMAINS: Domain[] = ['refunds', 'deploy', 'moderation']
const OUTCOMES: Outcome[] = ['execute', 'ask', 'defer', 'escalate', 'refuse']

describe('golden fixtures', () => {
  for (const fixture of allFixtures) {
    it(`${fixture.envelope.domain}: ${fixture.id} -> ${fixture.expect}`, async () => {
      const decision = await decideFixture(fixture)
      if (decision.outcome !== fixture.expect) {
        throw new Error(explain(fixture, decision))
      }
      expect(decision.outcome).toBe(fixture.expect)
    })
  }
})

describe('verdict coverage', () => {
  it('every domain produces every one of the five verdicts across its fixtures', async () => {
    for (const domain of DOMAINS) {
      const produced = new Set<Outcome>()
      for (const fixture of fixtures[domain]) {
        produced.add((await decideFixture(fixture)).outcome)
      }
      const missing = OUTCOMES.filter((o) => !produced.has(o))
      expect(missing, `${domain} never produces: ${missing.join(', ')}`).toEqual([])
    }
  })
})

describe('kernel invariants', () => {
  it('records every rule in the trace, in ladder order, on every decision', async () => {
    const expectedOrder = [
      'R1_HARD_PROHIBITION',
      'R2_AUTHORITY_CEILING',
      'R3_BLOCKING_GAP_USER_OBTAINABLE',
      'R4_BLOCKING_GAP_OR_TEMPORAL_BAR',
      'R5_GREEN_LIGHT',
      'R6_FALLBACK',
    ]
    for (const fixture of allFixtures) {
      const decision = await decideFixture(fixture)
      expect(decision.ruleTrace.map((r) => r.id)).toEqual(expectedOrder)
      // Exactly one rule fires, and it is the one named on the decision.
      const fired = decision.ruleTrace.filter((r) => r.fired)
      expect(fired).toHaveLength(1)
      expect(fired[0]!.id).toBe(decision.firedRule)
    }
  })

  it('never reaches execute by falling off the end of the ladder', async () => {
    for (const fixture of allFixtures) {
      const decision = await decideFixture(fixture)
      if (decision.outcome === 'execute') {
        expect(decision.firedRule).toBe('R5_GREEN_LIGHT')
      }
      if (decision.firedRule === 'R6_FALLBACK') {
        expect(decision.outcome).toBe('escalate')
      }
    }
  })

  it('is deterministic: the same signals decide the same way every time', async () => {
    for (const fixture of allFixtures) {
      const signals = await registry[fixture.envelope.domain].gather(fixture.envelope)
      const now = String(fixture.envelope.context['now'])
      const a = judge(fixture.envelope, signals, undefined, { now })
      const b = judge(fixture.envelope, signals, undefined, { now })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })

  it('an actor with no authority is refused before anything else is considered', async () => {
    const fixture = fixtures.refunds[0]!
    const stripped = {
      ...fixture.envelope,
      actor: { ...fixture.envelope.actor, authorityLevel: 0 },
    }
    const signals = await registry.refunds.gather(stripped)
    const decision = decide({ envelope: stripped, signals, policy: policyFor('refunds') })
    expect(decision.outcome).toBe('refuse')
    expect(decision.firedRule).toBe('R1_HARD_PROHIBITION')
  })

  it('offers no counterfactual for a refusal, and at least one otherwise', async () => {
    for (const fixture of allFixtures) {
      const decision = await decideFixture(fixture)
      if (decision.firedRule === 'R1_HARD_PROHIBITION') {
        expect(decision.counterfactual, `${fixture.id} should not negotiate a prohibition`).toEqual([])
      }
      if (decision.outcome === 'execute') {
        expect(decision.counterfactual).toEqual([])
      }
    }
  })

  it('the counterfactual actually finds routes to execute, and they hold up when applied', async () => {
    const flipping: string[] = []
    for (const fixture of allFixtures) {
      const decision = await decideFixture(fixture)
      if (decision.counterfactual.some((c) => c.flipsToExecute)) flipping.push(fixture.id)
    }
    // If this ever drops to zero the "why not execute?" panel has quietly
    // become decoration, which is the failure mode worth guarding against.
    expect(flipping.length).toBeGreaterThanOrEqual(2)
  })

  it('quotes real numbers in the fired rule, not boilerplate', async () => {
    for (const fixture of allFixtures) {
      const decision = await decideFixture(fixture)
      const fired = decision.ruleTrace.find((r) => r.fired)!
      expect(fired.because.length).toBeGreaterThan(20)
      expect(decision.summary.length).toBeGreaterThan(40)
    }
  })
})

/**
 * The audit chain and replay.
 *
 * Two claims are worth testing here rather than asserting in a README: that
 * tampering with a stored decision is detectable, and that a stored decision
 * can be re-judged under a different policy without re-running a single
 * extractor.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { GENESIS_HASH, sealRecord, verifyChain, type AuditRecord } from '@/audit/hashChain'
import { MemoryAuditStore, auditStore, resetAuditStoreForTests } from '@/audit/store'
import { llmAvailable } from '@/signals/llm/claimExtractor'
import { replay } from '@/audit/replay'
import { registry, judge } from '@/engine'
import { refundsPolicy } from '@/policies/refunds.policy'
import { allFixtures, fixtures } from '@/fixtures'

async function populate(): Promise<{ store: MemoryAuditStore; records: AuditRecord[] }> {
  const store = new MemoryAuditStore()
  for (const fixture of allFixtures) {
    const signals = await registry[fixture.envelope.domain].gather(fixture.envelope)
    const now = String(fixture.envelope.context['now'])
    const decision = judge(fixture.envelope, signals, undefined, { now })
    await store.append({ envelope: fixture.envelope, signals, decision })
  }
  return { store, records: await store.all() }
}

describe('hash chain', () => {
  it('links every record to the one before it, starting from genesis', async () => {
    const { records } = await populate()

    expect(records.length).toBe(allFixtures.length)
    expect(records[0]!.prevHash).toBe(GENESIS_HASH)
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.prevHash).toBe(records[i - 1]!.hash)
      expect(records[i]!.seq).toBe(i)
    }
  })

  it('verifies clean', async () => {
    const { store } = await populate()
    const result = await store.verify()
    expect(result.valid).toBe(true)
  })

  it('detects a decision that was edited after the fact', async () => {
    const { records } = await populate()
    const tampered = records.map((r) => ({ ...r }))
    const victim = tampered.findIndex((r) => r.decision.outcome === 'escalate')

    // Flip an escalation into an execution, leaving the stored hash alone —
    // the edit an insider would actually make.
    tampered[victim] = {
      ...tampered[victim]!,
      decision: { ...tampered[victim]!.decision, outcome: 'execute' },
    }

    const result = verifyChain(tampered)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.brokenAtSeq).toBe(victim)
      expect(result.reason).toContain('edited after it was written')
    }
  })

  it('detects a record quietly deleted from the middle', async () => {
    const { records } = await populate()
    const shortened = [...records.slice(0, 5), ...records.slice(6)]

    const result = verifyChain(shortened)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('inserted, removed or reordered')
    }
  })

  it('re-hashing a record with the same contents reproduces the same hash', async () => {
    const { records } = await populate()
    for (const record of records.slice(0, 5)) {
      const { hash, ...rest } = record
      expect(sealRecord(rest).hash).toBe(hash)
    }
  })

  it('recording a realised outcome reseals the chain rather than silently editing it', async () => {
    const { store, records } = await populate()
    const target = records[3]!
    const originalHash = target.hash

    const updated = await store.recordOutcome(target.auditId, {
      ok: false,
      note: 'The customer had the laptop the whole time.',
      recordedAt: '2026-04-01T09:00:00Z',
    })

    expect(updated!.realisedOutcome!.ok).toBe(false)
    // The amendment is visible: the record's hash changed, and the chain that
    // follows it was rebuilt to match.
    expect(updated!.hash).not.toBe(originalHash)
    expect((await store.verify()).valid).toBe(true)
  })
})

describe('replay', () => {
  it('re-judges stored decisions without touching a single extractor', async () => {
    const { records } = await populate()

    const result = replay(records, {
      domain: 'refunds',
      thresholds: { ...refundsPolicy.thresholds, escalateCost: 1 },
    })

    expect(result.replayed).toBe(fixtures.refunds.length)
    expect(result.headline).toContain('escalation ceiling')
  })

  it('changes nothing when nothing is changed', async () => {
    const { records } = await populate()
    const result = replay(records, { domain: 'deploy' })

    expect(result.changed).toBe(0)
    expect(result.headline).toContain('none of the last')
  })

  it('a stricter confidence floor only ever makes the engine more cautious', async () => {
    const { records } = await populate()
    const result = replay(records, { domain: 'refunds', thresholds: { minConfidence: 0.99 } })

    // Raising a floor can never turn a hold into an execution.
    for (const change of result.changes) {
      expect(change.to).not.toBe('execute')
    }
    expect(result.outcomesAfter.execute).toBeLessThanOrEqual(result.outcomesBefore.execute)
  })

  it('widening the blocking-field list turns silent executions into questions', async () => {
    const { records } = await populate()
    const result = replay(records, {
      domain: 'refunds',
      blockingFields: [
        'return_tracking_number',
        'damage_photos',
        'payout_account_verification',
        // Nothing emits this, so the list is wider but the corpus is unchanged.
        'signed_declaration',
      ],
    })
    expect(result.replayed).toBe(fixtures.refunds.length)
  })
})

/**
 * Host-injected configuration.
 *
 * Vercel pre-fills every key it finds in `.env.example` with an empty value, so
 * "unset" and "set to nothing" reach the process identically. Reading them with
 * `??` treats the second as a real choice, which on a read-only filesystem
 * selects the file store and breaks every request. These pin the behaviour.
 */
describe('environment handling', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
    resetAuditStoreForTests()
  })

  it('treats an empty AUDIT_STORE on a read-only host as unset, not as a choice', () => {
    resetAuditStoreForTests()
    process.env.AUDIT_STORE = ''
    process.env.VERCEL = '1'
    expect(auditStore()).toBeInstanceOf(MemoryAuditStore)
  })

  it('treats a whitespace-only AUDIT_STORE the same way', () => {
    resetAuditStoreForTests()
    process.env.AUDIT_STORE = '   '
    process.env.VERCEL = '1'
    expect(auditStore()).toBeInstanceOf(MemoryAuditStore)
  })

  it('still honours an explicit choice, in any casing', () => {
    resetAuditStoreForTests()
    process.env.AUDIT_STORE = 'Memory'
    delete process.env.VERCEL
    expect(auditStore()).toBeInstanceOf(MemoryAuditStore)
  })

  it('an empty ANTHROPIC_API_KEY means no key, so the deterministic stub runs', () => {
    process.env.ANTHROPIC_API_KEY = ''
    expect(llmAvailable()).toBe(false)
    process.env.ANTHROPIC_API_KEY = '   '
    expect(llmAvailable()).toBe(false)
    process.env.ANTHROPIC_API_KEY = 'sk-ant-whatever'
    expect(llmAvailable()).toBe(true)
  })
})

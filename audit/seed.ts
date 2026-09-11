/**
 * A synthetic decision corpus, generated deterministically.
 *
 * The replay panel is only interesting if there is a body of past decisions to
 * diff against. Rather than ship a hand-written log — which would prove
 * nothing, since it could say anything — this generates variants of the real
 * fixtures, runs them through the real pipeline, and appends the real results
 * to the real hash chain. Every record in the seeded log is a decision the
 * engine actually made.
 *
 * The generator is seeded, so the corpus is byte-identical on every machine.
 * That matters for the README: a judge running this locally sees the same
 * replay numbers as the hosted demo.
 */

import { evaluate } from '@/engine'
import type { ActionEnvelope } from '@/core/types'
import { allFixtures } from '@/fixtures'
import type { AuditStore } from './store'

const VARIANTS_PER_FIXTURE = 10
const SEED = 0x5eed1

/**
 * Flags that make a scenario a foregone conclusion. A corpus in which every
 * variant of the sanctions fixture is still a sanctions hit would be 20%
 * refusals by construction and would tell you nothing. Each is cleared most of
 * the time so the generated population looks like a working queue rather than
 * six copies of each fixture.
 */
const DECISIVE_FLAGS: Record<string, unknown> = {
  chargebackInProgress: false,
  sanctionsHit: false,
  accountRestriction: null,
  chargeSettled: true,
  secretsDetected: false,
  regulatedService: false,
  incidentActive: false,
  legalHold: false,
  appealPending: false,
  policyInGracePeriod: false,
}

/** mulberry32 — small, fast, and identical everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shiftIso(iso: unknown, deltaSec: number): unknown {
  if (typeof iso !== 'string') return iso
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return new Date(ms + deltaSec * 1000).toISOString()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Bag = Record<string, unknown>

function pathOf(root: Bag, dotted: string): { parent: Bag; key: string } | null {
  const parts = dotted.split('.')
  let cursor: unknown = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor === null || typeof cursor !== 'object') return null
    cursor = (cursor as Bag)[parts[i]!]
  }
  if (cursor === null || typeof cursor !== 'object') return null
  return { parent: cursor as Bag, key: parts[parts.length - 1]! }
}

function scaleNumber(root: Bag, dotted: string, factor: number, round = true): void {
  const found = pathOf(root, dotted)
  if (!found) return
  const current = found.parent[found.key]
  if (typeof current !== 'number') return
  const next = current * factor
  found.parent[found.key] = round ? Math.round(next * 100) / 100 : next
}

function setNumber(root: Bag, dotted: string, value: number): void {
  const found = pathOf(root, dotted)
  if (!found || typeof found.parent[found.key] !== 'number') return
  found.parent[found.key] = value
}

function ageBy(root: Bag, dotted: string, deltaSec: number): void {
  const found = pathOf(root, dotted)
  if (!found) return
  found.parent[found.key] = shiftIso(found.parent[found.key], -deltaSec)
}

/**
 * Per-domain perturbation. These move the dials that actually change verdicts —
 * money, staleness, blast radius, classifier certainty — so the corpus spreads
 * across all five outcomes rather than clustering on one.
 */
function perturb(envelope: ActionEnvelope, next: () => number): ActionEnvelope {
  const e = clone(envelope)
  const payload = e.payload as Bag
  const context = e.context as Bag
  const day = 86400

  switch (e.domain) {
    case 'refunds': {
      const factor = 0.5 + next() * 1.6
      scaleNumber(payload, 'refund.amount', factor)
      scaleNumber(payload, 'order.total', factor)
      ageBy(payload, 'fulfillment.statusObservedAt', Math.round(next() * 12 * day))
      ageBy(payload, 'fulfillment.carrier.observedAt', Math.round(next() * 4 * day))
      ageBy(payload, 'returnLeg.warehouseReceiptAt', Math.round(next() * 30 * day))
      setNumber(payload, 'customer.refunds12mo', Math.floor(next() * 6))
      setNumber(payload, 'customer.orders12mo', 2 + Math.floor(next() * 20))
      setNumber(context, 'fraudScore', Math.round(next() * 60) / 100)
      break
    }
    case 'deploy': {
      scaleNumber(context, 'blastRadiusUsers', 0.2 + next() * 3, false)
      setNumber(payload, 'ci.testsFailed', next() < 0.7 ? 0 : Math.floor(next() * 40))
      setNumber(payload, 'ci.flakyRetries', next() < 0.75 ? 0 : Math.floor(next() * 4))
      ageBy(payload, 'ci.pipelineFinishedAt', Math.round(next() * 12 * 3600))
      setNumber(context, 'changeFailureRate30d', Math.round(next() * 25) / 100)
      setNumber(payload, 'change.linesChanged', 20 + Math.floor(next() * 1800))
      break
    }
    case 'moderation': {
      scaleNumber(payload, 'post.reach.impressions', 0.1 + next() * 5, false)
      setNumber(payload, 'classifier.score', Math.round((0.3 + next() * 0.68) * 100) / 100)
      setNumber(payload, 'classifier.selfConfidence', Math.round((0.4 + next() * 0.55) * 100) / 100)
      ageBy(payload, 'classifier.observedAt', Math.round(next() * 18 * day))
      setNumber(payload, 'authorStanding.priorStrikes', Math.floor(next() * 4))
      setNumber(payload, 'authorStanding.appealsUpheld', next() < 0.75 ? 0 : Math.floor(next() * 3))
      break
    }
  }

  // Clear the decisive flags most of the time, and clear the deploy freeze
  // separately because it is nested.
  for (const [flag, cleared] of Object.entries(DECISIVE_FLAGS)) {
    if (context[flag] !== undefined && next() < 0.7) context[flag] = cleared
  }
  const freeze = context['deployFreeze'] as { active?: boolean } | undefined
  if (freeze?.active && next() < 0.7) freeze.active = false

  // Fix up anything the scaling made incoherent.
  const impressions = pathOf(payload, 'post.reach.impressions')
  if (impressions && typeof impressions.parent[impressions.key] === 'number') {
    impressions.parent[impressions.key] = Math.round(impressions.parent[impressions.key] as number)
  }
  const blast = pathOf(context, 'blastRadiusUsers')
  if (blast && typeof blast.parent[blast.key] === 'number') {
    blast.parent[blast.key] = Math.round(blast.parent[blast.key] as number)
  }

  return e
}

/** 1..4, weighted 12 / 30 / 33 / 25. */
function drawAuthority(u: number): number {
  if (u < 0.12) return 1
  if (u < 0.42) return 2
  if (u < 0.75) return 3
  return 4
}

export async function seedCorpus(store: AuditStore): Promise<number> {
  const next = rng(SEED)
  let written = 0

  for (const fixture of allFixtures) {
    for (let v = 0; v < VARIANTS_PER_FIXTURE; v++) {
      const envelope = perturb(fixture.envelope, next)
      envelope.id = `${fixture.envelope.id}_v${v}`
      envelope.idempotencyKey = `${fixture.envelope.idempotencyKey}-v${v}`
      // Most of the time the request reaches someone appropriate, because
      // routing exists. The rest of the time it does not, which is what the
      // authority ceiling is for. Drawing authority uniformly instead would
      // make the corpus 80% escalations and the replay panel useless.
      if (next() < 0.35) {
        envelope.actor = { ...envelope.actor, authorityLevel: drawAuthority(next()) }
      }

      const now = String(envelope.context['now'] ?? envelope.requestedAt)
      const { decision, signals } = await evaluate(envelope, { now })
      await store.append({ envelope, signals, decision })
      written++
    }
  }

  return written
}

export const SEEDED_CORPUS_SIZE = VARIANTS_PER_FIXTURE * allFixtures.length

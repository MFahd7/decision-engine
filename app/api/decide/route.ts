import { NextResponse } from 'next/server'
import { evaluate, registry } from '@/engine'
import { naiveDecide } from '@/core/naive'
import { auditStore, ensureSeeded } from '@/audit/store'
import { fixtureById } from '@/fixtures'
import type { ActionEnvelope, Domain } from '@/core/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DOMAINS: Domain[] = ['refunds', 'deploy', 'moderation']

/**
 * POST /api/decide
 *
 * Body is either `{ "fixtureId": "..." }` to run one of the shipped scenarios,
 * or `{ "envelope": { ... } }` to submit your own Action Envelope.
 *
 * Returns the Decision, every signal that produced it, the audit record it was
 * written to, and — for comparison — what the naive baseline in `/core/naive.ts`
 * would have done with the same evidence.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const parsed = body as { fixtureId?: string; envelope?: ActionEnvelope }
  let envelope: ActionEnvelope

  if (parsed.fixtureId) {
    const fixture = fixtureById(parsed.fixtureId)
    if (!fixture) {
      return NextResponse.json({ error: `No fixture named "${parsed.fixtureId}".` }, { status: 404 })
    }
    envelope = fixture.envelope
  } else if (parsed.envelope) {
    const problem = validate(parsed.envelope)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })
    envelope = parsed.envelope
  } else {
    return NextResponse.json({ error: 'Send either { fixtureId } or { envelope }.' }, { status: 400 })
  }

  await ensureSeeded()

  // Fixtures pin their own clock so a scenario decides identically forever.
  const pinned = envelope.context?.['now']
  const now = typeof pinned === 'string' ? pinned : undefined

  const { decision, signals } = await evaluate(envelope, now ? { now } : undefined)
  const record = await auditStore().append({ envelope, signals, decision })

  return NextResponse.json({
    decision,
    signals,
    naive: naiveDecide(signals),
    policy: {
      version: registry[envelope.domain].policy.version,
      unit: registry[envelope.domain].policy.unit,
      thresholds: registry[envelope.domain].policy.thresholds,
    },
    audit: { seq: record.seq, auditId: record.auditId, hash: record.hash, prevHash: record.prevHash },
  })
}

function validate(envelope: ActionEnvelope): string | null {
  if (!envelope || typeof envelope !== 'object') return 'envelope must be an object.'
  if (!DOMAINS.includes(envelope.domain)) {
    return `envelope.domain must be one of ${DOMAINS.join(', ')}.`
  }
  if (typeof envelope.id !== 'string' || envelope.id.length === 0) return 'envelope.id is required.'
  if (typeof envelope.actionType !== 'string') return 'envelope.actionType is required.'
  if (!envelope.actor || typeof envelope.actor.authorityLevel !== 'number') {
    return 'envelope.actor.authorityLevel must be a number.'
  }
  if (!envelope.payload || typeof envelope.payload !== 'object') return 'envelope.payload must be an object.'
  if (!envelope.context || typeof envelope.context !== 'object') return 'envelope.context must be an object.'
  return null
}

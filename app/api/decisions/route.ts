import { NextResponse } from 'next/server'
import { auditStore, ensureSeeded } from '@/audit/store'
import { short } from '@/audit/hashChain'
import type { Decision, Domain } from '@/core/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/decisions?domain=refunds&outcome=escalate&limit=50&offset=0
 *
 * The audit list. Returns a summary row per record rather than the full
 * decision — fetch one record by id for everything.
 */
export async function GET(request: Request) {
  await ensureSeeded()
  const url = new URL(request.url)
  const store = auditStore()

  const domain = url.searchParams.get('domain') as Domain | null
  const outcome = url.searchParams.get('outcome') as Decision['outcome'] | null
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000)

  const { records, total } = await store.list({
    domain: domain ?? undefined,
    outcome: outcome ?? undefined,
    limit,
    offset,
  })
  const chain = await store.verify()

  return NextResponse.json({
    total,
    limit,
    offset,
    chain: {
      valid: chain.valid,
      length: chain.length,
      head: short(chain.head),
      ...(chain.valid ? {} : { brokenAtSeq: chain.brokenAtSeq, reason: chain.reason }),
    },
    records: records.map((r) => ({
      seq: r.seq,
      auditId: r.auditId,
      recordedAt: r.recordedAt,
      domain: r.envelope.domain,
      actionType: r.envelope.actionType,
      envelopeId: r.envelope.id,
      actor: r.envelope.actor,
      outcome: r.decision.outcome,
      firedRule: r.decision.firedRule,
      confidence: r.decision.confidence,
      support: r.decision.support,
      costOfBeingWrong: r.decision.costOfBeingWrong,
      unit: r.decision.unit,
      policyVersion: r.policyVersion,
      hash: short(r.hash),
      prevHash: short(r.prevHash),
      realisedOutcome: r.realisedOutcome,
    })),
  })
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

import { NextResponse } from 'next/server'
import { auditStore, ensureSeeded } from '@/audit/store'
import { hashableOf, sha256 } from '@/audit/hashChain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/decisions/:auditId
 *
 * One full record: the envelope, every signal, the decision with its rule
 * trace, and a live recomputation of the record's own hash so a reader can see
 * for themselves that it has not been edited.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ auditId: string }> }) {
  await ensureSeeded()
  const { auditId } = await ctx.params
  const record = await auditStore().get(auditId)

  if (!record) {
    return NextResponse.json({ error: `No audit record ${auditId}.` }, { status: 404 })
  }

  const { hash, ...unsealed } = record
  const recomputed = sha256(hashableOf(unsealed))

  return NextResponse.json({
    record,
    integrity: {
      storedHash: hash,
      recomputedHash: recomputed,
      intact: recomputed === hash,
    },
  })
}

/**
 * POST /api/decisions/:auditId
 *
 * Record how the decision actually turned out — the input that would let this
 * engine be calibrated against reality rather than only against its own
 * thresholds. Amending a sealed record reseals the chain from that point, so
 * the amendment is visible rather than silent.
 */
export async function POST(request: Request, ctx: { params: Promise<{ auditId: string }> }) {
  await ensureSeeded()
  const { auditId } = await ctx.params

  let body: { ok?: boolean; note?: string }
  try {
    body = (await request.json()) as { ok?: boolean; note?: string }
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  if (typeof body.ok !== 'boolean') {
    return NextResponse.json({ error: 'Send { ok: boolean, note?: string }.' }, { status: 400 })
  }

  const updated = await auditStore().recordOutcome(auditId, {
    ok: body.ok,
    note: body.note ?? '',
    recordedAt: new Date().toISOString(),
  })

  if (!updated) {
    return NextResponse.json({ error: `No audit record ${auditId}.` }, { status: 404 })
  }

  const chain = await auditStore().verify()
  return NextResponse.json({ record: updated, chain })
}

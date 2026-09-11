import { NextResponse } from 'next/server'
import { auditStore, ensureSeeded } from '@/audit/store'
import { replay, type ReplayRequest } from '@/audit/replay'
import { policyFor } from '@/engine'
import type { Domain } from '@/core/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DOMAINS: Domain[] = ['refunds', 'deploy', 'moderation']

/**
 * POST /api/replay
 *
 * Body: { domain, thresholds?: { escalateCost?, tolerance?, minConfidence?,
 *         minSupport?, contradictionPenalty? }, blockingFields?: string[] }
 *
 * Re-judges every stored decision in that domain under the proposed
 * thresholds and reports what would have changed. Nothing is written: replay
 * is a question, not an edit.
 */
export async function POST(request: Request) {
  let body: Partial<ReplayRequest>
  try {
    body = (await request.json()) as Partial<ReplayRequest>
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const domain = body.domain
  if (!domain || !DOMAINS.includes(domain)) {
    return NextResponse.json({ error: `domain must be one of ${DOMAINS.join(', ')}.` }, { status: 400 })
  }

  const thresholds = sanitise(body.thresholds)
  await ensureSeeded()
  const records = await auditStore().all()

  const result = replay(records, {
    domain,
    thresholds,
    blockingFields: Array.isArray(body.blockingFields) ? body.blockingFields : undefined,
  })

  return NextResponse.json({
    ...result,
    baseThresholds: policyFor(domain).thresholds,
    unit: policyFor(domain).unit,
  })
}

/** Only known keys, only finite numbers, only sane ranges. */
function sanitise(raw: unknown): ReplayRequest['thresholds'] {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Record<string, unknown>
  const out: Record<string, number> = {}

  const bounded: Record<string, [number, number]> = {
    minConfidence: [0, 1],
    minSupport: [0, 1],
    contradictionPenalty: [0, 1],
    tolerance: [0, 1e9],
    escalateCost: [0, 1e9],
  }

  for (const [key, [min, max]] of Object.entries(bounded)) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.min(max, Math.max(min, value))
    }
  }

  return Object.keys(out).length > 0 ? (out as ReplayRequest['thresholds']) : undefined
}

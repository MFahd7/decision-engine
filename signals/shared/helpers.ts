/**
 * Extractor plumbing shared by all three domains.
 *
 * Signal ids are derived from the envelope id and the signal name rather than
 * generated randomly. Two runs over the same envelope therefore produce
 * byte-identical signals, which is what makes the audit hash chain meaningful
 * and replay honest.
 */

import type { ActionEnvelope, GapSpec, Signal } from '@/core/types'
import { readPath } from '@/core/policyContext'

export type SignalDraft = Omit<Signal, 'id'>

export function makeSignal(envelope: ActionEnvelope, draft: SignalDraft): Signal {
  return { id: `${envelope.id}::${draft.name}`, ...draft }
}

/** The decision clock. Fixtures pin it so a scenario decides the same way forever. */
export function nowOf(envelope: ActionEnvelope): number {
  const pinned = readPath(envelope.context, 'now')
  const stamp = typeof pinned === 'string' ? Date.parse(pinned) : NaN
  return Number.isFinite(stamp) ? stamp : Date.parse(envelope.requestedAt)
}

/** Age in seconds of an ISO timestamp, relative to the decision clock. Never negative. */
export function ageSec(envelope: ActionEnvelope, iso: unknown): number {
  if (typeof iso !== 'string') return 0
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.round((nowOf(envelope) - then) / 1000))
}

export function str(envelope: ActionEnvelope, path: string, fallback = ''): string {
  const v = readPath(envelope.payload, path) ?? readPath(envelope.context, path)
  return typeof v === 'string' ? v : fallback
}

export function num(envelope: ActionEnvelope, path: string, fallback = 0): number {
  const v = readPath(envelope.payload, path) ?? readPath(envelope.context, path)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const parsed = Number(v)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function flag(envelope: ActionEnvelope, path: string, fallback = false): boolean {
  const v = readPath(envelope.payload, path) ?? readPath(envelope.context, path)
  return typeof v === 'boolean' ? v : fallback
}

export function has(envelope: ActionEnvelope, path: string): boolean {
  const v = readPath(envelope.payload, path) ?? readPath(envelope.context, path)
  return v !== undefined && v !== null && v !== ''
}

export function list<T = unknown>(envelope: ActionEnvelope, path: string): T[] {
  const v = readPath(envelope.payload, path) ?? readPath(envelope.context, path)
  return Array.isArray(v) ? (v as T[]) : []
}

/** A gap, expressed as the `missing` signal that carries it. */
export function missing(
  envelope: ActionEnvelope,
  args: {
    field: string
    obtainableBy: 'user' | 'system' | 'time'
    question: string
    weight: number
    rationale: string
    /** What closing this gap would do to the world. Read by the counterfactual engine. */
    ifSupplied?: GapSpec['ifSupplied']
  },
): Signal {
  return makeSignal(envelope, {
    name: `missing_${args.field}`,
    kind: 'missing',
    value: false,
    weight: args.weight,
    confidence: 0,
    freshnessSec: 0,
    source: 'rule',
    rationale: args.rationale,
    latencyMs: 0,
    gap: {
      field: args.field,
      obtainableBy: args.obtainableBy,
      question: args.question,
      ...(args.ifSupplied ? { ifSupplied: args.ifSupplied } : {}),
    },
  })
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Run a set of extractors and flatten. Order is stable, so hashes are stable. */
export async function runExtractors(
  envelope: ActionEnvelope,
  extractors: Array<(e: ActionEnvelope) => Signal[] | Promise<Signal[]>>,
): Promise<Signal[]> {
  const out: Signal[] = []
  for (const extract of extractors) {
    const started = Date.now()
    const produced = await extract(envelope)
    const elapsed = Date.now() - started
    for (const s of produced) {
      out.push(s.latencyMs > 0 ? s : { ...s, latencyMs: elapsed })
    }
  }
  return out
}

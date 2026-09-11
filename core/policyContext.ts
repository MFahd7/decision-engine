/**
 * The narrow window a policy pack sees.
 *
 * Policy predicates receive this and nothing else. They cannot read the clock,
 * the filesystem or the network — every fact they are allowed to reason about
 * arrived as a Signal or sits in the envelope. That restriction is what makes
 * a decision replayable months later.
 */

import type { ActionEnvelope, PolicyContext, Signal } from './types'

export function makePolicyContext(envelope: ActionEnvelope, signals: Signal[]): PolicyContext {
  const index = new Map<string, Signal>()
  for (const s of signals) index.set(s.name, s)

  const get = (name: string) => index.get(name)

  return {
    envelope,
    signals,
    get,
    num: (name, fallback = 0) => {
      const s = index.get(name)
      if (!s) return fallback
      return coerceNumber(s.value, fallback)
    },
    bool: (name, fallback = false) => {
      const s = index.get(name)
      if (!s) return fallback
      if (typeof s.value === 'boolean') return s.value
      if (typeof s.value === 'number') return s.value !== 0
      if (s.value === 'true') return true
      if (s.value === 'false') return false
      return fallback
    },
    field: (path, fallback = 0) => {
      const fromPayload = readPath(envelope.payload, path)
      if (fromPayload !== undefined) return coerceNumber(fromPayload as never, fallback)
      const fromContext = readPath(envelope.context, path)
      if (fromContext !== undefined) return coerceNumber(fromContext as never, fallback)
      return fallback
    },
  }
}

/** Read a dotted path, e.g. 'order.total'. Returns undefined when absent. */
export function readPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
    if (cursor === undefined) return undefined
  }
  return cursor
}

/** Read a dotted path as a string, for labels and questions. */
export function readString(
  envelope: ActionEnvelope,
  path: string,
  fallback = '',
): string {
  const value = readPath(envelope.payload, path) ?? readPath(envelope.context, path)
  return typeof value === 'string' ? value : fallback
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

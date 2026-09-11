/**
 * The partial fix for threshold gaming (failure test B).
 *
 * A per-request threshold is trivially defeated by splitting one large request
 * into several small ones. This extractor widens the unit of judgement from
 * the request to the tuple (actor, subject, window): it sums what the same
 * actor has already pushed through for the same subject inside a rolling
 * window and emits that as a risk signal.
 *
 * It is a mitigation, not a solution, and `tests/failure-b.spec.ts` proves the
 * hole that remains. See ARCHITECTURE.md, "What we did not fix".
 */

import type { ActionEnvelope, Signal } from '@/core/types'
import { ageSec, clamp01, list, makeSignal } from './helpers'

export type PriorAction = { amount: number; at: string; subjectId?: string }

export function aggregationWindowSignals(
  envelope: ActionEnvelope,
  options: { windowSec: number; escalateAt: number; subjectPath?: string },
): Signal[] {
  const priors = list<PriorAction>(envelope, 'priorActionsByActor')
  const inWindow = priors.filter((p) => ageSec(envelope, p.at) <= options.windowSec)
  const priorTotal = inWindow.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)

  if (inWindow.length === 0) {
    return [
      makeSignal(envelope, {
        name: 'actor_window_total',
        kind: 'risk',
        value: 0,
        weight: 0.8,
        confidence: 0.95,
        freshnessSec: 0,
        source: 'data',
        rationale: `No prior action by ${envelope.actor.id} for this subject in the last ${Math.round(options.windowSec / 3600)} hours.`,
        latencyMs: 0,
      }),
    ]
  }

  // Risk rises as the running total approaches the escalation ceiling, and
  // pins at 1 once the *aggregate* would have escalated on its own.
  const ratio = options.escalateAt > 0 ? priorTotal / options.escalateAt : 0

  return [
    makeSignal(envelope, {
      name: 'actor_window_total',
      kind: 'risk',
      value: clamp01(ratio),
      weight: 0.9,
      confidence: 0.95,
      freshnessSec: 0,
      source: 'data',
      rationale:
        `${envelope.actor.id} has already pushed ${inWindow.length} similar action${inWindow.length === 1 ? '' : 's'} ` +
        `totalling ${priorTotal} for this subject in the last ${Math.round(options.windowSec / 3600)} hours. ` +
        `This request is being judged against that running total, not on its own.`,
      latencyMs: 0,
    }),
  ]
}

/** The running total the window sees. Exposed so tests can assert on it directly. */
export function windowTotal(envelope: ActionEnvelope, windowSec: number): number {
  return list<PriorAction>(envelope, 'priorActionsByActor')
    .filter((p) => ageSec(envelope, p.at) <= windowSec)
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
}

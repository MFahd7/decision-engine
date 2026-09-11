import type { ActionEnvelope, Signal } from '@/core/types'
import { makeSignal } from './helpers'

/**
 * Who is asking, recorded as a signal so it appears in the audit trail
 * alongside everything else. The kernel reads authority from the envelope, not
 * from here — this exists so a reader of the log can see it without having to
 * unpack the envelope.
 */
export function authoritySignals(envelope: ActionEnvelope): Signal[] {
  return [
    makeSignal(envelope, {
      name: 'actor_authority_level',
      kind: 'authority',
      value: envelope.actor.authorityLevel,
      weight: 1,
      confidence: 1,
      // Authority is asserted by the identity system, not observed in the
      // world. It does not go stale between the request and the decision.
      freshnessSec: 0,
      source: 'rule',
      rationale: `${envelope.actor.role} (${envelope.actor.id}) holds authority level ${envelope.actor.authorityLevel}.`,
      latencyMs: 0,
    }),
  ]
}

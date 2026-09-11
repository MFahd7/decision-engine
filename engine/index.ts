/**
 * Composition root.
 *
 * This is the only module that knows all three domains exist. `/core` stays
 * domain-free, `/policies` and `/signals` stay unaware of each other, and this
 * file wires them together. Adding a fourth domain means adding one row to the
 * registry below — no kernel change, no UI change.
 *
 * The two-phase shape matters:
 *
 *   gather(envelope)  -> Signal[]      impure: clocks, databases, an LLM
 *   decide(...)       -> Decision      pure: same inputs, same verdict, forever
 *
 * Replay re-runs only the second phase against stored signals, which is why a
 * decision from six months ago can be re-judged under today's policy without
 * any of the original systems still being reachable.
 */

import { decide, type KernelInput, type KernelOptions } from '@/core/kernel'
import type { ActionEnvelope, Decision, Domain, PolicyPack, Signal } from '@/core/types'
import { deployPolicy } from '@/policies/deploy.policy'
import { moderationPolicy } from '@/policies/moderation.policy'
import { refundsPolicy } from '@/policies/refunds.policy'
import { extractDeploySignals } from '@/signals/deploy'
import { extractModerationSignals } from '@/signals/moderation'
import { extractRefundSignals } from '@/signals/refunds'

export type DomainRegistration = {
  policy: PolicyPack
  gather: (envelope: ActionEnvelope) => Promise<Signal[]>
  label: string
  blurb: string
}

export const registry: Record<Domain, DomainRegistration> = {
  refunds: {
    policy: refundsPolicy,
    gather: extractRefundSignals,
    label: 'Refund approval',
    blurb: 'Money leaving the business, mostly clawable, judged in seconds at high volume.',
  },
  deploy: {
    policy: deployPolicy,
    gather: extractDeploySignals,
    label: 'Code deploy',
    blurb: 'Nothing is missing and nothing is forbidden. Sometimes the answer is still "not now".',
  },
  moderation: {
    policy: moderationPolicy,
    gather: extractModerationSignals,
    label: 'Content moderation',
    blurb: 'Where a classifier is genuinely needed, and where discounting its confidence obviously matters.',
  },
}

export function policyFor(domain: Domain): PolicyPack {
  return registry[domain].policy
}

/** Phase one: talk to the world. */
export function gather(envelope: ActionEnvelope): Promise<Signal[]> {
  return registry[envelope.domain].gather(envelope)
}

/** Phase two: judge. Pure, and exported separately so replay can call it alone. */
export function judge(
  envelope: ActionEnvelope,
  signals: Signal[],
  policy?: PolicyPack,
  options?: KernelOptions,
): Decision {
  const input: KernelInput = {
    envelope,
    signals,
    policy: policy ?? policyFor(envelope.domain),
  }
  return decide(input, options)
}

/** Both phases. What `/api/decide` calls. */
export async function evaluate(
  envelope: ActionEnvelope,
  options?: KernelOptions,
): Promise<{ decision: Decision; signals: Signal[] }> {
  const signals = await gather(envelope)
  return { decision: judge(envelope, signals, undefined, options), signals }
}

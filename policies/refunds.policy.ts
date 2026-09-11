/**
 * Refund approval policy pack.
 *
 * Everything that makes a decision *about refunds specifically* lives in this
 * file. The kernel reads it and knows nothing else about commerce. Bump
 * `version` on every threshold change: past decisions record the version they
 * were made under, and `/api/replay` diffs one version against another.
 */

import type { PolicyPack } from '@/core/types'
import { windowTotal } from '@/signals/shared/aggregationWindow'

const HOUR = 3600
const DAY = 24 * HOUR

/** The rolling window over which one actor's refunds are judged together. */
export const REFUND_AGGREGATION_WINDOW_SEC = 24 * HOUR

export const refundsPolicy: PolicyPack = {
  domain: 'refunds',
  version: 'refunds@1.4.0',
  unit: 'USD',

  thresholds: {
    minConfidence: 0.72,
    minSupport: 0.66,
    // Expected regret we are willing to absorb without a human. Small, because
    // refunds are high-volume: this is the amount we accept per decision, not
    // per day.
    tolerance: 12,
    escalateCost: 90,
    contradictionPenalty: 0.85,
  },

  /**
   * How fast each fact rots. These are the most opinionated numbers in the
   * pack and they encode real operational knowledge: a carrier scan is a
   * statement about a parcel in motion and is worthless within days, while a
   * customer's 12-month chargeback history barely moves in a quarter.
   */
  halfLifeSec: {
    '*': 14 * DAY,
    // An outbound delivery record is a claim about a parcel that has stopped
    // moving, so it ages slowly. The return-leg records below age fast, because
    // they describe a parcel that is still in motion — and that asymmetry is
    // the whole of failure test A.
    fulfillment_status: 14 * DAY,
    carrier_last_scan: 6 * DAY,
    return_received_at_warehouse: 7 * DAY,
    return_carrier_status: 2 * DAY,
    customer_refund_rate: 30 * DAY,
    customer_chargeback_history: 90 * DAY,
    fraud_model_score: 1 * DAY,
    damage_photos_supplied: 30 * DAY,
    // Arithmetic and assertions, not observations. They do not age.
    within_refund_window: 0,
    refund_exceeds_order_value: 0,
    duplicate_charge_confirmed: 0,
    stated_reason_claim: 0,
    actor_window_total: 0,
    actor_authority_level: 0,
  },

  /**
   * Which absences stop the show. Everything else an extractor reports as
   * missing still drags confidence down, but does not by itself hold the
   * decision. Widening this list is the cheapest way to make the engine more
   * cautious, and `/api/replay` will tell you what it would have cost.
   */
  blockingFields: ['return_tracking_number', 'damage_photos', 'payout_account_verification'],

  prohibitions: [
    {
      id: 'OPEN_CHARGEBACK',
      description:
        'a chargeback is already open on this order, so refunding now would pay the customer twice and forfeit the dispute.',
      test: (ctx) => truthy(ctx.envelope.context['chargebackInProgress']),
    },
    {
      id: 'SANCTIONS_MATCH',
      description: 'the payee matches a sanctions list, and paying out would be illegal.',
      test: (ctx) => truthy(ctx.envelope.context['sanctionsHit']),
    },
    {
      id: 'STORE_CREDIT_ONLY_ACCOUNT',
      description:
        'this account is restricted to store credit after a prior abuse finding, and this request asks for cash.',
      test: (ctx) =>
        ctx.envelope.context['accountRestriction'] === 'store_credit_only' &&
        ctx.envelope.payload['payout'] !== undefined &&
        (ctx.envelope.payload['payout'] as { rail?: string }).rail !== 'store_credit',
    },
  ],

  temporalBars: [
    {
      id: 'CHARGE_NOT_SETTLED',
      description:
        'The original charge has not settled with the processor yet, so there is nothing to reverse.',
      test: (ctx) => ctx.envelope.context['chargeSettled'] === false,
      clearsAt: (ctx) => String(ctx.envelope.context['settlementEta'] ?? 'settlement, typically within 48 hours'),
    },
  ],

  /**
   * Authority scales with the money, not with the confidence. A clear-cut
   * $4,000 refund still needs a manager, because the point of an authority
   * ceiling is that someone is accountable, not that someone is unsure.
   *
   * The tier is chosen on the running 24-hour total for this actor and
   * customer, not on this request alone. A per-request ladder is defeated by
   * anyone willing to press the button eleven times, so the unit of judgement
   * has to be wider than the unit of request. This closes the fast version of
   * that attack and not the patient one — see `tests/failure-b.spec.ts`.
   */
  requiredAuthority: (ctx) => {
    const amount = ctx.field('refund.amount', 0)
    const priorTotal = windowTotal(ctx.envelope, REFUND_AGGREGATION_WINDOW_SEC)
    const judged = amount + priorTotal
    const suffix =
      priorTotal > 0
        ? `, judged on the $${judged.toLocaleString('en-US')} this actor has moved for this customer in 24 hours rather than on this $${amount.toLocaleString('en-US')} alone`
        : ''

    if (judged < 100) return { level: 1, because: `refunds under $100${suffix}` }
    if (judged < 500) return { level: 2, because: `refunds from $100 to $500${suffix}` }
    if (judged < 2000) return { level: 3, because: `refunds from $500 to $2,000${suffix}` }
    return { level: 4, because: `refunds of $2,000 and above${suffix}` }
  },

  impactScale: (ctx) => ctx.field('refund.amount', 0),

  /**
   * How undoable a refund is depends almost entirely on the rail it goes out
   * on. This is the number most engines quietly assume is constant.
   */
  reversibility: (ctx) => {
    const rail = String((ctx.envelope.payload['payout'] as { rail?: string } | undefined)?.rail ?? 'card_reversal')
    const priorChargebacks = ctx.field('customer.chargebacks12mo', 0) > 0

    if (rail === 'store_credit') {
      return { value: 0.95, because: 'store credit can be revoked from the account directly' }
    }
    if (rail === 'instant_bank') {
      return {
        value: 0.15,
        because: 'an instant bank payout leaves our control on send and is recovered only by asking the customer nicely',
      }
    }
    return {
      value: priorChargebacks ? 0.45 : 0.7,
      because: priorChargebacks
        ? 'a card reversal is clawable in principle, but this customer has disputed before'
        : 'a card reversal is clawable through the processor for 60 days',
    }
  },

  rollbackPath: (ctx) => {
    const rail = String((ctx.envelope.payload['payout'] as { rail?: string } | undefined)?.rail ?? 'card_reversal')
    if (rail === 'store_credit') return 'Revoke the credit balance from the customer account. Immediate, no counterparty.'
    if (rail === 'instant_bank') return null
    return 'Clawback request through the payment processor, available for 60 days. Historically succeeds about two thirds of the time.'
  },
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true'
}

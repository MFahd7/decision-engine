/**
 * Refund signal extractors.
 *
 * These read the raw commerce record on the envelope — order, fulfillment,
 * return leg, customer history, payout rail — and turn it into Signals. They
 * make no judgement about what should happen. Note in particular that every
 * extractor sets `freshnessSec` from the timestamp of the *observation*, not
 * from when the lookup ran. That distinction is the entire failure-A story.
 */

import type { ActionEnvelope, Signal } from '@/core/types'
import { MODEL_CONFIDENCE_CAP, extractClaim, keywordStub } from '@/signals/llm/claimExtractor'
import { aggregationWindowSignals } from '@/signals/shared/aggregationWindow'
import { authoritySignals } from '@/signals/shared/authority'
import { ageSec, clamp01, flag, has, makeSignal, missing, num, runExtractors, str } from '@/signals/shared/helpers'

/** The refund amount at which a second pair of eyes is the norm. */
export const REFUND_SECOND_PAIR_OF_EYES = 1000

function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type RefundReason =
  | 'item_not_received'
  | 'item_damaged'
  | 'return_sent_back'
  | 'changed_mind'
  | 'duplicate_charge'

function reasonOf(envelope: ActionEnvelope): RefundReason {
  const raw = str(envelope, 'refund.reason', 'item_not_received')
  const known: RefundReason[] = [
    'item_not_received',
    'item_damaged',
    'return_sent_back',
    'changed_mind',
    'duplicate_charge',
  ]
  return (known as string[]).includes(raw) ? (raw as RefundReason) : 'item_not_received'
}

/**
 * Did the goods reach the customer, and does that help or hurt the request?
 * "Delivered" is not uniformly good or bad news — it depends entirely on what
 * the customer is claiming, which is why `support` is a lookup and not a
 * constant.
 */
function fulfillmentSignals(envelope: ActionEnvelope): Signal[] {
  const reason = reasonOf(envelope)
  const status = str(envelope, 'fulfillment.status', 'unknown')
  const reached = status === 'delivered'
  const out: Signal[] = []

  // How much "the goods arrived" argues for paying out, per claim type.
  const supportIfReached: Record<RefundReason, number> = {
    item_not_received: 0.08,
    item_damaged: 0.6,
    return_sent_back: 0.6,
    changed_mind: 0.72,
    duplicate_charge: 0.5,
  }
  const supportIfNotReached: Record<RefundReason, number> = {
    item_not_received: 0.92,
    item_damaged: 0.35,
    return_sent_back: 0.3,
    changed_mind: 0.6,
    duplicate_charge: 0.5,
  }

  // Where the parcel got to is the whole question for a "never arrived" claim
  // and almost beside the point for a double charge. Weighting both the same
  // would let two loud, irrelevant signals drown out the ledger entry that
  // actually settles it.
  const relevance = reason === 'duplicate_charge' ? 0.2 : 1

  out.push(
    makeSignal(envelope, {
      name: 'fulfillment_status',
      kind: 'evidence',
      value: status,
      weight: 0.8 * relevance,
      confidence: 0.95,
      freshnessSec: ageSec(envelope, str(envelope, 'fulfillment.statusObservedAt')),
      source: 'data',
      support: reached ? supportIfReached[reason] : supportIfNotReached[reason],
      asserts: { proposition: 'goods_reached_customer', polarity: reached },
      rationale: `Warehouse system records the shipment as "${status}".`,
      latencyMs: 0,
    }),
  )

  if (has(envelope, 'fulfillment.carrier.status')) {
    const carrierStatus = str(envelope, 'fulfillment.carrier.status')
    const carrierReached = carrierStatus === 'delivered'
    out.push(
      makeSignal(envelope, {
        name: 'carrier_last_scan',
        kind: 'evidence',
        value: carrierStatus,
        weight: 0.85 * relevance,
        confidence: 0.9,
        freshnessSec: ageSec(envelope, str(envelope, 'fulfillment.carrier.observedAt')),
        source: 'data',
        support: carrierReached ? supportIfReached[reason] : supportIfNotReached[reason],
        asserts: { proposition: 'goods_reached_customer', polarity: carrierReached },
        rationale: `Carrier's most recent scan reads "${carrierStatus}".`,
        latencyMs: 0,
      }),
    )
  }

  return out
}

/**
 * The return leg. Two independent sources describe the same fact — our
 * warehouse's receipt scan and the carrier's tracking — and they can disagree.
 * When they do, `asserts` lets the kernel notice without knowing what a
 * warehouse is.
 */
function returnLegSignals(envelope: ActionEnvelope): Signal[] {
  if (reasonOf(envelope) !== 'return_sent_back') return []
  const out: Signal[] = []

  if (has(envelope, 'returnLeg.warehouseReceiptAt')) {
    out.push(
      makeSignal(envelope, {
        name: 'return_received_at_warehouse',
        kind: 'evidence',
        value: true,
        weight: 0.9,
        confidence: 0.95,
        freshnessSec: ageSec(envelope, str(envelope, 'returnLeg.warehouseReceiptAt')),
        source: 'data',
        support: 0.95,
        asserts: { proposition: 'return_in_our_possession', polarity: true },
        rationale: 'Warehouse receipt scan records the returned item as booked in.',
        latencyMs: 0,
      }),
    )
  }

  if (has(envelope, 'returnLeg.carrierStatus')) {
    const carrierStatus = str(envelope, 'returnLeg.carrierStatus')
    const arrived = carrierStatus === 'delivered_to_warehouse'
    out.push(
      makeSignal(envelope, {
        name: 'return_carrier_status',
        kind: 'evidence',
        value: carrierStatus,
        weight: 0.85,
        confidence: 0.9,
        freshnessSec: ageSec(envelope, str(envelope, 'returnLeg.carrierObservedAt')),
        source: 'data',
        support: arrived ? 0.9 : 0.15,
        asserts: { proposition: 'return_in_our_possession', polarity: arrived },
        rationale: `Return tracking reads "${carrierStatus}".`,
        latencyMs: 0,
      }),
    )
  }

  if (!has(envelope, 'returnLeg.trackingNumber')) {
    out.push(
      missing(envelope, {
        field: 'return_tracking_number',
        obtainableBy: 'user',
        weight: 0.6,
        question:
          'Can you send us the return tracking number from your carrier receipt? We cannot match your return to a shipment without it.',
        rationale: 'No return tracking number on file, so the return cannot be matched to a shipment.',
      }),
    )
  }

  return out
}

/** Damage claims need a picture, and there is no substitute a system can fetch. */
function damageSignals(envelope: ActionEnvelope): Signal[] {
  if (reasonOf(envelope) !== 'item_damaged') return []

  if (flag(envelope, 'evidence.photosProvided')) {
    return [
      makeSignal(envelope, {
        name: 'damage_photos_supplied',
        kind: 'evidence',
        value: num(envelope, 'evidence.photoCount', 1),
        weight: 0.9,
        confidence: 0.85,
        freshnessSec: ageSec(envelope, str(envelope, 'evidence.photosUploadedAt')),
        source: 'human',
        support: 0.95,
        rationale: `Customer supplied ${num(envelope, 'evidence.photoCount', 1)} photo(s) of the damage.`,
        latencyMs: 0,
      }),
    ]
  }

  return [
    missing(envelope, {
      field: 'damage_photos',
      obtainableBy: 'user',
      weight: 0.8,
      question:
        'Could you upload a photo of the item as it arrived? We need to see the damage before we can refund it.',
      rationale: 'A damage claim with no photograph cannot be assessed.',
      // A supplied photo is worth exactly what a supplied photo is worth
      // elsewhere in this file, so the counterfactual uses the same numbers
      // rather than a generic guess.
      ifSupplied: { evidence: { weight: 0.9, confidence: 0.85, support: 0.95 } },
    }),
  ]
}

/** A duplicate charge is arithmetic, not judgement, so it is confident and never decays. */
function duplicateChargeSignals(envelope: ActionEnvelope): Signal[] {
  if (reasonOf(envelope) !== 'duplicate_charge') return []
  const confirmed = flag(envelope, 'billing.duplicateChargeConfirmed')
  return [
    makeSignal(envelope, {
      name: 'duplicate_charge_confirmed',
      kind: 'evidence',
      value: confirmed,
      weight: 0.95,
      confidence: 0.99,
      freshnessSec: 0,
      source: 'rule',
      support: confirmed ? 0.98 : 0.1,
      rationale: confirmed
        ? 'Ledger shows two settled authorisations for the same order within the same minute.'
        : 'Ledger shows only one settled authorisation for this order.',
      latencyMs: 0,
    }),
  ]
}

/** Whether the request is inside the published window. Arithmetic — it does not decay. */
function policyWindowSignals(envelope: ActionEnvelope): Signal[] {
  const windowDays = num(envelope, 'policyWindowDays', 30)
  const anchor =
    str(envelope, 'fulfillment.statusObservedAt') || str(envelope, 'order.placedAt')
  const daysSince = ageSec(envelope, anchor) / 86400
  const within = daysSince <= windowDays

  return [
    makeSignal(envelope, {
      name: 'within_refund_window',
      kind: 'evidence',
      value: within,
      weight: 0.5,
      confidence: 1,
      freshnessSec: 0,
      source: 'rule',
      support: within ? 0.85 : 0.15,
      rationale: within
        ? `Requested ${Math.round(daysSince)} days after delivery, inside the ${windowDays}-day window.`
        : `Requested ${Math.round(daysSince)} days after delivery, outside the ${windowDays}-day window.`,
      latencyMs: 0,
    }),
  ]
}

function customerHistorySignals(envelope: ActionEnvelope): Signal[] {
  const orders = Math.max(1, num(envelope, 'customer.orders12mo', 1))
  const refunds = num(envelope, 'customer.refunds12mo', 0)
  const chargebacks = num(envelope, 'customer.chargebacks12mo', 0)
  const rate = refunds / orders

  return [
    makeSignal(envelope, {
      name: 'customer_refund_rate',
      kind: 'risk',
      // A refund rate around 40% is where this pins. Most honest customers
      // never come close; the ones who do are worth a second look.
      value: clamp01(rate * 2.5),
      weight: 0.7,
      confidence: 0.9,
      freshnessSec: 86400,
      source: 'data',
      rationale: `${refunds} refund(s) across ${orders} order(s) in the last 12 months.`,
      latencyMs: 0,
    }),
    makeSignal(envelope, {
      name: 'customer_chargeback_history',
      kind: 'risk',
      value: chargebacks > 0 ? 0.75 : 0,
      weight: 0.8,
      confidence: 0.95,
      freshnessSec: 86400,
      source: 'data',
      rationale:
        chargebacks > 0
          ? `${chargebacks} chargeback(s) filed in the last 12 months, so a refund here may end up paid twice.`
          : 'No chargebacks on file in the last 12 months.',
      latencyMs: 0,
    }),
  ]
}

function amountSignals(envelope: ActionEnvelope): Signal[] {
  const amount = num(envelope, 'refund.amount', 0)
  const orderTotal = Math.max(1, num(envelope, 'order.total', 1))
  const overRefund = amount > orderTotal * 1.001

  return [
    makeSignal(envelope, {
      name: 'refund_exceeds_order_value',
      kind: 'risk',
      value: overRefund ? clamp01(0.5 + (amount / orderTotal - 1)) : 0,
      weight: 0.9,
      confidence: 1,
      freshnessSec: 0,
      source: 'rule',
      rationale: overRefund
        ? `Refund of ${usd(amount)} exceeds the order value of ${usd(orderTotal)}.`
        : `Refund of ${usd(amount)} is within the order value of ${usd(orderTotal)}.`,
      latencyMs: 0,
    }),
  ]
}

/**
 * The fraud model. Note it is `source: 'model'` and its self-report is capped
 * exactly like the language model's — a scorer's own certainty is not
 * evidence of its accuracy, whichever kind of model it is.
 */
function fraudModelSignals(envelope: ActionEnvelope): Signal[] {
  if (!has(envelope, 'fraudScore')) return []
  return [
    makeSignal(envelope, {
      name: 'fraud_model_score',
      kind: 'risk',
      value: clamp01(num(envelope, 'fraudScore', 0)),
      weight: 0.7,
      confidence: Math.min(num(envelope, 'fraudScoreConfidence', 0.6), MODEL_CONFIDENCE_CAP),
      freshnessSec: ageSec(envelope, str(envelope, 'fraudScoreObservedAt')),
      source: 'model',
      rationale: `Fraud scorer returned ${num(envelope, 'fraudScore', 0)}, self-reported confidence capped at ${MODEL_CONFIDENCE_CAP}.`,
      latencyMs: 0,
    }),
  ]
}

/** Money cannot leave until the destination account is confirmed, and only the processor can confirm it. */
function payoutSignals(envelope: ActionEnvelope): Signal[] {
  if (flag(envelope, 'payout.verified', true)) return []
  return [
    missing(envelope, {
      field: 'payout_account_verification',
      obtainableBy: 'system',
      weight: 0.7,
      question:
        'The payment processor is still verifying the destination account. Nobody can hurry this; it clears on its own.',
      rationale: 'Destination account is unverified, so a payout would fail or land in the wrong place.',
    }),
  ]
}

function claimSignals(envelope: ActionEnvelope): Promise<Signal[]> {
  return extractClaim({
    envelope,
    signalName: 'stated_reason_claim',
    text: str(envelope, 'refund.customerMessage', ''),
    question:
      'Does what this customer wrote support issuing them a refund? Judge only the account they give, ' +
      'not whether refunding is a good idea.',
    weight: 0.4,
    stub: keywordStub({
      supporting: ['never arrived', 'damaged', 'broken', 'returned', 'sent it back', 'wrong item', 'charged twice'],
      opposing: ['changed my mind', "don't need", 'no longer want', 'found it', 'received it'],
      inconsistentWhen: [
        ['never arrived', 'returned'],
        ['never arrived', 'sent it back'],
      ],
    }),
  })
}

export function refundExtractors() {
  return [
    fulfillmentSignals,
    returnLegSignals,
    damageSignals,
    duplicateChargeSignals,
    policyWindowSignals,
    customerHistorySignals,
    amountSignals,
    fraudModelSignals,
    payoutSignals,
    claimSignals,
    (e: ActionEnvelope) =>
      aggregationWindowSignals(e, { windowSec: 24 * 3600, escalateAt: REFUND_SECOND_PAIR_OF_EYES }),
    authoritySignals,
  ]
}

export function extractRefundSignals(envelope: ActionEnvelope): Promise<Signal[]> {
  return runExtractors(envelope, refundExtractors())
}

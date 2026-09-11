/**
 * Turning a bag of signals into five numbers.
 *
 * Two ideas do the work here, and they are the reason this is not a scoring
 * average with extra steps:
 *
 *  1. FRESHNESS DECAY. A signal's confidence is the confidence of its *source*
 *     at the moment the underlying fact was observed. Time erodes it. A
 *     warehouse scan from 41 days ago is not 95% reliable today just because
 *     it was 95% reliable then.
 *
 *  2. CONFIDENCE AND SUPPORT ARE DIFFERENT NUMBERS. `confidence` is how well
 *     we know the situation. `support` is whether what we know argues for
 *     acting. High confidence and low support means we are *sure* the action
 *     is unjustified — which must never satisfy a green light.
 */

import type {
  Contradiction,
  PolicyPack,
  ScoredSignal,
  Scoring,
  Signal,
} from './types'

const FALLBACK_HALF_LIFE_SEC = 7 * 24 * 3600

export function halfLifeFor(policy: PolicyPack, signalName: string): number {
  const specific = policy.halfLifeSec[signalName]
  if (typeof specific === 'number') return specific
  const fallback = policy.halfLifeSec['*']
  if (typeof fallback === 'number') return fallback
  return FALLBACK_HALF_LIFE_SEC
}

/**
 * True half-life decay: at `freshnessSec === halfLifeSec` exactly half the
 * source's confidence survives. A half-life of 0 or below means "never
 * decays" — used for facts that are true forever, like an order's currency.
 */
export function decayConfidence(
  confidence: number,
  freshnessSec: number,
  halfLifeSec: number,
): number {
  if (halfLifeSec <= 0) return clamp01(confidence)
  const age = Math.max(0, freshnessSec)
  return clamp01(confidence * Math.pow(2, -age / halfLifeSec))
}

export function scoreSignals(signals: Signal[], policy: PolicyPack): ScoredSignal[] {
  return signals.map((signal) => {
    const halfLifeSec = halfLifeFor(policy, signal.name)
    const weight = clamp01(policy.weights?.[signal.name] ?? signal.weight)
    // A `missing` signal is the absence of knowledge. It carries zero
    // confidence by construction, which is what drags the aggregate down.
    const effectiveConfidence =
      signal.kind === 'missing'
        ? 0
        : decayConfidence(signal.confidence, signal.freshnessSec, halfLifeSec)
    return {
      signal: { ...signal, weight },
      halfLifeSec,
      effectiveConfidence,
      strength: weight * effectiveConfidence,
      stale: signal.kind !== 'missing' && effectiveConfidence < signal.confidence * 0.5,
    }
  })
}

/**
 * Contradiction detection, done generically. Two signals contradict when they
 * assert opposite polarities of the same proposition. The kernel does not need
 * to know what the proposition means.
 *
 * `severity` asks how *evenly matched* the conflict is after decay. Two fresh,
 * equally confident sources pointing opposite ways is the worst case, because
 * nothing tells you which to believe. A fresh source against a badly decayed
 * one is barely a conflict at all — decay has already settled it.
 */
export function findContradictions(scored: ScoredSignal[]): Contradiction[] {
  const byProposition = new Map<string, { yes: ScoredSignal[]; no: ScoredSignal[] }>()

  for (const s of scored) {
    const asserts = s.signal.asserts
    if (!asserts) continue
    let bucket = byProposition.get(asserts.proposition)
    if (!bucket) {
      bucket = { yes: [], no: [] }
      byProposition.set(asserts.proposition, bucket)
    }
    ;(asserts.polarity ? bucket.yes : bucket.no).push(s)
  }

  const out: Contradiction[] = []
  for (const [proposition, bucket] of byProposition) {
    if (bucket.yes.length === 0 || bucket.no.length === 0) continue
    const strongestYes = pickStrongest(bucket.yes)
    const strongestNo = pickStrongest(bucket.no)
    const a = strongestYes.effectiveConfidence
    const b = strongestNo.effectiveConfidence
    const high = Math.max(a, b)
    const low = Math.min(a, b)
    const severity = high === 0 ? 0 : low / high
    const impact = severity * high
    out.push({
      proposition,
      forSignalId: strongestYes.signal.id,
      againstSignalId: strongestNo.signal.id,
      severity,
      impact,
      explanation:
        `"${strongestYes.signal.name}" says ${proposition} is true (${pct(a)} after decay) ` +
        `while "${strongestNo.signal.name}" says it is false (${pct(b)} after decay).`,
    })
  }
  return out.sort((x, y) => y.impact - x.impact)
}

/**
 * Epistemic confidence: a weighted mean of surviving source confidence over
 * every signal that speaks to what we know, then bitten into once per
 * contradiction.
 */
export function aggregateConfidence(
  scored: ScoredSignal[],
  contradictions: Contradiction[],
  contradictionPenalty: number,
): { confidence: number; before: number } {
  const contributors = scored.filter(
    (s) =>
      s.signal.kind === 'evidence' ||
      s.signal.kind === 'confidence' ||
      s.signal.kind === 'missing',
  )
  const totalWeight = contributors.reduce((sum, s) => sum + s.signal.weight, 0)
  const before =
    totalWeight === 0
      ? 0
      : contributors.reduce((sum, s) => sum + s.signal.weight * s.effectiveConfidence, 0) /
        totalWeight

  let confidence = before
  for (const c of contradictions) {
    confidence *= 1 - c.impact * clamp01(contradictionPenalty)
  }
  return { confidence: clamp01(confidence), before: clamp01(before) }
}

/**
 * Evidentiary support, 0..1. Each evidence signal votes with `support` and is
 * heard in proportion to its `strength` — that is, its weight *after* decay.
 * A stale signal barely votes. With no evidence at all the answer is 0.5:
 * perfectly undecided, which will not clear any sane `minSupport`.
 */
export function aggregateSupport(scored: ScoredSignal[]): number {
  const voters = scored.filter(
    (s) => s.signal.kind === 'evidence' && typeof s.signal.support === 'number',
  )
  const totalStrength = voters.reduce((sum, s) => sum + s.strength, 0)
  if (totalStrength === 0) return 0.5
  const weighted = voters.reduce((sum, s) => sum + s.strength * clamp01(s.signal.support!), 0)
  return clamp01(weighted / totalStrength)
}

/**
 * Risk, 0..1, combined as a probabilistic OR rather than a mean. Risks
 * accumulate: five independent 20% risks are worse than one, and a mean would
 * hide that. A risk reported by a decayed source contributes less.
 */
export function aggregateRisk(scored: ScoredSignal[]): number {
  const risks = scored.filter((s) => s.signal.kind === 'risk')
  if (risks.length === 0) return 0
  let survives = 1
  for (const r of risks) {
    const magnitude = clamp01(toNumber(r.signal.value)) * clamp01(r.strength)
    survives *= 1 - magnitude
  }
  return clamp01(1 - survives)
}

/**
 * The headline number.
 *
 *   costOfBeingWrong = risk x (1 - reversibility) x impact x (1 - confidence)
 *
 * Read left to right: how likely this goes wrong, how stuck we are if it does,
 * how big the blast is, and how much of that is genuinely unknown to us. It is
 * denominated in the policy pack's own unit — dollars, users, reach — so it
 * appears on screen as a quantity a human can argue with.
 */
export function costOfBeingWrong(params: {
  riskScore: number
  reversibility: number
  impactScale: number
  confidence: number
}): number {
  const { riskScore, reversibility, impactScale, confidence } = params
  return (
    clamp01(riskScore) *
    (1 - clamp01(reversibility)) *
    Math.max(0, impactScale) *
    (1 - clamp01(confidence))
  )
}

/** Everything above, in one pass. Pure: same inputs, same numbers, always. */
export function score(signals: Signal[], policy: PolicyPack, ctxImpact: number, ctxReversibility: { value: number; because: string }): Scoring {
  const scoredSignals = scoreSignals(signals, policy)
  const contradictions = findContradictions(scoredSignals)
  const { confidence, before } = aggregateConfidence(
    scoredSignals,
    contradictions,
    policy.thresholds.contradictionPenalty,
  )
  const support = aggregateSupport(scoredSignals)
  const riskScore = aggregateRisk(scoredSignals)
  const cost = costOfBeingWrong({
    riskScore,
    reversibility: ctxReversibility.value,
    impactScale: ctxImpact,
    confidence,
  })
  return {
    confidence,
    confidenceBeforeContradictions: before,
    support,
    riskScore,
    reversibility: ctxReversibility.value,
    reversibilityBecause: ctxReversibility.because,
    impactScale: ctxImpact,
    costOfBeingWrong: cost,
    costNormalized:
      policy.thresholds.escalateCost > 0
        ? clamp01(cost / policy.thresholds.escalateCost)
        : 0,
    scoredSignals,
    contradictions,
  }
}

// --- small helpers ---------------------------------------------------------

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function toNumber(value: number | boolean | string): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function pickStrongest(list: ScoredSignal[]): ScoredSignal {
  return list.reduce((best, s) => (s.effectiveConfidence > best.effectiveConfidence ? s : best))
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

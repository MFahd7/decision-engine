/**
 * A deliberately naive baseline, for comparison only.
 *
 * This is NOT a claim about any particular product. It is a constructed
 * strawman with one job: to isolate what the kernel's extra machinery actually
 * buys. Its rule is stated in full here so nobody has to take the comparison
 * on trust:
 *
 *   Read the evidence at face value. Confidence is the weight-averaged
 *   self-reported confidence of the sources. Support is the weight-averaged
 *   direction of the evidence. Act when confidence >= 0.75 and support >= 0.60.
 *
 * What it ignores is the whole point of the list:
 *
 *   - freshness      a 41-day-old record counts exactly as much as a live one
 *   - contradiction  two sources pointing opposite ways are averaged, not flagged
 *   - gaps           what we do not know does not appear in the arithmetic
 *   - reversibility  no notion of whether the action can be undone
 *   - cost           no notion of how much rides on being wrong
 *   - authority      no notion of who is asking
 *
 * This is roughly the shape you get by handing a list of evidence to a
 * language model and asking it to score the case, which is exactly the
 * "prompt wrapper" this project exists to be measured against.
 */

import type { Signal } from './types'

export type NaiveVerdict = {
  outcome: 'execute' | 'hold'
  confidence: number
  support: number
  /** The signal it leaned on hardest, for explaining the difference. */
  dominantSignal: string
  because: string
}

export const NAIVE_MIN_CONFIDENCE = 0.75
export const NAIVE_MIN_SUPPORT = 0.6

export function naiveDecide(signals: Signal[]): NaiveVerdict {
  const evidence = signals.filter((s) => s.kind === 'evidence')

  if (evidence.length === 0) {
    return {
      outcome: 'hold',
      confidence: 0,
      support: 0,
      dominantSignal: 'none',
      because: 'No evidence at all.',
    }
  }

  const totalWeight = evidence.reduce((sum, s) => sum + s.weight, 0)
  const confidence =
    evidence.reduce((sum, s) => sum + s.weight * s.confidence, 0) / totalWeight

  const strengths = evidence.map((s) => s.weight * s.confidence)
  const totalStrength = strengths.reduce((sum, n) => sum + n, 0)
  const support =
    totalStrength === 0
      ? 0
      : evidence.reduce((sum, s, i) => sum + strengths[i]! * (s.support ?? 0.5), 0) / totalStrength

  let dominantIndex = 0
  for (let i = 1; i < strengths.length; i++) {
    if (strengths[i]! > strengths[dominantIndex]!) dominantIndex = i
  }
  const dominant = evidence[dominantIndex]!

  const go = confidence >= NAIVE_MIN_CONFIDENCE && support >= NAIVE_MIN_SUPPORT
  return {
    outcome: go ? 'execute' : 'hold',
    confidence,
    support,
    dominantSignal: dominant.name,
    because: go
      ? `Evidence averages ${Math.round(confidence * 100)}% confident and ${Math.round(support * 100)}% in favour, led by "${dominant.name}" at ${Math.round(dominant.confidence * 100)}%. Acting.`
      : `Evidence averages ${Math.round(confidence * 100)}% confident and ${Math.round(support * 100)}% in favour, which is below the bar. Holding.`,
  }
}

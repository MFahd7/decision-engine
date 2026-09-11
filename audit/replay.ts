/**
 * Replay: re-judging the past under a policy you are thinking about adopting.
 *
 * This is the payoff for keeping the kernel pure and storing the full signal
 * set alongside every decision. A stored record carries its envelope and every
 * signal that was extracted at the time, so re-deciding it needs no database,
 * no carrier API and no language model — just the kernel and a different set
 * of thresholds.
 *
 * The output is the sentence a policy owner actually wants:
 *
 *   "Dropping the refund escalation ceiling to $40 would have changed 23 of
 *    the last 210 decisions: 19 execute to escalate, 4 ask to escalate."
 *
 * Which is a very different conversation from "shall we tighten it a bit".
 */

import { judge, policyFor } from '@/engine'
import type { Domain, Outcome, PolicyPack, Thresholds } from '@/core/types'
import type { AuditRecord } from './hashChain'

export type ThresholdOverride = Partial<Thresholds>

export type ReplayRequest = {
  domain: Domain
  thresholds?: ThresholdOverride
  /** Replace the blocking-field list entirely. Omit to keep the pack's own. */
  blockingFields?: string[]
}

export type ReplayChange = {
  auditId: string
  envelopeId: string
  from: Outcome
  to: Outcome
  /** Why it moved, taken from the rule that fires under the new policy. */
  because: string
  costOfBeingWrong: number
  unit: string
}

export type ReplayResult = {
  domain: Domain
  basePolicyVersion: string
  replayed: number
  changed: number
  /** e.g. { 'execute -> escalate': 19 } */
  transitions: Record<string, number>
  outcomesBefore: Record<Outcome, number>
  outcomesAfter: Record<Outcome, number>
  changes: ReplayChange[]
  effectiveThresholds: Thresholds
  /** Human sentence, ready to put on screen. */
  headline: string
}

const EMPTY_TALLY = (): Record<Outcome, number> => ({
  execute: 0,
  ask: 0,
  defer: 0,
  escalate: 0,
  refuse: 0,
})

export function replay(records: AuditRecord[], request: ReplayRequest): ReplayResult {
  const base = policyFor(request.domain)
  const effectiveThresholds: Thresholds = { ...base.thresholds, ...request.thresholds }

  const candidate: PolicyPack = {
    ...base,
    version: `${base.version}+replay`,
    thresholds: effectiveThresholds,
    blockingFields: request.blockingFields ?? base.blockingFields,
  }

  const scoped = records.filter((r) => r.envelope.domain === request.domain)
  const outcomesBefore = EMPTY_TALLY()
  const outcomesAfter = EMPTY_TALLY()
  const transitions: Record<string, number> = {}
  const changes: ReplayChange[] = []

  for (const record of scoped) {
    const before = record.decision.outcome
    // The pure half of the pipeline, re-run on stored signals. No extraction.
    const after = judge(record.envelope, record.signals, candidate, {
      withCounterfactuals: false,
      now: record.decision.decidedAt,
    })

    outcomesBefore[before]++
    outcomesAfter[after.outcome]++

    if (after.outcome !== before) {
      const key = `${before} -> ${after.outcome}`
      transitions[key] = (transitions[key] ?? 0) + 1
      changes.push({
        auditId: record.auditId,
        envelopeId: record.envelope.id,
        from: before,
        to: after.outcome,
        because: after.ruleTrace.find((r) => r.fired)?.because ?? '',
        costOfBeingWrong: after.costOfBeingWrong,
        unit: after.unit,
      })
    }
  }

  return {
    domain: request.domain,
    basePolicyVersion: base.version,
    replayed: scoped.length,
    changed: changes.length,
    transitions,
    outcomesBefore,
    outcomesAfter,
    changes,
    effectiveThresholds,
    headline: headlineFor(scoped.length, changes.length, transitions, describeChange(base.thresholds, effectiveThresholds, base.unit)),
  }
}

function describeChange(before: Thresholds, after: Thresholds, unit: string): string {
  const parts: string[] = []
  const money = (n: number) => (unit === 'USD' ? `$${n.toLocaleString('en-US')}` : `${n.toLocaleString('en-US')} ${unit}`)
  const percent = (n: number) => `${Math.round(n * 100)}%`

  if (before.escalateCost !== after.escalateCost) {
    parts.push(`moving the escalation ceiling from ${money(before.escalateCost)} to ${money(after.escalateCost)}`)
  }
  if (before.tolerance !== after.tolerance) {
    parts.push(`moving the tolerance from ${money(before.tolerance)} to ${money(after.tolerance)}`)
  }
  if (before.minConfidence !== after.minConfidence) {
    parts.push(`moving the confidence floor from ${percent(before.minConfidence)} to ${percent(after.minConfidence)}`)
  }
  if (before.minSupport !== after.minSupport) {
    parts.push(`moving the support floor from ${percent(before.minSupport)} to ${percent(after.minSupport)}`)
  }
  if (before.contradictionPenalty !== after.contradictionPenalty) {
    parts.push(
      `moving the contradiction penalty from ${percent(before.contradictionPenalty)} to ${percent(after.contradictionPenalty)}`,
    )
  }

  if (parts.length === 0) return 'Leaving every threshold where it is'
  return `${parts[0]!.charAt(0).toUpperCase()}${parts[0]!.slice(1)}${parts.length > 1 ? `, and ${parts.slice(1).join(', ')},` : ''}`
}

function headlineFor(
  replayed: number,
  changed: number,
  transitions: Record<string, number>,
  prefix: string,
): string {
  if (replayed === 0) return `${prefix} — but there are no stored decisions in this domain to replay against yet.`
  if (changed === 0) {
    return `${prefix} would have changed none of the last ${replayed} decisions.`
  }
  const detail = Object.entries(transitions)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${count} ${key.replace(' -> ', ' became ')}`)
    .join(', ')
  return `${prefix} would have changed ${changed} of the last ${replayed} decisions: ${detail}.`
}

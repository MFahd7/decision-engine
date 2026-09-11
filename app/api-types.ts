/** Shapes the console reads back from the API. Kept in one place so the
 *  client components stay free of `any`. */

import type {
  Decision,
  Domain,
  Outcome,
  Signal,
  Thresholds,
} from '@/core/types'
import type { NaiveVerdict } from '@/core/naive'
import type { ReplayResult } from '@/audit/replay'

export type ScenarioSummary = {
  id: string
  title: string
  expect: Outcome
  note: string
  actor: { id: string; role: string; authorityLevel: number }
  actionType: string
}

export type DomainSummary = {
  domain: Domain
  label: string
  blurb: string
  unit: string
  policyVersion: string
  thresholds: Thresholds
  blockingFields: string[]
  prohibitions: Array<{ id: string; description: string }>
  temporalBars: Array<{ id: string; description: string }>
  scenarios: ScenarioSummary[]
}

export type ScenariosResponse = {
  llm: { live: boolean; note: string }
  domains: DomainSummary[]
}

export type DecideResponse = {
  decision: Decision
  signals: Signal[]
  naive: NaiveVerdict
  policy: { version: string; unit: string; thresholds: Thresholds }
  audit: { seq: number; auditId: string; hash: string; prevHash: string }
}

export type ReplayResponse = ReplayResult & {
  baseThresholds: Thresholds
  unit: string
}

export type AuditListResponse = {
  total: number
  chain: { valid: boolean; length: number; head: string; brokenAtSeq?: number; reason?: string }
  records: Array<{
    seq: number
    auditId: string
    recordedAt: string
    domain: Domain
    outcome: Outcome
    firedRule: string
    confidence: number
    costOfBeingWrong: number
    unit: string
    policyVersion: string
    hash: string
    prevHash: string
    actor: { id: string; role: string; authorityLevel: number }
  }>
}

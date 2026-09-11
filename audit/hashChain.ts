/**
 * The audit chain.
 *
 * Each record stores the hash of the record before it, so the log is
 * append-only in a way that is checkable rather than merely asserted. Editing
 * a decision from three months ago requires rewriting every record since, and
 * `verifyChain` will say exactly which one broke.
 *
 * This is deliberately modest about what it proves. A single-writer hash chain
 * detects tampering by anyone who cannot rewrite the whole file; it does not
 * defend against an attacker with write access who recomputes the chain. Real
 * tamper-evidence needs the head published somewhere the writer does not
 * control. See ARCHITECTURE.md, "What we did not fix".
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/hash'
import type { ActionEnvelope, Decision, Signal } from '@/core/types'

export const GENESIS_HASH = '0'.repeat(64)

export type RealisedOutcome = {
  /** Did the decision turn out to be right? Recorded later, by a human or a job. */
  ok: boolean
  note: string
  recordedAt: string
}

export type AuditRecord = {
  seq: number
  auditId: string
  recordedAt: string
  /** The full input, so the decision can be re-judged without the original systems. */
  envelope: ActionEnvelope
  signals: Signal[]
  decision: Decision
  policyVersion: string
  prevHash: string
  hash: string
  realisedOutcome: RealisedOutcome | null
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Everything the hash covers. `hash` itself is excluded, for obvious reasons. */
export function hashableOf(record: Omit<AuditRecord, 'hash'>): string {
  return canonicalJson({
    seq: record.seq,
    auditId: record.auditId,
    recordedAt: record.recordedAt,
    envelope: record.envelope,
    signals: record.signals,
    decision: record.decision,
    policyVersion: record.policyVersion,
    prevHash: record.prevHash,
    realisedOutcome: record.realisedOutcome,
  })
}

export function sealRecord(record: Omit<AuditRecord, 'hash'>): AuditRecord {
  return { ...record, hash: sha256(hashableOf(record)) }
}

export type ChainVerification =
  | { valid: true; length: number; head: string }
  | { valid: false; length: number; head: string; brokenAtSeq: number; reason: string }

export function verifyChain(records: AuditRecord[]): ChainVerification {
  let prev = GENESIS_HASH

  for (const record of records) {
    if (record.prevHash !== prev) {
      return {
        valid: false,
        length: records.length,
        head: prev,
        brokenAtSeq: record.seq,
        reason: `Record ${record.seq} claims to follow ${short(record.prevHash)}, but the record before it hashes to ${short(prev)}. Something was inserted, removed or reordered.`,
      }
    }
    const recomputed = sha256(hashableOf(record))
    if (recomputed !== record.hash) {
      return {
        valid: false,
        length: records.length,
        head: prev,
        brokenAtSeq: record.seq,
        reason: `Record ${record.seq} stores hash ${short(record.hash)} but its contents hash to ${short(recomputed)}. The record was edited after it was written.`,
      }
    }
    prev = record.hash
  }

  return { valid: true, length: records.length, head: prev }
}

export function short(hash: string): string {
  return hash.slice(0, 12)
}

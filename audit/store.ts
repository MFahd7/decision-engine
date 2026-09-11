/**
 * Audit storage.
 *
 * Interface first, two implementations, and the rest of the system only ever
 * sees the interface. Swapping in Postgres means writing one class; nothing
 * else in the repository changes. The file implementation is a JSONL append —
 * the simplest thing that is genuinely append-only on disk.
 *
 * On Vercel the filesystem is read-only, so the memory store is used there and
 * reseeds on cold start. That is a real limitation and it is stated in the
 * README rather than papered over: the hosted demo's audit log is per-instance
 * and does not survive a redeploy.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ActionEnvelope, Decision, Domain, Signal } from '@/core/types'
import { GENESIS_HASH, sealRecord, verifyChain, type AuditRecord, type ChainVerification, type RealisedOutcome } from './hashChain'

export type AuditQuery = {
  domain?: Domain
  outcome?: Decision['outcome']
  limit?: number
  offset?: number
}

export interface AuditStore {
  append(entry: {
    envelope: ActionEnvelope
    signals: Signal[]
    decision: Decision
  }): Promise<AuditRecord>
  list(query?: AuditQuery): Promise<{ records: AuditRecord[]; total: number }>
  get(auditId: string): Promise<AuditRecord | undefined>
  all(): Promise<AuditRecord[]>
  verify(): Promise<ChainVerification>
  recordOutcome(auditId: string, outcome: RealisedOutcome): Promise<AuditRecord | undefined>
}

// ---------------------------------------------------------------------------

abstract class BaseStore implements AuditStore {
  protected abstract load(): Promise<AuditRecord[]>
  protected abstract persist(record: AuditRecord): Promise<void>
  protected abstract rewrite(records: AuditRecord[]): Promise<void>

  async append(entry: { envelope: ActionEnvelope; signals: Signal[]; decision: Decision }): Promise<AuditRecord> {
    const existing = await this.load()
    const prev = existing[existing.length - 1]
    const record = sealRecord({
      seq: existing.length,
      auditId: entry.decision.auditId,
      recordedAt: entry.decision.decidedAt,
      envelope: entry.envelope,
      signals: entry.signals,
      decision: entry.decision,
      policyVersion: entry.decision.policyVersion,
      prevHash: prev?.hash ?? GENESIS_HASH,
      realisedOutcome: null,
    })
    await this.persist(record)
    return record
  }

  async list(query: AuditQuery = {}): Promise<{ records: AuditRecord[]; total: number }> {
    const all = await this.load()
    const filtered = all.filter(
      (r) =>
        (!query.domain || r.envelope.domain === query.domain) &&
        (!query.outcome || r.decision.outcome === query.outcome),
    )
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    // Newest first for reading; the chain itself stays in write order.
    const page = [...filtered].reverse().slice(offset, offset + limit)
    return { records: page, total: filtered.length }
  }

  async get(auditId: string): Promise<AuditRecord | undefined> {
    return (await this.load()).find((r) => r.auditId === auditId)
  }

  async all(): Promise<AuditRecord[]> {
    return this.load()
  }

  async verify(): Promise<ChainVerification> {
    return verifyChain(await this.load())
  }

  /**
   * Recording how a decision actually turned out changes a sealed record, so
   * the chain from that point on is rebuilt. That is the honest treatment:
   * the log is append-only, and amending it is a visible, explicit act rather
   * than a quiet edit.
   */
  async recordOutcome(auditId: string, outcome: RealisedOutcome): Promise<AuditRecord | undefined> {
    const all = await this.load()
    const index = all.findIndex((r) => r.auditId === auditId)
    if (index === -1) return undefined

    const rebuilt: AuditRecord[] = all.slice(0, index)
    let prevHash = index === 0 ? GENESIS_HASH : all[index - 1]!.hash

    for (let i = index; i < all.length; i++) {
      const source = all[i]!
      const next = sealRecord({
        ...source,
        prevHash,
        realisedOutcome: i === index ? outcome : source.realisedOutcome,
      })
      rebuilt.push(next)
      prevHash = next.hash
    }

    await this.rewrite(rebuilt)
    return rebuilt[index]
  }
}

// ---------------------------------------------------------------------------

export class MemoryAuditStore extends BaseStore {
  private records: AuditRecord[] = []

  protected async load(): Promise<AuditRecord[]> {
    return this.records
  }
  protected async persist(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
  protected async rewrite(records: AuditRecord[]): Promise<void> {
    this.records = records
  }
}

export class FileAuditStore extends BaseStore {
  private cache: AuditRecord[] | null = null

  constructor(private readonly file: string) {
    super()
  }

  protected async load(): Promise<AuditRecord[]> {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) {
      this.cache = []
      return this.cache
    }
    const text = await readFile(this.file, 'utf8')
    this.cache = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditRecord)
    return this.cache
  }

  protected async persist(record: AuditRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    this.cache = [...(this.cache ?? []), record]
  }

  protected async rewrite(records: AuditRecord[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(this.file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
    this.cache = records
  }
}

// ---------------------------------------------------------------------------

let singleton: AuditStore | null = null
let seeded: Promise<void> | null = null

export function auditStore(): AuditStore {
  if (singleton) return singleton

  const mode = process.env.AUDIT_STORE ?? (process.env.VERCEL ? 'memory' : 'file')
  singleton =
    mode === 'memory'
      ? new MemoryAuditStore()
      : new FileAuditStore(path.join(process.cwd(), 'audit', 'data', 'audit.jsonl'))

  return singleton
}

/**
 * The replay panel needs a body of past decisions to diff against. Rather than
 * ship a canned log, the engine generates one on first use by running a
 * deterministic corpus through the real pipeline — so every record in it is a
 * genuine decision with a genuine hash, not a fixture pretending to be one.
 */
export async function ensureSeeded(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      const store = auditStore()
      if ((await store.all()).length > 0) return
      const { seedCorpus } = await import('./seed')
      await seedCorpus(store)
    })()
  }
  return seeded
}

/** Test hook: drop the singleton so a spec can start from an empty chain. */
export function resetAuditStoreForTests(): void {
  singleton = null
  seeded = null
}

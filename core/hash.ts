/**
 * Deterministic, dependency-free hashing helpers.
 *
 * `canonicalJson` is the single definition of "the bytes of this object" used
 * by both the audit hash chain and the decision id. Key order is normalised so
 * two structurally identical records always hash identically.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value))
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalise)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalise((value as Record<string, unknown>)[key])
  }
  return out
}

/**
 * FNV-1a, 64-bit, hex. Used for identifiers only — never for the audit chain,
 * which uses SHA-256. Kept here because it is synchronous and runs anywhere,
 * which the kernel needs in order to stay pure and platform-free.
 */
export function fnv1a(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

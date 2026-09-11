import { NextResponse } from 'next/server'
import { registry } from '@/engine'
import { llmAvailable } from '@/signals/llm/claimExtractor'
import { fixtures } from '@/fixtures'
import type { Domain } from '@/core/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DOMAINS: Domain[] = ['refunds', 'deploy', 'moderation']

/**
 * GET /api/scenarios
 *
 * What the console needs to draw its left-hand column: the domains, their
 * policy packs, and the shipped scenarios. Also reports whether the optional
 * language-model extractor is live, so the UI can say so honestly rather than
 * implying a model is involved when it is not.
 */
export async function GET() {
  return NextResponse.json({
    llm: {
      live: llmAvailable(),
      note: llmAvailable()
        ? 'ANTHROPIC_API_KEY is set. One signal per decision comes from a language model, with its self-reported confidence capped before the kernel sees it.'
        : 'No ANTHROPIC_API_KEY. The language-model signal falls back to a deterministic stub. Every verdict below is reproducible without any model.',
    },
    domains: DOMAINS.map((domain) => ({
      domain,
      label: registry[domain].label,
      blurb: registry[domain].blurb,
      unit: registry[domain].policy.unit,
      policyVersion: registry[domain].policy.version,
      thresholds: registry[domain].policy.thresholds,
      blockingFields: registry[domain].policy.blockingFields,
      prohibitions: registry[domain].policy.prohibitions.map((p) => ({ id: p.id, description: p.description })),
      temporalBars: registry[domain].policy.temporalBars.map((b) => ({ id: b.id, description: b.description })),
      scenarios: fixtures[domain].map((f) => ({
        id: f.id,
        title: f.title,
        expect: f.expect,
        note: f.note,
        actor: f.envelope.actor,
        actionType: f.envelope.actionType,
      })),
    })),
  })
}

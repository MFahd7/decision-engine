import { evaluate } from '@/engine'
import type { Decision } from '@/core/types'
import type { Fixture } from '@/fixtures'

/**
 * Fixtures pin their own clock, so a decision is reproducible; we pin the
 * decision timestamp too so that the whole Decision object is byte-stable
 * across runs.
 */
export async function decideFixture(fixture: Fixture): Promise<Decision> {
  const { decision } = await evaluate(fixture.envelope, {
    now: String(fixture.envelope.context['now'] ?? fixture.envelope.requestedAt),
  })
  return decision
}

/** One line per fixture, for when an assertion fails and you need the numbers. */
export function explain(fixture: Fixture, decision: Decision): string {
  return [
    `${fixture.id}`,
    `  expected ${fixture.expect}, got ${decision.outcome} (${decision.firedRule})`,
    `  confidence ${decision.confidence.toFixed(3)} support ${decision.support.toFixed(3)} risk ${decision.riskScore.toFixed(3)}`,
    `  reversibility ${decision.reversibility.toFixed(2)} impact ${decision.impactScale} cost ${decision.costOfBeingWrong.toFixed(2)} ${decision.unit}`,
    `  gaps ${decision.missingInformation.filter((g) => g.blocking).map((g) => g.field).join(', ') || 'none'}`,
    ...decision.ruleTrace.map((r) => `    ${r.fired ? 'FIRED ' : r.skipped ? '  -   ' : '      '} ${r.id}: ${r.because}`),
  ].join('\n')
}

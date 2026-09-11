/**
 * Code deploy policy pack.
 *
 * The interesting entries here are the temporal bars. Most permission systems
 * only know "yes" and "no", so a deploy freeze has to be modelled as a denial —
 * which is wrong, and which is why people learn to route around it. A freeze is
 * not a refusal. It is a `defer` with a time attached.
 */

import type { PolicyPack } from '@/core/types'

const HOUR = 3600
const DAY = 24 * HOUR

export const deployPolicy: PolicyPack = {
  domain: 'deploy',
  version: 'deploy@2.1.0',
  unit: 'users at risk',

  thresholds: {
    minConfidence: 0.75,
    minSupport: 0.7,
    tolerance: 900,
    escalateCost: 12_000,
    contradictionPenalty: 0.85,
  },

  halfLifeSec: {
    '*': 7 * DAY,
    // A CI run is a statement about a base commit that main has since moved
    // past. Six hours is generous.
    tests_passing: 6 * HOUR,
    coverage_delta: 6 * HOUR,
    flaky_test_retries: 6 * HOUR,
    oncall_available: 2 * HOUR,
    historical_change_failure_rate: 30 * DAY,
    blast_radius: 30 * DAY,
    irreversible_migration: 0,
    change_size: 0,
    rollback_plan_exists: 0,
    rollout_strategy: 0,
    change_description_claim: 0,
    actor_authority_level: 0,
  },

  blockingFields: ['oncall_coverage', 'rollback_plan'],

  prohibitions: [
    {
      id: 'SECRETS_IN_DIFF',
      description:
        'the diff contains what the scanner reads as a live credential, and shipping it would publish the secret.',
      test: (ctx) => ctx.envelope.context['secretsDetected'] === true,
    },
    {
      id: 'UNSIGNED_COMMIT_REGULATED_SERVICE',
      description:
        'this service is under change-control audit and every deployed commit must be signed. This one is not.',
      test: (ctx) =>
        ctx.envelope.context['regulatedService'] === true &&
        ctx.envelope.payload['change'] !== undefined &&
        (ctx.envelope.payload['change'] as { signed?: boolean }).signed === false,
    },
  ],

  temporalBars: [
    {
      id: 'DEPLOY_FREEZE',
      description: 'A deploy freeze is in force.',
      test: (ctx) => (ctx.envelope.context['deployFreeze'] as { active?: boolean } | undefined)?.active === true,
      clearsAt: (ctx) =>
        String((ctx.envelope.context['deployFreeze'] as { endsAt?: string } | undefined)?.endsAt ?? 'the end of the freeze window'),
    },
    {
      id: 'ACTIVE_INCIDENT',
      description:
        'There is an open incident on this service, so a new variable is the last thing anyone needs.',
      test: (ctx) => ctx.envelope.context['incidentActive'] === true,
      clearsAt: () => 'incident resolution',
    },
  ],

  requiredAuthority: (ctx) => {
    const tier = String((ctx.envelope.payload['service'] as { tier?: string } | undefined)?.tier ?? 'tier3')
    // The signal carries a magnitude, not a flag: a migration with a
    // down-path scores low and does not by itself demand a director.
    const migration = ctx.num('irreversible_migration', 0) > 0.5
    if (migration) return { level: 4, because: 'any deploy carrying an irreversible migration' }
    if (tier === 'tier1') return { level: 3, because: 'tier-1 services' }
    if (tier === 'tier2') return { level: 2, because: 'tier-2 services' }
    return { level: 1, because: 'tier-3 services' }
  },

  impactScale: (ctx) => ctx.field('blastRadiusUsers', 0),

  /**
   * Reversibility here is not a property of the code. It is a property of the
   * rollout: the same commit is trivially undoable behind a canary and
   * effectively permanent behind a migration that drops a column.
   */
  reversibility: (ctx) => {
    const change = ctx.envelope.payload['change'] as
      | { touchesMigrations?: boolean; migrationReversible?: boolean }
      | undefined
    const rollout = ctx.envelope.payload['rollout'] as
      | { strategy?: string; rollbackPlan?: string | null }
      | undefined

    if (change?.touchesMigrations && change.migrationReversible === false) {
      return {
        value: 0.05,
        because: 'the migration has no down-path, so rolling the code back leaves it unable to read its own database',
      }
    }
    if (!rollout?.rollbackPlan) {
      return { value: 0.1, because: 'no rollback plan exists, so recovery would be improvised under pressure' }
    }
    if (rollout.strategy === 'canary') {
      return { value: 0.9, because: 'a canary rollout is halted and reverted in a single command' }
    }
    if (rollout.strategy === 'blue_green') {
      return { value: 0.85, because: 'blue/green lets traffic be pointed back at the previous stack' }
    }
    return { value: 0.55, because: 'a rollback plan exists, but it reaches all traffic at once on the way out' }
  },

  rollbackPath: (ctx) => {
    const change = ctx.envelope.payload['change'] as
      | { touchesMigrations?: boolean; migrationReversible?: boolean }
      | undefined
    if (change?.touchesMigrations && change.migrationReversible === false) return null
    const rollout = ctx.envelope.payload['rollout'] as { rollbackPlan?: string | null } | undefined
    return rollout?.rollbackPlan ?? null
  },
}

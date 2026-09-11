/**
 * Content moderation policy pack.
 *
 * The prohibitions here are the ones worth reading. Each is a case where more
 * evidence is the wrong answer: you cannot become confident enough to destroy
 * something that is under legal hold or under appeal, because the objection is
 * not epistemic. That is the difference between `refuse` and `escalate`, and
 * it is why the counterfactual panel deliberately offers nothing when R1 fires.
 */

import type { PolicyPack } from '@/core/types'

const DAY = 24 * 3600

export const moderationPolicy: PolicyPack = {
  domain: 'moderation',
  version: 'moderation@3.0.0',
  unit: 'people reached',

  thresholds: {
    // Deliberately unreachable by a classifier alone. Model confidence is
    // capped at 0.75 before it ever gets here, so no score, however emphatic,
    // clears this floor on its own — something a human already ruled on has to
    // be in the mix. That is not a tuning accident; it is the policy.
    minConfidence: 0.75,
    minSupport: 0.75,
    tolerance: 500,
    escalateCost: 8_000,
    contradictionPenalty: 0.85,
  },

  halfLifeSec: {
    '*': 30 * DAY,
    // A score from an older classifier version is a statement made under an
    // older policy, by a model that has since been retrained.
    classifier_verdict: 21 * DAY,
    known_violating_hash_match: 180 * DAY,
    reporter_stated_reason: 14 * DAY,
    content_reach: 2 * DAY,
    author_prior_strikes: 180 * DAY,
    prior_appeals_upheld_against_us: 180 * DAY,
    account_maturity: 0,
    reads_as_satire: 0,
    reads_as_news_report: 0,
    quoted_for_criticism: 0,
    public_figure_on_public_matter: 0,
    post_text_reading: 0,
    actor_authority_level: 0,
  },

  blockingFields: ['native_language_review', 'reporter_reason'],

  prohibitions: [
    {
      id: 'CONTENT_UNDER_LEGAL_HOLD',
      description:
        'this content is under a legal preservation order, and deleting it would destroy evidence.',
      test: (ctx) => ctx.envelope.context['legalHold'] === true,
    },
    {
      id: 'PERMANENT_DELETE_WHILE_APPEAL_OPEN',
      description:
        'an appeal is open on this post, and permanently deleting the thing under appeal would decide the appeal by destroying it.',
      test: (ctx) =>
        ctx.envelope.context['appealPending'] === true && permanence(ctx.envelope.payload) === 'permanent_delete',
    },
    {
      id: 'PERMANENT_DELETE_OF_PROTECTED_SPEECH',
      description:
        'the post falls in a protected-speech category in this jurisdiction, where permanent removal requires a court order rather than a policy decision.',
      test: (ctx) =>
        (ctx.envelope.payload['jurisdiction'] as { protectedSpeechCategory?: boolean } | undefined)
          ?.protectedSpeechCategory === true && permanence(ctx.envelope.payload) === 'permanent_delete',
    },
  ],

  temporalBars: [
    {
      id: 'POLICY_GRACE_PERIOD',
      description:
        'The rule this post breaks was published less than 24 hours ago and is not enforceable yet.',
      test: (ctx) => ctx.envelope.context['policyInGracePeriod'] === true,
      clearsAt: (ctx) => String(ctx.envelope.context['policyEnforceableAt'] ?? 'the end of the grace period'),
    },
  ],

  requiredAuthority: (ctx) => {
    const p = permanence(ctx.envelope.payload)
    const impressions = ctx.field('post.reach.impressions', 0)
    if (p === 'permanent_delete') return { level: 4, because: 'any permanent deletion' }
    if (impressions > 100_000) return { level: 3, because: 'posts seen more than 100,000 times' }
    if (p === 'soft_hide') return { level: 2, because: 'reach limits and hides' }
    return { level: 1, because: 'labels and interstitials' }
  },

  impactScale: (ctx) => ctx.field('post.reach.impressions', 0),

  /**
   * The starkest reversibility spread of the three domains, and the reason
   * moderation is in this submission at all. A label is nearly free to undo.
   * A permanent delete is not undoable at any price, which drives the cost of
   * being wrong straight through the escalation ceiling on anything with reach.
   */
  reversibility: (ctx) => {
    switch (permanence(ctx.envelope.payload)) {
      case 'permanent_delete':
        return { value: 0, because: 'a permanent deletion cannot be undone by us or by anyone else' }
      case 'soft_hide':
        return { value: 0.9, because: 'a hide is lifted by flipping one field, and the post is intact underneath' }
      default:
        return { value: 0.98, because: 'a label is removed without touching the post' }
    }
  },

  rollbackPath: (ctx) => {
    switch (permanence(ctx.envelope.payload)) {
      case 'permanent_delete':
        return null
      case 'soft_hide':
        return 'Un-hide from the moderation console. The post, its replies and its metrics are preserved throughout.'
      default:
        return 'Remove the label. No effect on distribution once removed.'
    }
  },
}

function permanence(payload: Record<string, unknown>): string {
  const action = payload['action'] as { permanence?: string } | undefined
  return action?.permanence ?? 'soft_hide'
}

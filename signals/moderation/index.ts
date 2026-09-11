/**
 * Content moderation signal extractors.
 *
 * This is the domain where a language model is genuinely the right tool: only
 * a reader can tell a slur from a quotation of a slur. It is also the domain
 * where the model's confidence most obviously must be discounted, because the
 * cases it is most confident about are exactly the ones where context inverts
 * the meaning — satire, news reporting, and quoting something in order to
 * condemn it.
 *
 * So the classifier gets a signal, its self-report is capped, and a separate
 * set of context signals argues in the opposite direction. When they disagree,
 * `asserts` makes the kernel notice.
 */

import type { ActionEnvelope, Signal } from '@/core/types'
import { MODEL_CONFIDENCE_CAP, extractClaim, keywordStub } from '@/signals/llm/claimExtractor'
import { authoritySignals } from '@/signals/shared/authority'
import { ageSec, clamp01, flag, has, makeSignal, missing, num, runExtractors, str } from '@/signals/shared/helpers'

function classifierSignals(envelope: ActionEnvelope): Signal[] {
  const score = clamp01(num(envelope, 'classifier.score', 0))
  const selfConfidence = num(envelope, 'classifier.selfConfidence', 0.6)

  return [
    makeSignal(envelope, {
      name: 'classifier_verdict',
      kind: 'evidence',
      value: score,
      weight: 0.9,
      // The cap is the whole point. A classifier reporting 0.99 certainty is
      // reporting a number about its own activations, not about the world.
      confidence: Math.min(selfConfidence, MODEL_CONFIDENCE_CAP),
      freshnessSec: ageSec(envelope, str(envelope, 'classifier.observedAt')),
      source: 'model',
      support: score,
      asserts: { proposition: 'content_violates_policy', polarity: score >= 0.5 },
      rationale: `Classifier ${str(envelope, 'classifier.modelVersion', 'v?')} scored this ${score.toFixed(2)} for "${str(envelope, 'classifier.label', 'policy violation')}", self-reported certainty ${selfConfidence.toFixed(2)} and capped at ${MODEL_CONFIDENCE_CAP}.`,
      latencyMs: 0,
    }),
  ]
}

/**
 * A content-hash match against material a human already ruled on, as reported by
 * the platform's hash index. The match arrives on the envelope as a fact; this
 * engine does not compute hashes, any more than it queries a carrier. It is
 * the one moderation signal that is not a model output and not an opinion, and
 * it is the only route by which this domain reaches enough confidence to act
 * without a person — which is the correct shape for moderation.
 */
function hashMatchSignals(envelope: ActionEnvelope): Signal[] {
  if (!flag(envelope, 'hashMatch.previouslyActioned')) return []
  return [
    makeSignal(envelope, {
      name: 'known_violating_hash_match',
      kind: 'evidence',
      value: str(envelope, 'hashMatch.caseId', 'unknown case'),
      weight: 0.95,
      confidence: 0.97,
      freshnessSec: ageSec(envelope, str(envelope, 'hashMatch.actionedAt')),
      source: 'human',
      support: 0.95,
      asserts: { proposition: 'content_violates_policy', polarity: true },
      rationale: `Content-hash match with ${str(envelope, 'hashMatch.caseId', 'a prior case')}, which a human reviewer actioned and which survived appeal.`,
      latencyMs: 0,
    }),
  ]
}

/**
 * Someone reported this, and what they thought was wrong with it is not a
 * detail. A report with no stated reason is a gap only the reporter can close.
 */
function reportSignals(envelope: ActionEnvelope): Signal[] {
  if (has(envelope, 'report.reasonGiven')) {
    return [
      makeSignal(envelope, {
        name: 'reporter_stated_reason',
        kind: 'confidence',
        value: str(envelope, 'report.reasonGiven'),
        weight: 0.35,
        confidence: 0.7,
        freshnessSec: ageSec(envelope, str(envelope, 'report.reportedAt')),
        source: 'human',
        rationale: `Reported as "${str(envelope, 'report.reasonGiven')}" by ${num(envelope, 'report.reporterCount', 1)} account(s).`,
        latencyMs: 0,
      }),
    ]
  }
  return [
    missing(envelope, {
      field: 'reporter_reason',
      obtainableBy: 'user',
      weight: 0.5,
      question:
        'Which part of this post do you believe breaks the rules, and which rule? We will not action a report we cannot state a reason for.',
      rationale: 'The report arrived with no stated reason, so there is nothing specific to assess.',
    }),
  ]
}

/**
 * The signals that argue the classifier read the room wrong. Each one asserts
 * the opposite polarity on the same proposition, so a strong classifier score
 * against a strong satire flag registers as a contradiction rather than
 * quietly averaging out.
 */
function contextSignals(envelope: ActionEnvelope): Signal[] {
  const flags: Array<{ path: string; name: string; rationale: string; weight: number }> = [
    {
      path: 'contextFlags.isSatire',
      name: 'reads_as_satire',
      rationale: 'The post reads as satire, which classifiers routinely score as sincere.',
      weight: 0.8,
    },
    {
      path: 'contextFlags.isNewsReport',
      name: 'reads_as_news_report',
      rationale: 'The post reports on the thing rather than doing it.',
      weight: 0.85,
    },
    {
      path: 'contextFlags.isQuotedForCriticism',
      name: 'quoted_for_criticism',
      rationale: 'The offending words appear inside a quotation the author is condemning.',
      weight: 0.85,
    },
    {
      path: 'contextFlags.isPublicFigureSpeech',
      name: 'public_figure_on_public_matter',
      rationale: 'The speaker is a public figure speaking on a matter of public record.',
      weight: 0.6,
    },
  ]

  return flags
    .filter((f) => flag(envelope, f.path))
    .map((f) =>
      makeSignal(envelope, {
        name: f.name,
        kind: 'evidence',
        value: true,
        weight: f.weight,
        confidence: 0.8,
        freshnessSec: 0,
        source: 'human',
        support: 0.12,
        asserts: { proposition: 'content_violates_policy', polarity: false },
        rationale: f.rationale,
        latencyMs: 0,
      }),
    )
}

function authorStandingSignals(envelope: ActionEnvelope): Signal[] {
  const strikes = num(envelope, 'authorStanding.priorStrikes', 0)
  const upheld = num(envelope, 'authorStanding.appealsUpheld', 0)
  const ageDays = num(envelope, 'authorStanding.accountAgeDays', 0)

  return [
    makeSignal(envelope, {
      name: 'author_prior_strikes',
      kind: 'evidence',
      value: strikes,
      weight: 0.5,
      confidence: 0.95,
      freshnessSec: 7 * 86400,
      source: 'data',
      support: strikes > 0 ? clamp01(0.55 + 0.1 * strikes) : 0.4,
      rationale:
        strikes > 0
          ? `${strikes} upheld strike(s) against this account already.`
          : 'No prior strikes against this account.',
      latencyMs: 0,
    }),
    makeSignal(envelope, {
      name: 'prior_appeals_upheld_against_us',
      kind: 'risk',
      // Every time this author appealed and won, we were the ones who were
      // wrong. That is a direct measurement of our own error rate on them.
      value: clamp01(upheld * 0.3),
      weight: 0.7,
      confidence: 0.95,
      freshnessSec: 30 * 86400,
      source: 'data',
      rationale:
        upheld > 0
          ? `${upheld} previous action(s) against this author were overturned on appeal. Our record against this account is poor.`
          : 'No previous action against this author has been overturned.',
      latencyMs: 0,
    }),
    makeSignal(envelope, {
      name: 'account_maturity',
      kind: 'risk',
      value: ageDays < 7 ? 0.6 : ageDays < 90 ? 0.25 : 0.05,
      weight: 0.4,
      confidence: 0.95,
      freshnessSec: 0,
      source: 'data',
      rationale: `Account is ${ageDays} days old.`,
      latencyMs: 0,
    }),
  ]
}

function reachSignals(envelope: ActionEnvelope): Signal[] {
  const impressions = num(envelope, 'post.reach.impressions', 0)
  return [
    makeSignal(envelope, {
      name: 'content_reach',
      kind: 'risk',
      value: clamp01(impressions / 500_000),
      weight: 0.75,
      confidence: 0.9,
      freshnessSec: ageSec(envelope, str(envelope, 'post.reach.measuredAt')),
      source: 'data',
      rationale: `The post has been seen roughly ${impressions.toLocaleString('en-US')} times.`,
      latencyMs: 0,
    }),
  ]
}

/**
 * A classifier trained mostly on English, applied to a language it barely
 * covers, is a guess wearing a number. Only a human reviewer closes this, and
 * a reviewer is a queue rather than a person you can ask — hence `system`.
 */
function languageCoverageSignals(envelope: ActionEnvelope): Signal[] {
  const language = str(envelope, 'post.language', 'en')
  const covered = (envelope.context['classifierLanguages'] as string[] | undefined) ?? ['en']
  if (covered.includes(language)) return []

  return [
    missing(envelope, {
      field: 'native_language_review',
      obtainableBy: 'system',
      weight: 0.85,
      question: `The classifier does not cover ${language}. A native-speaking reviewer needs to read this; the queue is currently ${num(envelope, 'humanReviewQueueDepth', 0)} deep.`,
      rationale: `Post is in ${language}, which this classifier version does not cover.`,
    }),
  ]
}

function claimSignals(envelope: ActionEnvelope): Promise<Signal[]> {
  return extractClaim({
    envelope,
    signalName: 'post_text_reading',
    text: str(envelope, 'post.text', ''),
    question:
      'Does this post, read in context, violate a policy against harassment, incitement or hate speech? ' +
      'Quoting, reporting on, or satirising such content is not the same as doing it.',
    weight: 0.55,
    stub: keywordStub({
      supporting: ['should be hurt', 'go after them', 'we know where', 'deserve to die', 'get rid of them'],
      opposing: ['reported that', 'according to', 'quote', 'satire', 'parody', 'condemn', 'disgusting that anyone would say'],
      baseConfidence: 0.35,
    }),
  })
}

export function moderationExtractors() {
  return [
    classifierSignals,
    hashMatchSignals,
    reportSignals,
    contextSignals,
    authorStandingSignals,
    reachSignals,
    languageCoverageSignals,
    claimSignals,
    authoritySignals,
  ]
}

export function extractModerationSignals(envelope: ActionEnvelope): Promise<Signal[]> {
  return runExtractors(envelope, moderationExtractors())
}

/** Kept exported so a fixture can assert on it without duplicating the path. */
export function permanenceOf(envelope: ActionEnvelope): string {
  return has(envelope, 'action.permanence') ? str(envelope, 'action.permanence') : 'soft_hide'
}

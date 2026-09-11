/**
 * Code deploy signal extractors.
 *
 * This is the domain where `defer` earns its place. Nothing is forbidden,
 * nothing is missing, and no person could answer a question that would help.
 * It is 4pm on a Friday, the on-call engineer is at a wedding, and the correct
 * answer is "not now" — which is a different verdict from "no" and a different
 * verdict from "tell me more".
 */

import type { ActionEnvelope, Signal } from '@/core/types'
import { extractClaim, keywordStub } from '@/signals/llm/claimExtractor'
import { authoritySignals } from '@/signals/shared/authority'
import { ageSec, clamp01, flag, has, makeSignal, missing, num, runExtractors, str } from '@/signals/shared/helpers'

/**
 * A green CI run is a statement about a commit against a base that has since
 * moved on. Six hours later it is a claim about a repository that no longer
 * exists — hence a short half-life in the policy pack, and a freshness stamped
 * from when the pipeline finished rather than from when we looked it up.
 */
function ciSignals(envelope: ActionEnvelope): Signal[] {
  const total = Math.max(1, num(envelope, 'ci.testsTotal', 1))
  const failed = num(envelope, 'ci.testsFailed', 0)
  const passRate = clamp01((total - failed) / total)
  const finishedAge = ageSec(envelope, str(envelope, 'ci.pipelineFinishedAt'))
  const retries = num(envelope, 'ci.flakyRetries', 0)
  const coverageDelta = num(envelope, 'ci.coverageDelta', 0)

  const out: Signal[] = [
    makeSignal(envelope, {
      name: 'tests_passing',
      kind: 'evidence',
      value: passRate,
      weight: 1,
      confidence: 0.98,
      freshnessSec: finishedAge,
      source: 'data',
      support: failed === 0 ? 0.95 : clamp01(passRate * 0.4),
      asserts: { proposition: 'change_is_safe_to_ship', polarity: failed === 0 },
      rationale:
        failed === 0
          ? `All ${total} tests passed.`
          : `${failed} of ${total} tests failed.`,
      latencyMs: 0,
    }),
    makeSignal(envelope, {
      name: 'coverage_delta',
      kind: 'evidence',
      value: coverageDelta,
      weight: 0.4,
      confidence: 0.9,
      freshnessSec: finishedAge,
      source: 'data',
      support: coverageDelta >= 0 ? 0.8 : clamp01(0.5 + coverageDelta * 4),
      rationale:
        coverageDelta >= 0
          ? `Coverage moved ${(coverageDelta * 100).toFixed(1)} points, so the new code is tested.`
          : `Coverage fell ${(Math.abs(coverageDelta) * 100).toFixed(1)} points, so some of this change is untested.`,
      latencyMs: 0,
    }),
  ]

  if (retries > 0) {
    out.push(
      makeSignal(envelope, {
        name: 'flaky_test_retries',
        kind: 'risk',
        // A suite that only goes green on the third attempt is not telling you
        // the change is fine. It is telling you the suite is unreliable.
        value: clamp01(0.25 * retries),
        weight: 0.7,
        confidence: 0.95,
        freshnessSec: finishedAge,
        source: 'data',
        rationale: `The suite needed ${retries} retry attempt(s) before it went green.`,
        latencyMs: 0,
      }),
    )
  }

  return out
}

function changeShapeSignals(envelope: ActionEnvelope): Signal[] {
  const out: Signal[] = []
  const touchesMigrations = flag(envelope, 'change.touchesMigrations')
  const reversible = flag(envelope, 'change.migrationReversible', true)
  const linesChanged = num(envelope, 'change.linesChanged', 0)

  if (touchesMigrations) {
    out.push(
      makeSignal(envelope, {
        name: 'irreversible_migration',
        kind: 'risk',
        value: reversible ? 0.2 : 0.9,
        weight: 0.95,
        confidence: 1,
        freshnessSec: 0,
        source: 'rule',
        rationale: reversible
          ? 'Change includes a schema migration, and a down-migration is present.'
          : 'Change includes a schema migration with no down-migration. Once it runs, the old code cannot read the database.',
        latencyMs: 0,
      }),
    )
  }

  out.push(
    makeSignal(envelope, {
      name: 'change_size',
      kind: 'risk',
      // Around 1,500 changed lines this pins. Big diffs are not automatically
      // bad, but they are automatically harder to review and to revert cleanly.
      value: clamp01(linesChanged / 1500),
      weight: 0.5,
      confidence: 1,
      freshnessSec: 0,
      source: 'rule',
      rationale: `${linesChanged} lines changed across ${num(envelope, 'change.filesChanged', 0)} files.`,
      latencyMs: 0,
    }),
  )

  return out
}

function rolloutSignals(envelope: ActionEnvelope): Signal[] {
  const hasPlan = has(envelope, 'rollout.rollbackPlan')
  const strategy = str(envelope, 'rollout.strategy', 'all_at_once')
  const tier = str(envelope, 'service.tier', 'tier3')
  const out: Signal[] = []

  // On a tier-1 or tier-2 service the plan is not optional, and the person
  // asking for the deploy is exactly the person who can supply it. That is an
  // `ask`, not a refusal and not a wait.
  if (!hasPlan && (tier === 'tier1' || tier === 'tier2')) {
    out.push(
      missing(envelope, {
        field: 'rollback_plan',
        obtainableBy: 'user',
        weight: 0.75,
        question: `How would you roll this back if it goes wrong? ${str(envelope, 'service.name', 'This service')} is ${tier}, so the plan has to exist before the deploy, not after.`,
        rationale: `No rollback plan recorded for a ${tier} service.`,
        // Writing the plan down does not merely tick a box: it is what makes
        // the deploy genuinely recoverable, so the counterfactual has to move
        // reversibility too, not just the paperwork.
        ifSupplied: {
          supersedes: ['rollback_plan_exists'],
          payloadPatch: { 'rollout.rollbackPlan': 'Supplied by the requester in response to the question.' },
          evidence: { weight: 0.85, confidence: 1, support: 0.9 },
        },
      }),
    )
  }

  out.push(
    makeSignal(envelope, {
      name: 'rollback_plan_exists',
      kind: 'evidence',
      value: hasPlan,
      weight: 0.85,
      confidence: 1,
      freshnessSec: 0,
      source: 'rule',
      support: hasPlan ? 0.9 : 0.12,
      rationale: hasPlan
        ? `Rollback plan on file: ${str(envelope, 'rollout.rollbackPlan')}`
        : 'No rollback plan recorded for this deploy.',
      latencyMs: 0,
    }),
  )

  out.push(
    makeSignal(envelope, {
      name: 'rollout_strategy',
      kind: 'evidence',
      value: strategy,
      weight: 0.6,
      confidence: 1,
      freshnessSec: 0,
      source: 'rule',
      support: strategy === 'canary' ? 0.9 : strategy === 'blue_green' ? 0.82 : 0.35,
      rationale:
        strategy === 'all_at_once'
          ? 'Rolling out to all traffic at once, so a bad change reaches everyone before anyone notices.'
          : `Rolling out via ${strategy.replace('_', ' ')}, so a bad change is caught on a fraction of traffic.`,
      latencyMs: 0,
    }),
  )

  return out
}

function reliabilitySignals(envelope: ActionEnvelope): Signal[] {
  const changeFailureRate = num(envelope, 'changeFailureRate30d', 0)
  const blast = num(envelope, 'blastRadiusUsers', 0)

  return [
    makeSignal(envelope, {
      name: 'historical_change_failure_rate',
      kind: 'risk',
      value: clamp01(changeFailureRate * 3),
      weight: 0.75,
      confidence: 0.85,
      freshnessSec: 7 * 86400,
      source: 'data',
      rationale: `${(changeFailureRate * 100).toFixed(0)}% of deploys to this service needed a fix-forward or rollback in the last 30 days.`,
      latencyMs: 0,
    }),
    makeSignal(envelope, {
      name: 'blast_radius',
      kind: 'risk',
      // Normalised against a 250k-user service. The absolute number is carried
      // separately as `impactScale`; this is only the shape of the risk.
      value: clamp01(blast / 250_000),
      weight: 0.8,
      confidence: 0.95,
      freshnessSec: 86400,
      source: 'data',
      rationale: `A bad deploy here reaches roughly ${blast.toLocaleString('en-US')} users.`,
      latencyMs: 0,
    }),
  ]
}

/**
 * The on-call gap. Note `obtainableBy: 'time'` — this is the field that sends
 * the decision down R4 to `defer` rather than R3 to `ask`. Nobody can answer
 * "is someone awake to fix this"; you can only wait until someone is.
 */
function oncallSignals(envelope: ActionEnvelope): Signal[] {
  if (flag(envelope, 'oncall.available', true)) {
    return [
      makeSignal(envelope, {
        name: 'oncall_available',
        kind: 'evidence',
        value: true,
        weight: 0.7,
        confidence: 0.95,
        freshnessSec: ageSec(envelope, str(envelope, 'oncall.confirmedAt')),
        source: 'data',
        support: 0.85,
        rationale: `${str(envelope, 'oncall.name', 'On-call engineer')} is online and has acknowledged the rota.`,
        latencyMs: 0,
      }),
    ]
  }

  return [
    missing(envelope, {
      field: 'oncall_coverage',
      obtainableBy: 'time',
      weight: 0.7,
      question: `Nobody is on call to catch this. ${str(envelope, 'oncall.name', 'The on-call engineer')} is back at ${str(envelope, 'oncall.nextAvailableAt', 'the next rota window')}.`,
      rationale: 'No on-call coverage, so a regression would run unattended until someone noticed.',
    }),
  ]
}

function claimSignals(envelope: ActionEnvelope): Promise<Signal[]> {
  return extractClaim({
    envelope,
    signalName: 'change_description_claim',
    text: str(envelope, 'change.description', ''),
    question:
      'Does this change description support shipping it to production right now? Weigh whether the author ' +
      'describes the change as understood and contained, or as risky, urgent, or partially tested.',
    weight: 0.35,
    stub: keywordStub({
      supporting: ['no behaviour change', 'no behavior change', 'refactor', 'typo', 'copy change', 'covered by tests', 'feature flag'],
      opposing: ['risky', 'hotfix', 'untested', 'not sure', 'temporary', 'revert if', 'yolo', 'schema'],
      inconsistentWhen: [['no behaviour change', 'schema']],
    }),
  })
}

export function deployExtractors() {
  return [
    ciSignals,
    changeShapeSignals,
    rolloutSignals,
    reliabilitySignals,
    oncallSignals,
    claimSignals,
    authoritySignals,
  ]
}

export function extractDeploySignals(envelope: ActionEnvelope): Promise<Signal[]> {
  return runExtractors(envelope, deployExtractors())
}

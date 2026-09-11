/**
 * The kernel: an ordered guard ladder, six rules, no domain knowledge.
 *
 * This file imports nothing about refunds, deploys or moderation. Every
 * threshold, prohibition, scale and half-life arrives in the PolicyPack. That
 * is the claim the whole submission rests on, so it is worth stating plainly:
 * an LLM never reaches this code path as an authority. A model can produce a
 * Signal, exactly like a database row or a rule can, and it carries a
 * self-reported confidence that this kernel is free to discount.
 *
 * The ladder is evaluated in order and stops at the first rule that fires.
 * Every rule is recorded either way, so the trace shows the road not taken.
 *
 *   R1  hard prohibition          -> refuse
 *   R2  authority ceiling         -> escalate
 *   R3  blocking gap, a human can answer it   -> ask
 *   R4  blocking gap, only time or a system can answer it, or a temporal bar -> defer
 *   R5  green light               -> execute
 *   R6  fallback                  -> escalate
 *
 * R6 is the safety argument. There is no path that reaches `execute` by
 * running out of rules. Absence of a reason to stop is not a reason to go.
 */

import { canonicalJson, fnv1a } from './hash'
import { age, humanise, pct, quantity } from './format'
import { makePolicyContext } from './policyContext'
import { score } from './scoring'
import type {
  ActionEnvelope,
  Counterfactual,
  Decision,
  Gap,
  Outcome,
  PolicyPack,
  RuleEvaluation,
  Scoring,
  Signal,
} from './types'

export type KernelInput = {
  envelope: ActionEnvelope
  signals: Signal[]
  policy: PolicyPack
}

export type KernelOptions = {
  /** Off for the recursive runs that build the counterfactual list. */
  withCounterfactuals?: boolean
  /** Fixed timestamp, so tests and replays produce byte-identical decisions. */
  now?: string
}

export function decide(input: KernelInput, options: KernelOptions = {}): Decision {
  const { envelope, signals, policy } = input
  const withCounterfactuals = options.withCounterfactuals !== false

  const ctx = makePolicyContext(envelope, signals)
  const reversibility = policy.reversibility(ctx)
  const impactScale = policy.impactScale(ctx)
  const scoring = score(signals, policy, impactScale, reversibility)
  const gaps = collectGaps(signals, policy)
  const rollbackPath = policy.rollbackPath(ctx)

  const trace: RuleEvaluation[] = []
  // Held on an object rather than in `let`s so that the assignments made
  // inside `rung`'s callback are visible to the type checker afterwards.
  const state: { outcome: Outcome | null; firedRule: string } = { outcome: null, firedRule: '' }

  const rung = (
    id: string,
    title: string,
    evaluate: () => { fired: boolean; outcome?: Outcome; because: string },
  ) => {
    if (state.outcome !== null) {
      trace.push({ id, title, fired: false, outcome: null, because: 'Not reached — an earlier rule already decided.', skipped: true })
      return
    }
    const result = evaluate()
    trace.push({
      id,
      title,
      fired: result.fired,
      outcome: result.fired ? (result.outcome ?? null) : null,
      because: result.because,
      skipped: false,
    })
    if (result.fired && result.outcome) {
      state.outcome = result.outcome
      state.firedRule = id
    }
  }

  // --- R1 -----------------------------------------------------------------
  const prohibition = policy.prohibitions.find((p) => p.test(ctx))
  const hasNoAuthority = envelope.actor.authorityLevel <= 0
  rung('R1_HARD_PROHIBITION', 'Hard prohibition', () => {
    if (prohibition) {
      return { fired: true, outcome: 'refuse', because: `Policy forbids this outright: ${prohibition.description}` }
    }
    if (hasNoAuthority) {
      return {
        fired: true,
        outcome: 'refuse',
        because: `${envelope.actor.role} holds authority level ${envelope.actor.authorityLevel}, which is no authority at all for ${humanise(envelope.actionType)}.`,
      }
    }
    return {
      fired: false,
      because: `No prohibition matches, and ${envelope.actor.role} holds authority level ${envelope.actor.authorityLevel}.`,
    }
  })

  // --- R2 -----------------------------------------------------------------
  const required = policy.requiredAuthority(ctx, scoring.costOfBeingWrong)
  const overCostCeiling = scoring.costOfBeingWrong >= policy.thresholds.escalateCost
  const underAuthority = envelope.actor.authorityLevel < required.level
  rung('R2_AUTHORITY_CEILING', 'Authority ceiling', () => {
    if (overCostCeiling) {
      return {
        fired: true,
        outcome: 'escalate',
        because: `Cost of being wrong is ${quantity(scoring.costOfBeingWrong, policy.unit)}, at or above the ${quantity(policy.thresholds.escalateCost, policy.unit)} ceiling where a human decides.`,
      }
    }
    if (underAuthority) {
      return {
        fired: true,
        outcome: 'escalate',
        because: `This needs authority level ${required.level} (${required.because}); ${envelope.actor.role} holds ${envelope.actor.authorityLevel}.`,
      }
    }
    return {
      fired: false,
      because: `Cost of being wrong is ${quantity(scoring.costOfBeingWrong, policy.unit)}, under the ${quantity(policy.thresholds.escalateCost, policy.unit)} ceiling, and authority level ${envelope.actor.authorityLevel} meets the required ${required.level}.`,
    }
  })

  // --- R3 -----------------------------------------------------------------
  const askableGaps = gaps.filter((g) => g.blocking && g.obtainableBy === 'user')
  rung('R3_BLOCKING_GAP_USER_OBTAINABLE', 'Blocking gap a human can close', () => {
    if (askableGaps.length > 0) {
      return {
        fired: true,
        outcome: 'ask',
        because: `${askableGaps.length} blocking gap${askableGaps.length === 1 ? '' : 's'} a person can close: ${askableGaps.map((g) => g.field).join(', ')}.`,
      }
    }
    return { fired: false, because: 'No blocking gap that a person could answer.' }
  })

  // --- R4 -----------------------------------------------------------------
  const waitableGaps = gaps.filter(
    (g) => g.blocking && (g.obtainableBy === 'system' || g.obtainableBy === 'time'),
  )
  const bar = policy.temporalBars.find((b) => b.test(ctx))
  rung('R4_BLOCKING_GAP_OR_TEMPORAL_BAR', 'Blocking gap only time can close, or a temporal bar', () => {
    if (bar) {
      return {
        fired: true,
        outcome: 'defer',
        because: `${bar.description} Clears at ${bar.clearsAt(ctx)}.`,
      }
    }
    if (waitableGaps.length > 0) {
      return {
        fired: true,
        outcome: 'defer',
        because: `Waiting on ${waitableGaps.map((g) => g.field).join(', ')} — no person can supply ${waitableGaps.length === 1 ? 'it' : 'them'} on demand.`,
      }
    }
    return { fired: false, because: 'No temporal bar in force and nothing outstanding that only time could resolve.' }
  })

  // --- R5 -----------------------------------------------------------------
  const t = policy.thresholds
  const confidenceOk = scoring.confidence >= t.minConfidence
  const supportOk = scoring.support >= t.minSupport
  const costOk = scoring.costOfBeingWrong <= t.tolerance
  rung('R5_GREEN_LIGHT', 'Green light', () => {
    if (confidenceOk && supportOk && costOk) {
      return {
        fired: true,
        outcome: 'execute',
        because: `Confidence ${pct(scoring.confidence)} clears ${pct(t.minConfidence)}, support ${pct(scoring.support)} clears ${pct(t.minSupport)}, and cost of being wrong ${quantity(scoring.costOfBeingWrong, policy.unit)} is within the ${quantity(t.tolerance, policy.unit)} tolerance.`,
      }
    }
    const misses: string[] = []
    if (!confidenceOk) misses.push(`confidence ${pct(scoring.confidence)} is under the ${pct(t.minConfidence)} floor`)
    if (!supportOk) misses.push(`evidentiary support ${pct(scoring.support)} is under the ${pct(t.minSupport)} floor`)
    if (!costOk) misses.push(`cost of being wrong ${quantity(scoring.costOfBeingWrong, policy.unit)} exceeds the ${quantity(t.tolerance, policy.unit)} tolerance`)
    return { fired: false, because: `Green light withheld: ${misses.join('; ')}.` }
  })

  // --- R6 -----------------------------------------------------------------
  rung('R6_FALLBACK', 'Fallback', () => ({
    fired: true,
    outcome: 'escalate',
    because: 'No rule cleared this for execution. Absence of a reason to stop is not a reason to go, so it goes to a human.',
  }))

  const finalOutcome: Outcome = state.outcome ?? 'escalate'
  const firedRule = state.firedRule
  const decidedAt = options.now ?? new Date().toISOString()

  const base: Decision = {
    outcome: finalOutcome,
    confidence: scoring.confidence,
    support: scoring.support,
    riskScore: scoring.riskScore,
    reversibility: scoring.reversibility,
    impactScale: scoring.impactScale,
    costOfBeingWrong: scoring.costOfBeingWrong,
    costNormalized: scoring.costNormalized,
    unit: policy.unit,
    summary: summarise(finalOutcome, {
      envelope,
      policy,
      scoring,
      gaps,
      trace,
      firedRule,
      prohibition: prohibition?.description ?? null,
      requiredLevel: required.level,
      bar: bar ? bar.clearsAt(ctx) : null,
      barDescription: bar?.description ?? null,
    }),
    evidence: signals,
    scoredSignals: scoring.scoredSignals,
    contradictions: scoring.contradictions,
    missingInformation: gaps,
    rollbackPath,
    firedRule,
    ruleTrace: trace,
    counterfactual: [],
    policyVersion: policy.version,
    auditId: '',
    decidedAt,
    envelopeId: envelope.id,
  }

  base.auditId = `dec_${fnv1a(canonicalJson({ e: envelope, s: signals, v: policy.version }))}`

  if (withCounterfactuals && finalOutcome !== 'execute') {
    base.counterfactual = buildCounterfactuals(input, base, options)
  }

  return base
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/**
 * Which holes in our knowledge stop the show is a *policy* question, not an
 * extractor's. Extractors report what is missing; the pack decides which of
 * those fields block. That is why replaying under a stricter pack can turn a
 * past `execute` into an `ask` without re-running a single extractor.
 */
function collectGaps(signals: Signal[], policy: PolicyPack): Gap[] {
  const out: Gap[] = []
  for (const s of signals) {
    if (s.kind !== 'missing' || !s.gap) continue
    out.push({
      ...s.gap,
      blocking: policy.blockingFields.includes(s.gap.field),
      signalId: s.id,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Counterfactuals — "why not execute?"
// ---------------------------------------------------------------------------

/**
 * Because `decide` is pure, asking "what would have had to be different?" is
 * just running it again against a perturbed input. Each perturbation changes
 * exactly one thing, so whatever flips is genuinely responsible.
 *
 * There is deliberately no perturbation for R1. A refusal is not a threshold
 * you can climb over, and offering to negotiate one would be the wrong lesson
 * to teach anyone reading the output.
 */
function buildCounterfactuals(
  input: KernelInput,
  actual: Decision,
  options: KernelOptions,
): Counterfactual[] {
  if (actual.firedRule === 'R1_HARD_PROHIBITION') return []

  const perturbations = enumeratePerturbations(input, actual)
  const seen = new Set<string>()
  const out: Counterfactual[] = []

  for (const p of perturbations) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const probe = decide(p.apply(input), { withCounterfactuals: false, now: options.now })
    out.push({
      id: p.id,
      label: p.label,
      wouldBe: probe.outcome,
      flipsToExecute: probe.outcome === 'execute',
    })
  }

  // Whatever reaches `execute` is the useful answer, so it goes first.
  return out.sort((a, b) => Number(b.flipsToExecute) - Number(a.flipsToExecute))
}

type Perturbation = { id: string; label: string; apply: (input: KernelInput) => KernelInput }

function enumeratePerturbations(input: KernelInput, actual: Decision): Perturbation[] {
  const { envelope, signals, policy } = input
  const out: Perturbation[] = []

  // 1. Close each blocking gap, favourably. Stated as an assumption, not a fact.
  for (const gap of actual.missingInformation.filter((g) => g.blocking)) {
    const supplied = gap.ifSupplied
    const shape = supplied?.evidence ?? { weight: 0.7, confidence: 0.9, support: 1 }
    const superseded = new Set(supplied?.supersedes ?? [])

    out.push({
      id: `gap:${gap.field}`,
      label: `the ${humanise(gap.field)} were supplied and supported the request`,
      apply: (i) => ({
        ...i,
        // Closing a gap does not only remove the hole. It also supersedes
        // whatever was standing in for the missing fact, and it changes the
        // world the policy pack measures — a rollback plan that now exists
        // makes the deploy genuinely more reversible, not merely better
        // documented.
        envelope: supplied?.payloadPatch
          ? { ...i.envelope, payload: patched(i.envelope.payload, supplied.payloadPatch) }
          : i.envelope,
        signals: i.signals
          .filter((s) => s.id !== gap.signalId && !superseded.has(s.name))
          .concat({
            id: `${gap.signalId}_resolved`,
            name: `${gap.field}_supplied`,
            kind: 'evidence',
            value: true,
            weight: shape.weight,
            confidence: shape.confidence,
            freshnessSec: 0,
            source: 'human',
            support: shape.support,
            rationale: `Counterfactual: ${humanise(gap.field)} was supplied and supports the request.`,
            latencyMs: 0,
          }),
      }),
    })
  }

  // 2. Refresh each stale signal. This is the one that usually flips things.
  for (const s of actual.scoredSignals.filter((x) => x.stale)) {
    out.push({
      id: `fresh:${s.signal.name}`,
      label: `the ${humanise(s.signal.name)} record were current (it is ${age(s.signal.freshnessSec)} old)`,
      apply: (i) => ({
        ...i,
        signals: i.signals.map((x) => (x.id === s.signal.id ? { ...x, freshnessSec: 0 } : x)),
      }),
    })
  }

  // 3. Put a bigger signature on it.
  const ctx = makePolicyContext(envelope, signals)
  const required = policy.requiredAuthority(ctx, actual.costOfBeingWrong)
  if (envelope.actor.authorityLevel < required.level) {
    out.push({
      id: `authority:${required.level}`,
      label: `an approver with authority level ${required.level} or above signed off`,
      apply: (i) => ({
        ...i,
        envelope: { ...i.envelope, actor: { ...i.envelope.actor, authorityLevel: required.level } },
      }),
    })
  }

  // 4. Clear each material risk.
  for (const s of actual.scoredSignals) {
    if (s.signal.kind !== 'risk') continue
    const magnitude = typeof s.signal.value === 'number' ? s.signal.value : s.signal.value ? 1 : 0
    if (magnitude < 0.2) continue
    out.push({
      id: `risk:${s.signal.name}`,
      label: `the ${humanise(s.signal.name)} risk were cleared`,
      apply: (i) => ({
        ...i,
        signals: i.signals.map((x) => (x.id === s.signal.id ? { ...x, value: 0 } : x)),
      }),
    })
  }

  // 5. Wait out a temporal bar.
  const bar = policy.temporalBars.find((b) => b.test(ctx))
  if (bar) {
    out.push({
      id: `bar:${bar.id}`,
      label: `you waited until ${bar.clearsAt(ctx)}`,
      apply: (i) => ({
        ...i,
        policy: { ...i.policy, temporalBars: i.policy.temporalBars.filter((b) => b.id !== bar.id) },
      }),
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// The one sentence a non-technical reader needs
// ---------------------------------------------------------------------------

function summarise(
  outcome: Outcome,
  parts: {
    envelope: ActionEnvelope
    policy: PolicyPack
    scoring: Scoring
    gaps: Gap[]
    trace: RuleEvaluation[]
    firedRule: string
    prohibition: string | null
    requiredLevel: number
    bar: string | null
    barDescription: string | null
  },
): string {
  const { envelope, policy, scoring, gaps } = parts
  const action = humanise(envelope.actionType)
  const cost = quantity(scoring.costOfBeingWrong, policy.unit)

  switch (outcome) {
    case 'refuse':
      return parts.prohibition
        ? `Refusing to ${action}. ${capitalise(parts.prohibition)} This is a prohibition, not a threshold — no amount of extra evidence changes it.`
        : `Refusing to ${action}. ${envelope.actor.role} has no authority for this action at all.`

    case 'escalate': {
      if (parts.firedRule === 'R6_FALLBACK') {
        return `Escalating to a human. Nothing forbids this and nothing is missing, but it never earned a green light — confidence ${pct(scoring.confidence)}, support ${pct(scoring.support)}, and ${cost} at stake if it is wrong.`
      }
      return `Escalating to a human with authority level ${parts.requiredLevel} or above. Getting this wrong costs about ${cost}, which is more than a ${envelope.actor.role} decides alone.`
    }

    case 'ask': {
      const first = gaps.find((g) => g.blocking && g.obtainableBy === 'user')
      const rest = gaps.filter((g) => g.blocking && g.obtainableBy === 'user').length - 1
      const tail = rest > 0 ? ` (and ${rest} more question${rest === 1 ? '' : 's'})` : ''
      return `Asking before acting. ${first ? `"${first.question}"` : 'Something a person can answer is missing.'}${tail} Confidence sits at ${pct(scoring.confidence)}, and ${cost} rides on getting it right.`
    }

    case 'defer': {
      if (parts.barDescription) {
        return `Deferring. ${capitalise(parts.barDescription)} Nothing is missing and nobody needs to answer anything — the answer is simply "not now". Retry after ${parts.bar}.`
      }
      const waiting = gaps.filter((g) => g.blocking && g.obtainableBy !== 'user')
      return `Deferring. Waiting on ${waiting.map((g) => humanise(g.field)).join(' and ')}, which no person can produce on demand.`
    }

    case 'execute':
      return `Executing. Evidence supports it at ${pct(scoring.support)}, we know the situation to ${pct(scoring.confidence)}, and the worst realistic mistake here costs about ${cost}${scoring.reversibility >= 0.7 ? ' and is largely undoable' : ''}.`
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

/** Apply dotted-path values to a copy of the payload. Used only by counterfactuals. */
function patched(
  payload: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  for (const [dotted, value] of Object.entries(patch)) {
    const parts = dotted.split('.')
    let cursor: Record<string, unknown> = next
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!
      const child = cursor[key]
      if (child === null || typeof child !== 'object') cursor[key] = {}
      cursor = cursor[key] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1]!] = value
  }
  return next
}

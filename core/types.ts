/**
 * The Decision Engine — core type vocabulary.
 *
 * Nothing in this file knows about refunds, deploys or moderation. Domain
 * knowledge lives entirely in `/policies` (thresholds, prohibitions, scales)
 * and `/signals` (extractors). The kernel imports only from here.
 */

export type Domain = 'refunds' | 'deploy' | 'moderation'

/** The five verdicts. The engine returns exactly one. */
export type Outcome = 'execute' | 'ask' | 'defer' | 'escalate' | 'refuse'

export type SignalKind =
  /** Argues for or against the action being justified. Carries `support`. */
  | 'evidence'
  /** Contributes to the risk score. `value` is a 0..1 risk contribution. */
  | 'risk'
  /** Affects only how well we believe we know the situation, not the verdict's direction. */
  | 'confidence'
  /** Something we wanted and do not have. Carries `gap`. */
  | 'missing'
  /** Facts about who is asking and what they are allowed to do. */
  | 'authority'

/** Where a signal came from. `model` output is never trusted more than `data`. */
export type SignalSource = 'rule' | 'data' | 'model' | 'human'

/** Who or what can close a gap. Drives the ask/defer split. */
export type ObtainableBy = 'user' | 'system' | 'time'

export type ActionEnvelope = {
  id: string
  domain: Domain
  /** e.g. 'issue_refund' | 'deploy_to_prod' | 'remove_post' */
  actionType: string
  actor: { id: string; role: string; authorityLevel: number }
  payload: Record<string, unknown>
  context: Record<string, unknown>
  /** ISO 8601. */
  requestedAt: string
  idempotencyKey: string
}

/**
 * A claim about the world that two signals can disagree about. Contradiction
 * detection is generic: same proposition, opposite polarity, both still
 * carrying weight after freshness decay.
 */
export type Assertion = { proposition: string; polarity: boolean }

/** The shape of a hole in our knowledge, attached to a `missing` signal. */
export type GapSpec = {
  field: string
  obtainableBy: ObtainableBy
  /** The literal sentence to put in front of a human. */
  question: string
  /**
   * What the world would look like if this gap were closed. Used only by the
   * counterfactual engine, and supplied by the extractor because only the
   * extractor knows the domain.
   *
   * Without this, "what if you told us the rollback plan?" removes the gap but
   * leaves the `rollback_plan_exists` signal still saying there isn't one, and
   * leaves reversibility still computed as if recovery were improvised. The
   * counterfactual would then be quietly wrong in the pessimistic direction.
   */
  ifSupplied?: {
    /** Signals the answer would replace outright. */
    supersedes?: string[]
    /** Dotted payload paths the answer would fill in. */
    payloadPatch?: Record<string, unknown>
    /** Shape of the evidence the answer would produce. Defaults are cautious. */
    evidence?: { weight: number; confidence: number; support: number }
  }
}

/**
 * The atom of the system. Every extractor — rule, database lookup, LLM,
 * human input — returns these and nothing else.
 */
export type Signal = {
  id: string
  /** Stable identifier, e.g. 'return_received_at_warehouse'. Keys the half-life table. */
  name: string
  kind: SignalKind
  value: number | boolean | string
  /** Relative importance within its kind, 0..1. The policy pack may override. */
  weight: number
  /** How sure the *source* is of its own output, 0..1. Not how sure we are. */
  confidence: number
  /** Age in seconds of the underlying fact, not of the lookup. */
  freshnessSec: number
  source: SignalSource
  /** One human sentence. Shown verbatim in the UI. */
  rationale: string
  latencyMs: number
  /**
   * For `evidence` only: how strongly this argues the action is justified.
   * 0 = argues against, 0.5 = neutral, 1 = argues for.
   */
  support?: number
  asserts?: Assertion
  gap?: GapSpec
}

/** A gap the kernel has classified as blocking or not, under the current policy. */
export type Gap = GapSpec & {
  blocking: boolean
  signalId: string
}

/** Two signals that disagree about the same proposition. */
export type Contradiction = {
  proposition: string
  forSignalId: string
  againstSignalId: string
  /** 0..1. How evenly matched the conflict is after freshness decay. */
  severity: number
  /** 0..1. The multiplicative bite taken out of aggregate confidence. */
  impact: number
  explanation: string
}

/** One signal after freshness decay, kept for the audit trail and the UI. */
export type ScoredSignal = {
  signal: Signal
  halfLifeSec: number
  /** confidence x exp(-freshnessSec / halfLifeSec) */
  effectiveConfidence: number
  /** weight x effectiveConfidence — the signal's real say in the outcome. */
  strength: number
  /** True when decay cost this signal more than half its confidence. */
  stale: boolean
}

export type Scoring = {
  /** Epistemic: how well we believe we know the situation. 0..1. */
  confidence: number
  /** Evidentiary: how strongly what we know argues for acting. 0..1. */
  support: number
  /** 0..1, from `risk` signals. */
  riskScore: number
  /** 0 = irreversible, 1 = trivially undone. */
  reversibility: number
  reversibilityBecause: string
  /** Magnitude in the policy pack's declared unit (dollars, users, reach). */
  impactScale: number
  /** riskScore x (1 - reversibility) x impactScale x (1 - confidence) */
  costOfBeingWrong: number
  /** costOfBeingWrong / escalateCost, clamped to 0..1, for meters. */
  costNormalized: number
  scoredSignals: ScoredSignal[]
  contradictions: Contradiction[]
  /** Aggregate confidence before contradictions were applied. */
  confidenceBeforeContradictions: number
}

/** One rung of the ladder, recorded whether it fired or not. */
export type RuleEvaluation = {
  id: string
  title: string
  fired: boolean
  outcome: Outcome | null
  /** Why it did or did not fire, in one sentence, with the numbers in it. */
  because: string
  /** Skipped because an earlier rule already fired. */
  skipped: boolean
}

/** What would have to change to reach `execute`. */
export type Counterfactual = {
  id: string
  /** 'the delivery confirmation were under 7 days old (currently 41)' */
  label: string
  /** The outcome that perturbation produces. */
  wouldBe: Outcome
  flipsToExecute: boolean
}

export type Decision = {
  outcome: Outcome
  confidence: number
  support: number
  riskScore: number
  reversibility: number
  impactScale: number
  costOfBeingWrong: number
  costNormalized: number
  /** The unit `impactScale` and `costOfBeingWrong` are denominated in. */
  unit: string
  /** One plain-English sentence. The only string a non-technical reader needs. */
  summary: string
  evidence: Signal[]
  scoredSignals: ScoredSignal[]
  contradictions: Contradiction[]
  missingInformation: Gap[]
  rollbackPath: string | null
  /** e.g. 'R3_BLOCKING_GAP_USER_OBTAINABLE' */
  firedRule: string
  ruleTrace: RuleEvaluation[]
  counterfactual: Counterfactual[]
  policyVersion: string
  auditId: string
  decidedAt: string
  envelopeId: string
}

// ---------------------------------------------------------------------------
// Policy packs
// ---------------------------------------------------------------------------

/**
 * Everything a policy predicate is allowed to see. Handed to prohibitions,
 * temporal bars and the scale functions so they never reach into globals.
 */
export type PolicyContext = {
  envelope: ActionEnvelope
  signals: Signal[]
  /** Look up a signal by name. */
  get: (name: string) => Signal | undefined
  /** Numeric value of a signal, or `fallback` when absent or non-numeric. */
  num: (name: string, fallback?: number) => number
  /** Boolean value of a signal, or `fallback` when absent. */
  bool: (name: string, fallback?: boolean) => boolean
  /** Numeric field from `payload`, or `fallback`. */
  field: (path: string, fallback?: number) => number
}

/** Thresholds are plain data so `/api/replay` can mutate them and re-decide. */
export type Thresholds = {
  /** R5 floor on epistemic confidence. */
  minConfidence: number
  /** R5 floor on evidentiary support. */
  minSupport: number
  /** R5 ceiling on cost of being wrong, in the pack's unit. */
  tolerance: number
  /** R2 ceiling. At or above this cost, a human decides. */
  escalateCost: number
  /** 0..1. How hard a fully balanced contradiction bites into confidence. */
  contradictionPenalty: number
}

export type Prohibition = {
  id: string
  description: string
  test: (ctx: PolicyContext) => boolean
}

export type TemporalBar = {
  id: string
  description: string
  test: (ctx: PolicyContext) => boolean
  /** Human description of when the bar lifts, e.g. 'Monday 09:00 UTC'. */
  clearsAt: (ctx: PolicyContext) => string
}

export type PolicyPack = {
  domain: Domain
  /** Bumped on every threshold change. Stored on every audit record. */
  version: string
  /** The unit impact and cost are denominated in, e.g. 'USD'. */
  unit: string
  thresholds: Thresholds
  /**
   * Freshness half-life per signal name, in seconds. `'*'` is the default.
   * A signal with a long half-life is one whose truth changes slowly.
   */
  halfLifeSec: Record<string, number>
  /** Gaps in these fields are blocking. Everything else is noted, not blocking. */
  blockingFields: string[]
  /** Overrides for extractor-set weights, by signal name. */
  weights?: Record<string, number>
  prohibitions: Prohibition[]
  temporalBars: TemporalBar[]
  requiredAuthority: (ctx: PolicyContext, cost: number) => { level: number; because: string }
  impactScale: (ctx: PolicyContext) => number
  reversibility: (ctx: PolicyContext) => { value: number; because: string }
  rollbackPath: (ctx: PolicyContext) => string | null
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extractors are the only impure part of the pipeline. They may hit a
 * database, a clock or an LLM. The kernel never calls one — signals are
 * gathered first, then handed to a pure function. That split is what makes
 * replay and counterfactuals possible.
 */
export type Extractor = {
  name: string
  extract: (envelope: ActionEnvelope) => Promise<Signal[]> | Signal[]
}

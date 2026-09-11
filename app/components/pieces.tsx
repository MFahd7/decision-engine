'use client'

/** Presentational pieces for the console. No fetching, no state. */

import { age, pct, quantity } from '@/core/format'
import type {
  Contradiction,
  Counterfactual,
  Decision,
  Gap,
  Outcome,
  RuleEvaluation,
  ScoredSignal,
  Thresholds,
} from '@/core/types'
import type { NaiveVerdict } from '@/core/naive'

export function Pill({ outcome }: { outcome: Outcome }) {
  return (
    <span className="pill" data-outcome={outcome}>
      {outcome}
    </span>
  )
}

export function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------

export function VerdictCard({ decision }: { decision: Decision }) {
  return (
    <div className="verdict" data-outcome={decision.outcome}>
      <strong className="verdict-word">{decision.outcome}</strong>
      <span className="verdict-rule">{decision.firedRule}</span>
      <p className="verdict-summary">{decision.summary}</p>

      <div className="headline-cost">
        <span className="value">{quantity(decision.costOfBeingWrong, decision.unit)}</span>
        <span className="caption">
          expected regret if this decision is wrong, in {decision.unit}
        </span>
      </div>
      <div className="formula">
        {pct(decision.riskScore)} risk &times; {pct(1 - decision.reversibility)} unrecoverable &times;{' '}
        {quantity(decision.impactScale, decision.unit)} at stake &times; {pct(1 - decision.confidence)} unknown
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Meter({
  label,
  value,
  display,
  threshold,
  thresholdLabel,
  tone,
  note,
}: {
  label: string
  value: number
  display: string
  threshold?: number
  thresholdLabel?: string
  tone?: 'warn'
  note?: string
}) {
  const width = Math.max(0, Math.min(1, value)) * 100
  return (
    <div>
      <div className="meter-label">
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" data-tone={tone} style={{ width: `${width}%` }} />
        {threshold !== undefined && (
          <div
            className="meter-threshold"
            style={{ left: `${Math.max(0, Math.min(1, threshold)) * 100}%` }}
            title={thresholdLabel}
          />
        )}
      </div>
      {note && <div className="meter-note">{note}</div>}
    </div>
  )
}

export function Meters({ decision, thresholds }: { decision: Decision; thresholds: Thresholds }) {
  return (
    <div className="meters">
      <Meter
        label="Confidence — how well we know the situation"
        value={decision.confidence}
        display={pct(decision.confidence)}
        threshold={thresholds.minConfidence}
        thresholdLabel={`floor ${pct(thresholds.minConfidence)}`}
        tone={decision.confidence < thresholds.minConfidence ? 'warn' : undefined}
        note={`marker at the ${pct(thresholds.minConfidence)} floor`}
      />
      <Meter
        label="Support — how far the evidence argues for acting"
        value={decision.support}
        display={pct(decision.support)}
        threshold={thresholds.minSupport}
        thresholdLabel={`floor ${pct(thresholds.minSupport)}`}
        tone={decision.support < thresholds.minSupport ? 'warn' : undefined}
        note={`marker at the ${pct(thresholds.minSupport)} floor`}
      />
      <Meter
        label="Risk"
        value={decision.riskScore}
        display={pct(decision.riskScore)}
        tone={decision.riskScore > 0.5 ? 'warn' : undefined}
      />
      <Meter
        label="Reversibility"
        value={decision.reversibility}
        display={pct(decision.reversibility)}
        tone={decision.reversibility < 0.3 ? 'warn' : undefined}
        note={decision.rollbackPath ?? 'No rollback path exists. This cannot be undone.'}
      />
      <Meter
        label="Cost of being wrong, against the escalation ceiling"
        value={decision.costNormalized}
        display={quantity(decision.costOfBeingWrong, decision.unit)}
        threshold={Math.min(1, thresholds.tolerance / Math.max(1, thresholds.escalateCost))}
        thresholdLabel="tolerance"
        tone={decision.costNormalized > 0.8 ? 'warn' : undefined}
        note={`tolerance ${quantity(thresholds.tolerance, decision.unit)}, ceiling ${quantity(thresholds.escalateCost, decision.unit)}`}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

const SOURCE_TONE: Record<string, string> = {
  model: 'model',
  data: 'data',
  human: 'human',
  rule: '',
}

export function SignalList({ scored }: { scored: ScoredSignal[] }) {
  const ordered = [...scored].sort((a, b) => b.strength - a.strength)

  return (
    <div>
      {ordered.map((s) => (
        <div className="signal" key={s.signal.id}>
          <div className="signal-head">
            <span className="signal-name">{s.signal.name}</span>
            <Badge tone={SOURCE_TONE[s.signal.source]}>{s.signal.source}</Badge>
            <Badge>{s.signal.kind}</Badge>
            {s.stale && <Badge tone="stale">stale</Badge>}
          </div>
          <div className="signal-rationale">{s.signal.rationale}</div>
          <div className="signal-numbers">
            <span>weight {s.signal.weight.toFixed(2)}</span>
            <span>
              confidence {pct(s.signal.confidence)}
              {s.signal.kind !== 'missing' && s.effectiveConfidence < s.signal.confidence - 0.005 && (
                <>
                  {' → '}
                  <span className="decayed">{pct(s.effectiveConfidence)} after decay</span>
                </>
              )}
            </span>
            <span>observed {age(s.signal.freshnessSec)} ago</span>
            <span>half-life {s.halfLifeSec === 0 ? 'never decays' : age(s.halfLifeSec)}</span>
            {typeof s.signal.support === 'number' && <span>support {pct(s.signal.support)}</span>}
            <span>{s.signal.latencyMs}ms</span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ContradictionList({ contradictions }: { contradictions: Contradiction[] }) {
  if (contradictions.length === 0) {
    return <p className="note">No two sources disagree about the same fact here.</p>
  }
  return (
    <div>
      {contradictions.map((c) => (
        <div className="gap" key={c.proposition}>
          <div className="gap-question">{c.explanation}</div>
          <div className="gap-meta">
            proposition {c.proposition} · severity {pct(c.severity)} · confidence penalty {pct(c.impact)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

const OBTAINABLE_COPY: Record<string, string> = {
  user: 'a person can answer this → ask',
  system: 'only another system can produce this → defer',
  time: 'only time resolves this → defer',
}

export function GapList({ gaps }: { gaps: Gap[] }) {
  if (gaps.length === 0) {
    return <p className="note">Nothing is missing. Everything the policy asks for is on the record.</p>
  }
  return (
    <div>
      {gaps.map((gap) => (
        <div className="gap" key={gap.field}>
          <div className="gap-question">{gap.question}</div>
          <div className="gap-meta">
            {gap.field} · {gap.blocking ? 'blocking' : 'noted, not blocking'} ·{' '}
            {OBTAINABLE_COPY[gap.obtainableBy]}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function CounterfactualList({ decision }: { decision: Decision }) {
  if (decision.outcome === 'execute') {
    return <p className="no-counterfactual">This one executed, so there is nothing to ask about.</p>
  }

  if (decision.firedRule === 'R1_HARD_PROHIBITION') {
    return (
      <p className="no-counterfactual">
        Nothing. This is a refusal, and a refusal is not a threshold you can climb over. The engine
        deliberately offers no route around a prohibition, because publishing one would teach people
        to look for it.
      </p>
    )
  }

  if (decision.counterfactual.length === 0) {
    return <p className="no-counterfactual">No single change would move this verdict.</p>
  }

  const flips = decision.counterfactual.filter((c) => c.flipsToExecute)
  const rest = decision.counterfactual.filter((c) => !c.flipsToExecute)

  return (
    <div>
      {flips.length > 0 ? (
        <p className="note" style={{ marginTop: 0 }}>
          This would have executed if any one of these were true:
        </p>
      ) : (
        <p className="note" style={{ marginTop: 0 }}>
          No single change reaches <strong>execute</strong>. Changing one thing at a time gets you here:
        </p>
      )}
      {[...flips, ...rest].map((c: Counterfactual) => (
        <div className="counterfactual" key={c.id} data-flips={String(c.flipsToExecute)}>
          <span className="cf-marker">{c.flipsToExecute ? '→ execute' : `→ ${c.wouldBe}`}</span>
          <span className="cf-text">{c.label}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function RuleTraceList({ trace }: { trace: RuleEvaluation[] }) {
  return (
    <div>
      {trace.map((rule) => (
        <div className="rule" key={rule.id} data-fired={String(rule.fired)} data-skipped={String(rule.skipped)}>
          <div className="rule-id">{rule.id.split('_')[0]}</div>
          <div>
            <div className="rule-title">
              {rule.title}
              {rule.fired && rule.outcome && <Pill outcome={rule.outcome} />}
              {rule.skipped && <Badge>not reached</Badge>}
              {!rule.fired && !rule.skipped && <Badge>passed over</Badge>}
            </div>
            <div className="rule-because">{rule.because}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function NaiveCompare({ decision, naive }: { decision: Decision; naive: NaiveVerdict }) {
  const disagree = (naive.outcome === 'execute') !== (decision.outcome === 'execute')

  return (
    <div>
      <div className="compare">
        <div className="compare-cell">
          <h3>Naive baseline</h3>
          <div className="compare-verdict">{naive.outcome}</div>
          <p className="note" style={{ margin: '6px 0 0' }}>
            {naive.because}
          </p>
        </div>
        <div className="compare-cell">
          <h3>This engine</h3>
          <div className="compare-verdict">{decision.outcome}</div>
          <p className="note" style={{ margin: '6px 0 0' }}>
            Confidence {pct(decision.confidence)} after freshness decay and contradiction penalties,
            support {pct(decision.support)}, {quantity(decision.costOfBeingWrong, decision.unit)} of expected regret.
          </p>
        </div>
      </div>
      {disagree && (
        <p className="note" style={{ marginBottom: 0 }}>
          The two disagree on this scenario. The baseline leaned hardest on{' '}
          <code>{naive.dominantSignal}</code> and took its stated confidence at face value.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function AuditCard({
  decision,
  audit,
}: {
  decision: Decision
  audit: { seq: number; auditId: string; hash: string; prevHash: string }
}) {
  return (
    <dl className="kv">
      <dt>Audit id</dt>
      <dd>{audit.auditId}</dd>
      <dt>Sequence</dt>
      <dd>#{audit.seq}</dd>
      <dt>Previous hash</dt>
      <dd>{audit.prevHash.slice(0, 32)}…</dd>
      <dt>This record</dt>
      <dd>{audit.hash.slice(0, 32)}…</dd>
      <dt>Policy version</dt>
      <dd>{decision.policyVersion}</dd>
      <dt>Decided at</dt>
      <dd>{decision.decidedAt}</dd>
      <dt>Envelope</dt>
      <dd>{decision.envelopeId}</dd>
      <dt>Rule fired</dt>
      <dd>{decision.firedRule}</dd>
    </dl>
  )
}

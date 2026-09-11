'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { quantity } from '@/core/format'
import type { Thresholds } from '@/core/types'
import type { DomainSummary, ReplayResponse } from '@/app/api-types'

/**
 * The replay panel.
 *
 * Move a threshold and see what it would have done to every decision already
 * on the record. This is the feature that separates a demo from a system: it
 * only works because the kernel is pure and the audit trail stores the full
 * signal set, so the past can be re-judged without re-contacting a single
 * upstream service.
 */
export function ReplayPanel({ domain }: { domain: DomainSummary }) {
  const base = domain.thresholds
  const [draft, setDraft] = useState<Thresholds>(base)
  const [result, setResult] = useState<ReplayResponse | null>(null)
  const [busy, setBusy] = useState(false)

  // Reset whenever the operator switches domain — thresholds are per-pack.
  useEffect(() => {
    setDraft(base)
    setResult(null)
  }, [base])

  const changed = useMemo(
    () => (Object.keys(base) as Array<keyof Thresholds>).some((k) => draft[k] !== base[k]),
    [base, draft],
  )

  const run = useCallback(
    async (thresholds: Thresholds) => {
      setBusy(true)
      try {
        const response = await fetch('/api/replay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ domain: domain.domain, thresholds }),
        })
        setResult((await response.json()) as ReplayResponse)
      } finally {
        setBusy(false)
      }
    },
    [domain.domain],
  )

  // Debounced so dragging a slider does not fire a request per pixel.
  useEffect(() => {
    const handle = setTimeout(() => void run(draft), 220)
    return () => clearTimeout(handle)
  }, [draft, run])

  const money = (n: number) => quantity(n, domain.unit)

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Replay against a changed policy</h2>
        <span className="hint">re-judges the stored log · writes nothing</span>
      </div>
      <div className="panel-body">
        <Slider
          label="Escalation ceiling"
          value={draft.escalateCost}
          base={base.escalateCost}
          min={0}
          max={Math.round(base.escalateCost * 3)}
          step={Math.max(1, Math.round(base.escalateCost / 100))}
          format={money}
          onChange={(escalateCost) => setDraft((d) => ({ ...d, escalateCost }))}
        />
        <Slider
          label="Tolerance"
          value={draft.tolerance}
          base={base.tolerance}
          min={0}
          max={Math.round(base.escalateCost)}
          step={Math.max(1, Math.round(base.escalateCost / 200))}
          format={money}
          onChange={(tolerance) => setDraft((d) => ({ ...d, tolerance }))}
        />
        <Slider
          label="Confidence floor"
          value={draft.minConfidence}
          base={base.minConfidence}
          min={0}
          max={1}
          step={0.01}
          format={(n) => `${Math.round(n * 100)}%`}
          onChange={(minConfidence) => setDraft((d) => ({ ...d, minConfidence }))}
        />
        <Slider
          label="Support floor"
          value={draft.minSupport}
          base={base.minSupport}
          min={0}
          max={1}
          step={0.01}
          format={(n) => `${Math.round(n * 100)}%`}
          onChange={(minSupport) => setDraft((d) => ({ ...d, minSupport }))}
        />

        {changed && (
          <button
            type="button"
            className="badge"
            style={{ marginBottom: 12 }}
            onClick={() => setDraft(base)}
          >
            reset to {domain.policyVersion}
          </button>
        )}

        <div className="headline">
          {busy && !result ? 'Replaying…' : (result?.headline ?? 'Move a slider to see what would have changed.')}
        </div>

        {result && result.changed > 0 && (
          <div className="table-scroll">
            <table className="transition-table">
              <thead>
                <tr>
                  <th>Was</th>
                  <th>Would be</th>
                  <th>Decisions</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.transitions)
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, count]) => {
                    const [from, to] = key.split(' -> ')
                    return (
                      <tr key={key}>
                        <td>{from}</td>
                        <td>{to}</td>
                        <td>{count}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}

        {result && (
          <p className="note" style={{ marginBottom: 0, marginTop: 12 }}>
            Replayed {result.replayed} stored {domain.label.toLowerCase()} decisions from the audit chain.
            Every one was re-judged from its recorded signals — no upstream system was contacted, and
            nothing was written back.
          </p>
        )}
      </div>
    </section>
  )
}

function Slider({
  label,
  value,
  base,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  base: number
  min: number
  max: number
  step: number
  format: (n: number) => string
  onChange: (n: number) => void
}) {
  return (
    <div className="slider-row">
      <label htmlFor={`slider-${label}`}>
        <span>
          {label}
          {value !== base && <> · was {format(base)}</>}
        </span>
        <b>{format(value)}</b>
      </label>
      <input
        id={`slider-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Domain } from '@/core/types'
import type { DecideResponse, ScenariosResponse } from '@/app/api-types'
import {
  AuditCard,
  Badge,
  ContradictionList,
  CounterfactualList,
  GapList,
  Meters,
  NaiveCompare,
  Pill,
  RuleTraceList,
  SignalList,
  VerdictCard,
} from './pieces'
import { ReplayPanel } from './Replay'

export function Console() {
  const [catalogue, setCatalogue] = useState<ScenariosResponse | null>(null)
  const [domain, setDomain] = useState<Domain>('refunds')
  const [scenarioId, setScenarioId] = useState<string | null>(null)
  const [result, setResult] = useState<DecideResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/scenarios')
        const data = (await response.json()) as ScenariosResponse
        setCatalogue(data)

        // Deep link: #<scenario-id>. Lets a walkthrough or a bug report point
        // at one scenario rather than saying "click the third one down".
        const requested = decodeURIComponent(window.location.hash.replace(/^#/, ''))
        const match = data.domains.flatMap((d) =>
          d.scenarios.map((s) => ({ domain: d.domain, id: s.id })),
        ).find((s) => s.id === requested)

        if (match) {
          setDomain(match.domain)
          setScenarioId(match.id)
        } else {
          setScenarioId(data.domains[0]?.scenarios[0]?.id ?? null)
        }
      } catch {
        setError('Could not load scenarios. Is the dev server running?')
      }
    })()
  }, [])

  useEffect(() => {
    if (scenarioId) window.history.replaceState(null, '', `#${scenarioId}`)
  }, [scenarioId])

  const activeDomain = useMemo(
    () => catalogue?.domains.find((d) => d.domain === domain) ?? null,
    [catalogue, domain],
  )
  const activeScenario = useMemo(
    () => activeDomain?.scenarios.find((s) => s.id === scenarioId) ?? null,
    [activeDomain, scenarioId],
  )

  useEffect(() => {
    if (!scenarioId) return
    let cancelled = false
    setPending(true)
    void (async () => {
      try {
        const response = await fetch('/api/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fixtureId: scenarioId }),
        })
        const data = (await response.json()) as DecideResponse
        if (!cancelled) {
          setResult(data)
          setError(null)
        }
      } catch {
        if (!cancelled) setError('The decision request failed.')
      } finally {
        if (!cancelled) setPending(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scenarioId])

  function selectDomain(next: Domain) {
    setDomain(next)
    const first = catalogue?.domains.find((d) => d.domain === next)?.scenarios[0]
    if (first) setScenarioId(first.id)
  }

  if (error && !catalogue) {
    return <div className="loading">{error}</div>
  }
  if (!catalogue || !activeDomain) {
    return <div className="loading">Loading the policy packs…</div>
  }

  return (
    <>
      <header className="masthead">
        <div>
          <h1>The Decision Engine</h1>
          <p>
            An LLM never makes the call. A deterministic kernel does, on an ordered ladder of six
            rules, using signals that each carry their own confidence and their own age.
          </p>
        </div>
        <div className="masthead-status">
          <Badge tone={catalogue.llm.live ? 'model' : 'ok'}>
            {catalogue.llm.live ? 'language model signal live' : 'no API key · deterministic stub'}
          </Badge>
          <Badge>{activeDomain.policyVersion}</Badge>
        </div>
      </header>

      <div className="columns">
        {/* ---------------- left: domains and scenarios ---------------- */}
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Domain</h2>
              <span className="hint">one kernel, three packs</span>
            </div>
            <div className="domain-tabs" role="tablist">
              {catalogue.domains.map((d) => (
                <button
                  key={d.domain}
                  role="tab"
                  className="domain-tab"
                  aria-selected={d.domain === domain}
                  onClick={() => selectDomain(d.domain)}
                >
                  <strong>{d.label}</strong>
                  <span>{d.blurb}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Scenarios</h2>
              <span className="hint">{activeDomain.scenarios.length}</span>
            </div>
            <div className="scenario-list">
              {activeDomain.scenarios.map((s) => (
                <button
                  key={s.id}
                  className="scenario"
                  aria-current={s.id === scenarioId}
                  onClick={() => setScenarioId(s.id)}
                >
                  <Pill outcome={s.expect} />
                  <span className="scenario-title">{s.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>This pack refuses outright</h2>
            </div>
            <div className="panel-body">
              {activeDomain.prohibitions.map((p) => (
                <div className="gap" key={p.id}>
                  <div className="gap-question">
                    {p.description.charAt(0).toUpperCase()}
                    {p.description.slice(1)}
                  </div>
                  <div className="gap-meta">{p.id}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ---------------- centre: the verdict ---------------- */}
        <div className="stack">
          {activeScenario && (
            <section className="panel">
              <div className="panel-head">
                <h2>{activeScenario.title}</h2>
                <span className="hint">
                  {activeScenario.actor.role} · authority {activeScenario.actor.authorityLevel}
                </span>
              </div>
              <div className="panel-body">
                <p className="scenario-note" style={{ margin: 0 }}>
                  {activeScenario.note}
                </p>
              </div>
            </section>
          )}

          {result ? (
            <>
              <VerdictCard decision={result.decision} />

              <section className="panel">
                <div className="panel-head">
                  <h2>Why not execute?</h2>
                  <span className="hint">one change at a time, kernel re-run for each</span>
                </div>
                <div className="panel-body">
                  <CounterfactualList decision={result.decision} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Missing information</h2>
                  <span className="hint">who can close it decides ask vs defer</span>
                </div>
                <div className="panel-body">
                  <GapList gaps={result.decision.missingInformation} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>The ladder</h2>
                  <span className="hint">every rule, fired or not</span>
                </div>
                <div className="panel-body">
                  <RuleTraceList trace={result.decision.ruleTrace} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Against a naive reading of the same evidence</h2>
                  <span className="hint">core/naive.ts</span>
                </div>
                <div className="panel-body">
                  <NaiveCompare decision={result.decision} naive={result.naive} />
                </div>
              </section>
            </>
          ) : (
            <div className="loading">{pending ? 'Deciding…' : 'Pick a scenario.'}</div>
          )}
        </div>

        {/* ---------------- right: the working ---------------- */}
        <div className="stack">
          {result && (
            <>
              <section className="panel">
                <div className="panel-head">
                  <h2>Measures</h2>
                  <span className="hint">markers show the pack&rsquo;s floors</span>
                </div>
                <div className="panel-body">
                  <Meters decision={result.decision} thresholds={result.policy.thresholds} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Sources that disagree</h2>
                </div>
                <div className="panel-body">
                  <ContradictionList contradictions={result.decision.contradictions} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Evidence</h2>
                  <span className="hint">{result.decision.scoredSignals.length} signals</span>
                </div>
                <div className="panel-body tight" style={{ paddingInline: 14 }}>
                  <SignalList scored={result.decision.scoredSignals} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Audit record</h2>
                  <span className="hint">hash-chained</span>
                </div>
                <div className="panel-body">
                  <AuditCard decision={result.decision} audit={result.audit} />
                  <details style={{ marginTop: 12 }}>
                    <summary>Raw decision JSON</summary>
                    <pre className="json">{JSON.stringify(result.decision, null, 2)}</pre>
                  </details>
                </div>
              </section>
            </>
          )}

          <ReplayPanel domain={activeDomain} />
        </div>
      </div>

      <footer className="footer">
        <p style={{ margin: 0 }}>{catalogue.llm.note}</p>
        <p style={{ marginBottom: 0 }}>
          Every scenario pins its own clock, so these verdicts are reproducible forever. The audit log
          on this instance is seeded on first request by running a generated corpus through the real
          pipeline — every record in it is a decision this engine actually made.
        </p>
      </footer>
    </>
  )
}

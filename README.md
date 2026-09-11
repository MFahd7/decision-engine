# The Decision Engine

A decision layer that judges whether to act on an instruction, and returns one of five answers:

**execute · ask · defer · escalate · refuse**

It works across three domains — refund approval, production deploys, content moderation — using one
kernel and three policy packs. Every decision carries the evidence it used, the age and confidence of
each piece, the rules it was tested against, what it would have taken to reach a different answer, and
a hash-chained audit record.

Built for the [DOO Builders League Decision Engine challenge](https://build.doo.ooo/challenges/decision-engine).

---

## The one rule this is built around

> **A language model never makes the decision. A deterministic kernel does.**

A model is one *signal extractor* among many. It produces a Signal exactly like a database row or a
business rule does, carrying a self-reported confidence that the kernel is free to discount — and
does, capping it at 0.75 before it is ever weighed. Turn the model off and the app still runs, still
demos every feature, and reaches the same verdicts.

That is not a hedge. It is the architectural claim, and the rest of the repository is the evidence
for it.

---

## Run it

Requires Node 20.9 or newer. No API key, no database, no accounts.

```bash
git clone https://github.com/MFahd7/decision-engine.git
cd decision-engine
npm install
npm run dev          # http://localhost:3000
```

That is the whole setup. The console loads with 35 hand-written scenarios across three domains, and
the audit log seeds itself on the first request by running a generated corpus through the real
pipeline.

```bash
npm test             # 67 tests, including both failure cases
npm run typecheck
npm run build
```

**Optional.** Copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY` to swap the
language-model signal from a deterministic stub to a live call. Every verdict in this README was
produced with **no key set**.

---

## The five verdicts

The vocabulary is the point. Most permission systems have two answers, so everything that is not
"yes" has to be squeezed into "no", and people learn to route around the "no".

| Verdict | Means | Typical trigger |
|---|---|---|
| `execute` | Act now. | Confidence, evidentiary support and cost of being wrong all inside policy. |
| `ask` | A person can close this gap in one sentence. | A damage claim with no photo. A tier-2 deploy with no rollback plan. |
| `defer` | Nothing is missing and nobody needs to approve. The answer is "not now". | Deploy freeze. On-call away until Monday. The original charge has not settled. |
| `escalate` | Someone with more authority decides. | Cost above the ceiling, or authority below the requirement, or nothing ever earned a green light. |
| `refuse` | Not a threshold. More evidence changes nothing. | Content under legal hold. A sanctions match. A credential in the diff. |

The difference between `ask` and `defer` is *who can close the gap* — a field the extractor labels
`user`, `system` or `time`. Nothing else in the system needs to know what the gap means.

---

## Cost of being wrong

The challenge names this explicitly, so it is a computed number on screen, in the policy pack's own
unit, not a vibe:

```
costOfBeingWrong = riskScore × (1 − reversibility) × impactScale × (1 − confidence)
```

Read left to right: how likely this goes wrong, how stuck we are if it does, how big the blast is,
and how much of that is genuinely unknown to us.

The units are real. Refunds are denominated in dollars, deploys in users at risk, moderation in
people reached. So the console says **"$63 of expected regret"** or **"4,548 people reached"**, which
is a quantity a policy owner can argue with.

`reversibility` is where most of the interesting behaviour lives, because it is a property of the
*rollout*, not the action:

| | |
|---|---|
| Store credit | 0.95 — revoked from the account directly |
| Card reversal | 0.70 — clawable through the processor for 60 days |
| Instant bank payout | 0.15 — gone on send |
| Canary deploy with a rollback plan | 0.90 |
| Deploy behind a migration with no down-path | 0.05 |
| Permanent content deletion | 0.00 |

The same $900 refund is a routine approval on store credit and an escalation on an instant payout.
Nothing about the claim changed.

---

## The kernel: six rules, in order

Deterministic, domain-free, about 150 lines in [`core/kernel.ts`](core/kernel.ts). Every rule is
recorded in the trace whether it fires or not, so the console shows the road not taken.

| | Rule | Fires when | Verdict |
|---|---|---|---|
| R1 | Hard prohibition | On the pack's forbidden list, or the actor holds no authority at all | `refuse` |
| R2 | Authority ceiling | Cost at or above the ceiling, or actor below the required level | `escalate` |
| R3 | Blocking gap a person can close | A blocking gap obtainable by `user` | `ask` |
| R4 | Blocking gap only time can close, or a temporal bar | Obtainable by `system`/`time`, or a freeze/cooling-off window | `defer` |
| R5 | Green light | Confidence, support and cost all inside policy | `execute` |
| R6 | Fallback | Anything else | `escalate` |

**R6 is the safety argument.** There is no path that reaches `execute` by running out of rules.
Absence of a reason to stop is not a reason to go.

---

## Two numbers, not one

Most scoring engines collapse "how sure are we" and "does this look justified" into a single
confidence number. Splitting them is what stops a request with crisp, fresh, unanimous evidence that
it is *unjustified* from sailing through a confidence check:

- **confidence** — how well we know the situation. A weighted mean of source confidence, decayed by
  age, penalised for contradiction.
- **support** — how far what we know argues for acting. A strength-weighted vote across evidence.

R5 requires both. Note what the engine does *not* do when support is confidently low: it escalates,
never refuses. "The evidence looks bad" is a person's call. Refusal is reserved for prohibitions.

---

## Freshness decay

Every signal carries `freshnessSec` — the age of the underlying *observation*, not of the lookup —
and every policy pack sets a half-life per signal type.

```
effectiveConfidence = confidence × 2^(−freshnessSec / halfLifeSec)
```

A carrier scan describing a parcel in motion has a two-day half-life. A customer's twelve-month
chargeback history has a ninety-day one. Arithmetic never decays at all. These numbers are the most
opinionated thing in the repository and they encode real operational knowledge.

This single mechanism is what catches failure test A.

---

Every scenario is deep-linkable. `#refund-stale-warehouse-receipt` on the end of the URL opens the
failure-A case directly.

---

## What to look at first

1. **`refunds → "Warehouse says the return arrived. Six weeks ago."`**
   Our strongest evidence is a warehouse receipt scan at 95% source confidence. It is 41 days old,
   and a carrier scan from six hours ago says the parcel is still moving. The panel at the bottom
   shows a naive reading of the same evidence paying out $1,240. Ours asks for the tracking number.

2. **`deploy → "Everything is green. It is Friday evening and nobody is on call."`**
   Nothing is wrong. Nothing is missing that a person could supply. Nobody needs to approve
   anything. `defer`, until Monday 09:00 UTC. A yes/no system has to answer this wrongly in one
   direction or the other.

3. **The "why not execute?" panel on any non-execute verdict.**
   The kernel is pure, so asking "what would have had to be different?" is just running it again
   against a perturbed input, one change at a time. On the tier-2 deploy it reads: *this would have
   executed if the rollback plan were supplied*. On a refusal it deliberately offers nothing —
   publishing a route around a prohibition teaches people to look for one.

4. **The replay slider, bottom right.**
   Drag the confidence floor and watch: *"Moving the confidence floor from 72% to 85% would have
   changed 14 of the last 140 decisions: 14 execute became escalate."* Every one of those was
   re-judged from its stored signals. No upstream system was contacted and nothing was written back.

---

## Failure thinking

Both are runnable specs, not prose.

**A — confidently wrong evidence. Caught.** [`tests/failure-a.spec.ts`](tests/failure-a.spec.ts)
The stale warehouse scan above. The spec pins all three mechanisms: decay strips the 41-day-old scan
to under 3% of its stated confidence; the two sources are recorded as *contradicting* rather than
averaged; and the engine asks the one question that would actually settle it. It also pins that the
naive baseline in [`core/naive.ts`](core/naive.ts) executes on the same evidence.

**B — threshold gaming. Half fixed, and honest about which half.** [`tests/failure-b.spec.ts`](tests/failure-b.spec.ts)
Authority steps up at $500. Eleven $450 refunds is $4,950 that nobody with the authority to approve
ever approved. The mitigation widens the unit of judgement from the request to the rolling 24-hour
(actor, customer) total, and the spec proves it catches the impatient attacker.

Then it proves the patient one still gets through. The same eleven refunds spread over five weeks are
invisible to a 24-hour window, and the engine pays out. The spec also shows why lengthening the
window is not the answer: tripling it to three days recovers $450 of the $4,500. Whatever it is set
to, the counter is to wait slightly longer, while every extra day drags legitimate high-volume agents
over the line. The real fix is identity resolution across accounts and payment instruments — a
different system, holding different data, which this engine does not own.

---

## Audit trail

Append-only and hash-chained. Each record stores the previous record's SHA-256, so editing a decision
from three months ago requires rewriting every record since, and verification names the record that
broke. [`tests/audit.spec.ts`](tests/audit.spec.ts) proves detection for both an edited record and
one quietly deleted from the middle.

Each record holds the full envelope, every signal with its source, confidence, freshness and latency,
the policy version, the complete rule trace, the verdict, and an optional realised outcome recorded
later. Recording a realised outcome reseals the chain from that point rather than editing in place,
so amendments are visible.

Storage is an interface with two implementations. Swapping in Postgres means writing one class.

**Stated plainly:** a single-writer hash chain detects tampering by anyone who cannot rewrite the
whole file. It does not defend against an attacker with write access who recomputes the chain. Real
tamper-evidence needs the head published somewhere the writer does not control.

---

## API

```
POST /api/decide              { fixtureId } or { envelope }  → decision, signals, naive comparison, audit record
GET  /api/decisions           ?domain=&outcome=&limit=&offset=  → audit list + chain verification
GET  /api/decisions/:auditId  → full record + live hash recomputation
POST /api/decisions/:auditId  { ok, note } → record how it actually turned out
POST /api/replay              { domain, thresholds } → what a policy change would have done
GET  /api/scenarios           → domains, policy packs, shipped scenarios
```

```bash
curl -s localhost:3000/api/decide \
  -H 'content-type: application/json' \
  -d '{"fixtureId":"refund-stale-warehouse-receipt"}' | jq '.decision.outcome, .naive.outcome'
```

---

## Layout

```
core/          types · kernel · scoring · naive baseline    (no domain knowledge whatsoever)
policies/      refunds · deploy · moderation                (thresholds, prohibitions, half-lives)
signals/       extractors per domain + the optional LLM one (the only impure code)
audit/         hash chain · store · replay · corpus seeder
fixtures/      35 hand-written scenarios, all five verdicts per domain
engine/        the composition root — the only file that knows all three domains exist
app/           API routes and the console
tests/         golden cases, kernel invariants, both failure tests, the audit chain
```

The pipeline splits in two, and that split is what makes everything else possible:

```
gather(envelope) → Signal[]     impure: clocks, databases, a language model
decide(...)      → Decision     pure: same inputs, same verdict, forever
```

Replay re-runs only the second half.

---

## What this does not do

Written out at length in [ARCHITECTURE.md](ARCHITECTURE.md#what-we-did-not-fix). In short:

- **Threshold gaming is only half solved**, as above.
- **The hash chain is single-writer**, as above.
- **Half-lives and weights are hand-set.** They encode plausible operational judgement, not measured
  error rates. The `realisedOutcome` field is the hook for calibrating them against reality; nothing
  currently does.
- **The hosted demo's audit log is per-instance.** Vercel's filesystem is read-only, so the deployed
  build uses the memory store and reseeds on cold start. Locally it writes JSONL to disk.
- **No identity resolution, no rate limiting, no authentication.** This is a decision layer, not a
  platform. It assumes something upstream has established who the actor is.
- **The engine is deliberately conservative.** In the seeded corpus most decisions escalate. That is
  the design, not a tuning failure: moderation in particular is built so that a classifier can never
  clear the confidence floor on its own.

---

## Notes on how this was built

**AI tools.** Written with Claude Code (Opus 5). The plan came from a Claude conversation; the
implementation, the fixture data, the calibration and the tests were built and iterated in the
terminal. Two design errors were caught by running the tests rather than by reading the code: the
carrier scan was being given full weight on duplicate-charge claims where it is irrelevant, and the
counterfactual engine was closing gaps without updating the evidence those gaps contradicted, which
made every "why not execute?" answer quietly pessimistic.

**Key decisions.**
- Splitting confidence from support, which the original plan did not have. Without it R5 would clear
  a request the evidence confidently argued against.
- Making contradiction detection generic via an `asserts: { proposition, polarity }` field on the
  signal, so the kernel notices two sources disagreeing without knowing what a warehouse is.
- Letting the *policy pack* decide which gaps block, rather than the extractor. That is why replaying
  under a stricter pack can turn a past `execute` into an `ask` without re-running extraction.
- Capping model-reported confidence at 0.75 in one visible constant, and setting moderation's
  confidence floor at 0.75 so no classifier score alone can ever clear it.

**Scope limits.** Three domains, not four. No persistence beyond a file. No authentication. The
language-model extractor contributes exactly one signal per decision by design, and the whole system
is built to work without it.

---

[ARCHITECTURE.md](ARCHITECTURE.md) · [THESIS.md](THESIS.md)

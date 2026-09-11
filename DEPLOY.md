# Deploying

The live demo URL is a mandatory submission item, so this is the part not to leave until last.

## 1. Push to GitHub

The repository is committed locally and the empty GitHub repository already exists at
https://github.com/MFahd7/decision-engine. The remote is configured, with the username in the URL so
the credential helper asks for **MFahd7** rather than reusing whatever account is already signed in
on the machine.

**If Mohammed is at the machine this was built on**, that is the whole job:

```bash
git push -u origin main
```

A browser window opens; sign in as MFahd7. The existing stored credential for any other account is
left alone.

**If he is on a different machine**, `decision-engine.bundle` in the Downloads folder carries the
full history in a single 125 KB file. Send him that, then:

```bash
git clone decision-engine.bundle decision-engine
cd decision-engine
git remote set-url origin https://MFahd7@github.com/MFahd7/decision-engine.git
git push -u origin main
```

**Commit identity.** This repository sets `user.name` and `user.email` locally only; no global git
config is touched. The author address is GitHub's noreply address for the MFahd7 account
(`53822500+MFahd7@users.noreply.github.com`), so the commit links to the account without publishing a
private address. Whoever runs the push is recorded separately from who authored the commit, so
pushing from another account does not change the attribution.

## 2. Deploy on Vercel

Zero configuration. Import the repository at [vercel.com/new](https://vercel.com/new) and accept the
detected Next.js defaults.

**Remove the environment variables Vercel offers to add.** The import screen scrapes every key
out of `.env.example` and pre-fills all three with blank values, under an "Environment Variables,
3 Detected" panel. Click the minus button beside each one. The app is built to run with none set,
which is the point: a judge cloning at midnight with no API key gets a fully working demo, and so
does the hosted build.

Leaving them in as blanks is harmless as of this commit, because the code now treats an empty value
as unset and falls back to memory if the log cannot be written. Removing them is still the cleaner
state, and it is what the README describes.

Two things happen automatically on Vercel:

- `AUDIT_STORE` resolves to the memory store, because the filesystem is read-only there. The audit
  log is per-instance and reseeds on cold start. This is stated in the README rather than hidden.
- The language-model signal falls back to its deterministic stub, because `ANTHROPIC_API_KEY` is
  unset. Every verdict is identical either way.

If you *do* want the live model signal on the hosted demo, add `ANTHROPIC_API_KEY` in the Vercel
project settings. Nothing else changes, and the console will say so in its header badge.

**Deployment Protection must be off.** A new project can have Vercel Authentication enabled, which
redirects every visitor to a Vercel login page. The brief disqualifies a non-functional demo, so
check **Settings → Deployment Protection → Vercel Authentication → Disabled** and confirm the URL
loads in a private window.

## 3. Before you submit, rehearse the clean clone

The most common way to lose this challenge is a repository that does not run. Do it in a fresh
folder, not the one you built in:

```bash
cd $(mktemp -d)              # PowerShell: cd (New-Item -ItemType Directory -Path ([IO.Path]::GetTempPath() + [Guid]::NewGuid()))
git clone https://github.com/MFahd7/decision-engine.git
cd decision-engine
npm install
npm test                     # expect 71 passing
npm run build
npm run dev
```

Then open the app and click through one scenario per domain.

## 4. Submission checklist

| Item | Where |
|---|---|
| Public repository, runnable from a clean clone | GitHub, step 1 |
| Live demo URL | https://decision-engine-mofahds-projects.vercel.app — verified publicly reachable |
| README with setup | [README.md](README.md) |
| `.env.example` | [.env.example](.env.example) |
| Architecture diagram / one-pager | [ARCHITECTURE.md](ARCHITECTURE.md) — two Mermaid diagrams, rendered by GitHub |
| Five outcomes | Every domain produces all five; asserted in `tests/kernel.spec.ts` |
| Audit trail | `audit/`, and `GET /api/decisions` |
| Three example domains | refunds · deploy · moderation |
| Intentional failure test case | `tests/failure-a.spec.ts` and `tests/failure-b.spec.ts` |
| Two-year thesis, ≤300 words | [THESIS.md](THESIS.md) — 290 words |
| Notes on AI tools, key decisions, scope limits | README, final section |
| 90-second video | See below |

## 5. The 90-second video

Ninety seconds is four beats. Do not explain the architecture; show the behaviour.

1. **0:00–0:20 — the claim.** Open on the refunds tab. *"This decides whether an AI agent should act.
   Five answers, not two. And a language model never makes the call — it's one signal among many, and
   the kernel discounts its confidence."*

2. **0:20–0:45 — failure A.** Click *"Warehouse says the return arrived. Six weeks ago."*
   *"Our strongest evidence says 95% confident. It's 41 days old, and a carrier scan from this
   morning disagrees."* Point at the naive comparison at the bottom: it pays out $1,240. Ours asks
   for the tracking number.

3. **0:45–1:10 — defer, and the counterfactual.** Switch to deploy, click the Friday scenario.
   *"Nothing is wrong. Nothing is missing. Nobody needs to approve it. The answer is 'not now' —
   which no yes/no system can say."* Then the tier-2 deploy: *"and this one tells you exactly what
   would have made it a yes."*

4. **1:10–1:30 — replay.** Drag the confidence floor. Read the sentence aloud:
   *"Moving the confidence floor to 85% would have changed 14 of the last 140 decisions."*
   Close on: *"Every one of those was re-judged from its stored signals. That's what the audit trail
   is for."*

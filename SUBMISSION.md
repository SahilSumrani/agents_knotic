# Submission — Release Sentinel

Build with Swytchcode Buildathon, organised with **KNOTiC**
**Track 3: AI DevOps & Deployment Agent**

## The pitch

Release Sentinel is an autonomous release-gating agent that owns a deployment end
to end, including the part where it goes wrong. It reads commits, diffs, CI check
runs and associated PRs from GitHub, extracts deterministic risk features, asks an
LLM for a structured verdict (`SHIP`, `SHIP_WITH_TICKET`, `HOLD`) that is floored
by a heuristic so it cannot be talked into shipping over a failing check, and then
either files a blocking Jira ticket or triggers a real git-linked Netlify build.
It then verifies its own work twice: it polls the deploy to a terminal state, and
— because Netlify never publishes a build that exits non-zero, so deploy state
only ever catches failures users never see — it fetches the published page and
asserts the page is actually being served. If the release is bad by either
measure, it rolls production back to a deploy that was *not* built from the failed
commit, re-fetches production to prove the good page is back, files a Jira
incident, and appends a postmortem to Notion. Every one of those actions runs
through a Swytchcode canonical ID: four integrations, zero vendor SDKs, zero
hand-written API clients.

## Problem statement

Continuous deployment pipelines are good at telling you a build failed and bad at
telling you a release is broken. The dangerous release is the one that builds
green and serves a broken page — CI is happy, the deploy dashboard is green, and
the only detector is a user. Meanwhile the decision of whether a change is safe to
ship at all is still a human reading a diff at 6pm. Release Sentinel automates
both halves: the judgement before the deploy, and the verification and recovery
after it.

## Links

| What | URL |
| --- | --- |
| Repository (the repo the agent guards) | https://github.com/SahilSumrani/agents_knotic |
| Live site it deploys and rolls back | https://agentneww.netlify.app |
| Dashboard | `npm run dev` → http://localhost:3000 |

## Swytchcode canonical IDs

From `swytchcode list tooling` — 27 methods across 4 integrations. Sixteen are on
the agent's execution path; the rest were enabled while exploring the bundles and
are only used for discovery.

**GitHub** (`GitHub.github@1.1.4`)

| Canonical ID | Role |
| --- | --- |
| `github.commit.get.1` | List commits on the release branch since the lookback window |
| `github.commit.get.2` | Per-commit diff stats and changed files |
| `github.commit.checkRuns.get` | CI check runs for the candidate commit |
| `github.commit.status.get` | Combined commit status |
| `github.commit.pulls.get` | PRs associated with the commit |
| `github.repo.list` | discovery only |
| `github.repo.get.4` | discovery only |
| `github.user.list.1` | discovery only |

**Netlify** (`Netlify.netlify@v1`)

| Canonical ID | Role |
| --- | --- |
| `netlify.site.get` | Resolve site name and public URL |
| `netlify.build.create` | Trigger a real git-linked production build |
| `netlify.deploy.get.1` | Poll a specific deploy to a terminal state |
| `netlify.deploy.get` | List deploys to choose a rollback target |
| `netlify.cancel.create` | Cancel a stalled deploy |
| `netlify.deploy.restore.create` | **The rollback** — republish a known good deploy |
| `netlify.deploy.create` | discovery only (digest deploy API, deliberately unused) |
| `netlify.deploy.get.2` | discovery only |

**Jira** (`Jira.jira@v1`)

| Canonical ID | Role |
| --- | --- |
| `jira.api.issue.create` | File the blocking review ticket and the incident |
| `jira.api.issueLink.create` | Link the incident back to the review ticket |
| `jira.api.comment.create` | Annotate an existing issue |
| `jira.api.project.list7` | discovery only (project key lookup) |
| `jira.api.myself.list` | discovery only (credential check) |

**Notion** (`Notion.notion@2.0.0`)

| Canonical ID | Role |
| --- | --- |
| `notion.markdown.update` | Append the release or incident report as Markdown |
| `notion.me.list` | Verify the Notion token during preflight |
| `notion.markdown.get` | discovery only |
| `notion.property.get` | discovery only |
| `notion.comment.list` | discovery only |
| `notion.comment.create` | discovery only — was a report fallback, removed on purpose (see below) |

## Pre-demo checklist

- [ ] `swytchcode whoami` returns a live session — re-run `swytchcode login` if it is stale
- [ ] `MAX_COMMITS=1` in `.env`, so only the head commit is assessed
- [ ] Server restarted **after** any `.env` edit; config is read at startup
- [ ] `npm run preflight` has been run at least once on this machine (it patches the Jira base URL into the Swytchcode manifest)
- [ ] Netlify token is **full access**, not read-only
- [ ] The Notion report page is connected to the integration
- [ ] The guarded repo is green and the site currently serves the health marker
- [ ] **At least two good deploys in the Netlify history**, so there is something to roll back to
- [ ] `npm run selftest` passes 6/6 — the offline fallback if the network dies
- [ ] Dashboard open at http://localhost:3000, Jira project and Notion page open in tabs

## 3-minute demo script

**0:00–0:20 — Frame it.**
"CI tells you a build failed. It doesn't tell you a release is broken. The
dangerous deploy is the one that builds green and serves a broken page — and
that's what this agent catches." Show the idle dashboard; point at the Swytchcode
call table and say every action goes through a canonical ID, no SDKs.

**0:20–1:00 — The safe ship.**
Trigger a run on a small, safe commit. Narrate as the stages light up: ingest
pulls the commit, diff and CI signals; assess turns them into features and the
model returns a score with a written rationale; act triggers a real Netlify build.
Read one line of the rationale out loud — the agent explains *why*, it does not
just emit a verdict. Deploy goes `ready`, health check passes, Notion report is
written.

**1:00–1:20 — The gate.**
Show a held run: Jira ticket `KAN-6`, "Review large diff and pending CI before
deployment", labelled `release-sentinel` and `deploy-blocked`, carrying the full
rationale, concerns and commit list. "The deploy step never ran. And the model
can't override this — a failing check forces HOLD regardless of what it says."

**1:20–2:30 — The self-heal. This is the demo.**
Push the one-line change to `site/index.html` that replaces the headline. "The
build will succeed. Nothing is broken about this code — it just doesn't serve what
it's supposed to." Run it. Deploy reaches `ready`. Then say nothing and let the
health check fail four times on screen, and let the agent roll production back,
re-check the live site and log `production verified healthy after rollback`. Open
the site in a browser: it is serving the good page again. Open Jira incident
`KAN-3`.

**2:30–3:00 — The honest part.**
"Rehearsing that found a real bug. It restored the newest `ready` deploy — but a
broken page is also `ready`, and Netlify's own CD had built the same bad commit,
so it republished the same broken site and reported success. Now it skips deploys
built from the failed commit and re-checks production after restoring." Close on
`npm run selftest`: 6/6 scenarios including both rollback branches, no credentials,
no network.

## Talking points for judges

- **Real self-healing, verified against production.** Not "it would roll back" —
  run `c6348cc3` published a deploy, failed the health check 4/4, restored deploy
  `6a7829de02074530ef5415cc`, re-fetched the live site to confirm the good page
  was back, and filed incident `KAN-3`. The live URL was independently checked.
- **A green build is not a working site.** Netlify never publishes a build that
  exits non-zero, so polling deploy state only detects the failures users never
  see. The agent fetches the deployed page and requires a 2xx containing a known
  marker, retrying for CDN propagation. This is the design decision the whole
  project turns on.
- **Zero vendor SDKs, zero hand-written HTTP.** Four integrations, 16 canonical
  IDs on the hot path, one wrapper (`src/swytch.ts`) that owns retries, error
  classification and a per-call audit trail. The dashboard shows every
  `swytchcode exec` with its latency, live.
- **Bugs found by rehearsal, and fixed honestly.** The rollback target bug above;
  GitHub reporting `pending` for a repo with no CI at all, which made the model
  gate a one-line HTML change at 70/100 until `combinedCheckState: "none"` was
  introduced; and a Notion fallback that masked the real error with a misleading
  one and was deleted rather than patched.
- **The model decides one thing, the state machine decides the rest.** No
  tool-choosing loop has write access to production. Every edge in the pipeline is
  written down, which is why the branches can be tested.
- **Deterministic offline test suite.** Rollback is the branch you cannot rehearse
  safely against a live site, so it is the one most likely to be broken on stage.
  `npm run selftest` drives 6/6 scenarios — including both rollback flavours —
  against a stubbed Swytchcode client in seconds, with no credentials and no
  network. `npm run typecheck` is clean.
- **A real engineering constraint solved.** `@swytchcode/runtime`'s `exec()` is
  `spawnSync`-based and blocks the event loop, which would freeze the live
  dashboard, so the pipeline runs in a worker thread and streams progress over SSE.

## LinkedIn post

> A green build is not a working site.
>
> That gap is most of what I built this weekend. Release Sentinel is an autonomous
> release agent: it reads commits, diffs and CI signals from GitHub, scores how
> risky shipping is, and either files a Jira ticket and blocks the release, or
> triggers a real Netlify build. Then it does the part deploy dashboards skip — it
> fetches the published page and asserts production is serving what it should.
> Netlify never publishes a build that exits non-zero, so polling deploy state only
> ever catches the failures users never see.
>
> Rehearsing the rollback found a real bug. The agent restored "the newest ready
> deploy" — but a broken page is also ready, and Netlify's own git CD had already
> built the same bad commit, so it republished the broken site and reported
> success. The fix: skip any deploy built from the failed commit, then re-check
> production after restoring and walk further back until the good page is actually
> being served.
>
> One live run: risk 10, SHIP, deploy published, health check failed 4/4, rolled
> back, production verified healthy, Jira incident filed. Eleven calls, every one
> through a Swytchcode canonical ID — four integrations, zero vendor SDKs.
>
> Thanks to Swytchcode and KNOTiC for a problem statement with real teeth.
>
> #Swytchcode #KNOTiC #AIAgents #DevOps #Buildathon

Replace the plain-text mentions with real LinkedIn company tags before posting,
and attach a screen recording of the rollback — that is the moment that lands.

## Submission checklist

- [ ] Public GitHub repository pushed
- [ ] `npm run preflight` passes against live credentials
- [ ] Safe-ship path rehearsed
- [ ] Held path rehearsed (real Jira ticket)
- [ ] Rollback path rehearsed (green build, broken page, verified recovery)
- [ ] Demo recording or live demo ready
- [ ] LinkedIn post published, tagging Swytchcode and KNOTiC
- [ ] Submitted on Commudle with the repo and post links

# Submission notes

Build with Swytchcode Buildathon — **Track 3: AI DevOps & Deployment Agent**
Project: **Release Sentinel**

## Checklist

- [ ] Public GitHub repository pushed
- [ ] `npm run preflight` passes against live credentials
- [ ] Healthy path rehearsed (safe commit ships, Notion report written)
- [ ] Recovery path rehearsed (broken build rolls back, Jira incident filed)
- [ ] Demo recording or live demo ready
- [ ] LinkedIn post published, tagging Swytchcode and KNOTiC
- [ ] Submitted on Commudle with the repo and post links

## What to show, in order

1. **The dashboard, idle.** Point out the Swytchcode call table — it is the proof
   that every action goes through the kernel, and it fills up live.
2. **Push a safe commit.** Run Sentinel. Narrate the risk gauge and the rationale:
   the agent explains *why* it is shipping, not just that it did.
3. **Push a build-breaking commit** — rename `site/site.css` without touching
   `index.html`. The build genuinely fails. Say nothing and let the agent cancel,
   roll back, file the Jira incident and write the Notion postmortem on its own.
4. **Open the artifacts.** The Jira incident links back to the run, and the Notion
   report carries the commit, the deploy id and the rollback target.
5. **Close on `npm run selftest`** if there is time: every branch, including the
   rollback, is covered deterministically.

Rehearse step 3 before the demo. Force the failure with a change you have already
tested, never an improvised one.

## Talking points

- **Closed loop, not a notifier.** It decides, acts, verifies its own work, and
  recovers. A bot that files a ticket when CI goes red is a cron job.
- **The model cannot overrule hard evidence.** The LLM verdict is reconciled against
  a deterministic heuristic: a failing check forces HOLD no matter what the model
  said, and the heuristic floors the score.
- **Chained data flow across four integrations.** Commit SHA drives the verdict, the
  verdict decides whether a Jira ticket is filed and whether a deploy happens, the
  deploy id drives verification, and the rollback target plus incident key land in
  the Notion report.
- **Real integration findings, not a happy path.** The commit *search* endpoint lags
  pushes so the direct endpoint had to be used; most of the Notion bundle cannot be
  enabled due to unresolved response structs; Jira ships a placeholder base URL and
  needs Basic auth plus ADF. All documented in the README.
- **A real engineering constraint solved.** `exec()` is `spawnSync`-based and blocks
  the event loop, which would freeze the live dashboard, so the pipeline runs in a
  worker thread.

## LinkedIn post draft

> I spent today building **Release Sentinel** for the Build with Swytchcode Buildathon.
>
> Most "AI DevOps" demos file a ticket when a build goes red. That's a cron job with
> a language model bolted on. I wanted to find out whether an agent could own a
> release end to end — including the part where it goes wrong.
>
> Release Sentinel reads commits, diffs and CI signals from GitHub, scores how risky
> the change is and writes down its reasoning, then either blocks the release and
> files a Jira ticket, or ships it to Netlify. It then watches its own deploy. When
> the deploy fails, it cancels it, rolls production back to the last good deploy,
> files a Jira incident and writes the postmortem to Notion — without being asked.
>
> Every one of those actions runs through @Swytchcode. Four integrations, no
> hand-written HTTP clients, no vendor SDKs.
>
> Two things I learned the hard way:
>
> 1. The LLM cannot be the only judge. I score risk with deterministic features
>    first and use that as a floor, so a confidently wrong "ship it" can never
>    override a failing CI check.
> 2. Rollback is the branch you can't rehearse safely, so it's the one most likely
>    to be broken on stage. I stubbed the kernel and asserted the whole recovery
>    path in a test instead of hoping.
>
> Thanks to @KNOTiC and @Swytchcode for a problem statement with real teeth.
>
> #Swytchcode #KNOTiC #AIAgents #DevOps #Buildathon

Replace the `@` mentions with the real LinkedIn company tags before posting, and
attach a screen recording of the rollback — that is the moment that lands.

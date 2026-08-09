import { extractFeatures } from "../agent/features.ts";
import type { RunContext } from "./context.ts";

/**
 * Stage 1: collect the release candidate from GitHub and reduce it to features.
 *
 * Returns false when there is nothing new, which short-circuits the rest of the
 * pipeline — the agent should be silent when nothing shipped, not file an empty
 * report on every poll.
 */
export async function ingest(context: RunContext): Promise<boolean> {
  const { config, github, run } = context;
  context.setStep("ingest", "running");

  const since = new Date(Date.now() - config.agent.lookbackMinutes * 60_000);
  context.log(
    "info",
    `scanning ${config.github.owner}/${config.github.repo}@${config.github.branch} for commits since ${since.toISOString()}`,
  );

  const summaries = await github.listCommits(since, config.agent.maxCommits);

  if (summaries.length === 0) {
    context.setStep(
      "ingest",
      "ok",
      `no commits in the last ${config.agent.lookbackMinutes} minutes`,
    );
    context.log("info", "no new commits found; nothing to release");
    return false;
  }

  context.log(
    "info",
    `found ${summaries.length} commit(s); fetching diffs and CI signals`,
  );

  // Sequential on purpose: each commit costs 3 Swytchcode calls, and the kernel
  // caps concurrency per integration anyway. Serial keeps the dashboard
  // timeline readable and avoids hitting GitHub's secondary rate limits.
  const enriched = [];
  for (const summary of summaries) {
    enriched.push(await github.enrichCommit(summary));
    run.commits = enriched;
    context.emit();
  }

  run.features = extractFeatures(enriched);
  context.setStep(
    "ingest",
    "ok",
    `${enriched.length} commit(s), ${run.features.filesChanged} file(s), ${run.features.churn} lines churned`,
  );
  return true;
}

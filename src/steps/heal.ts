import { checkSiteHealth } from "../health.ts";
import type { DeployRef } from "../types.ts";
import type { RunContext } from "./context.ts";
import type { VerifyOutcome } from "./verify.ts";

/**
 * How many older deploys to walk before giving up. A rollback target can itself
 * be unhealthy — most often because Netlify's git CD published the same broken
 * commit the agent did — so the agent keeps stepping back through history until
 * production actually serves a good page.
 */
const MAX_ROLLBACK_ATTEMPTS = 3;

/** How the release went wrong, in words a human reading the ticket can act on. */
const PROBLEM: Record<VerifyOutcome, string> = {
  succeeded: "was healthy",
  failed: "failed to build",
  timeout: "did not settle before the timeout",
  unhealthy: "published successfully but failed its post-deploy health check",
};

/**
 * Stage 5: recover from a bad release without being asked.
 *
 * Cancel the stuck build, republish the last deploy that was known good, then
 * file an incident ticket linked back to any review ticket from this run. This
 * is the part that makes the system an agent rather than a notifier.
 */
export async function heal(
  context: RunContext,
  reason: VerifyOutcome,
): Promise<void> {
  const { netlify, jira, run, config } = context;
  context.setStep("heal", "running");

  const failedDeploy = run.deploy;

  // Only a timeout leaves a build running that needs cancelling; a deploy that
  // already reported `error` is finished and cancelling it would fail.
  if (reason === "timeout" && failedDeploy?.id) {
    const cancelled = await netlify.tryCancel(failedDeploy.id);
    if (cancelled) {
      context.log("info", `cancelled stalled deploy ${failedDeploy.id}`);
    } else {
      context.log("warn", `could not cancel deploy ${failedDeploy.id}`);
    }
  }

  await rollBack(context, failedDeploy);

  if (jira.configured) {
    const head = run.commits[0];
    const health = run.healthCheck;
    const body = [
      `A deploy triggered by Release Sentinel ${PROBLEM[reason]}.`,
      "",
      `Failed deploy: ${failedDeploy?.id ?? "unknown"} (state ${failedDeploy?.state ?? "unknown"})`,
      failedDeploy?.errorMessage ? `Netlify error: ${failedDeploy.errorMessage}` : "",
      health && !health.healthy
        ? `Health check: ${health.url} failed ${health.attempts} attempt(s) - ${health.reason}. The build exited zero, so Netlify published it; the served page did not pass the smoke test.`
        : "",
      run.restoredDeploy
        ? `Production was automatically rolled back to deploy ${run.restoredDeploy.id}.`
        : "No previous successful deploy was available, so production was NOT rolled back. Manual intervention required.",
      run.rollbackHealth
        ? run.rollbackHealth.healthy
          ? `Post-rollback check: ${run.rollbackHealth.url} is serving the expected page again.`
          : `Post-rollback check: ${run.rollbackHealth.url} is STILL unhealthy - ${run.rollbackHealth.reason}. Manual intervention required.`
        : "",
      "",
      `Candidate commit: ${head?.shortSha ?? "unknown"} - ${head?.message ?? ""}`,
      head?.url ? `Commit: ${head.url}` : "",
      "",
      `Pre-deploy risk score was ${run.verdict?.riskScore ?? "unknown"}/100 with action ${run.verdict?.action ?? "unknown"}.`,
      run.verdict?.rationale ? `\nPre-deploy rationale:\n${run.verdict.rationale}` : "",
      "",
      `Site: https://app.netlify.com/sites/${config.netlify.siteId}/deploys`,
      "",
      "Filed automatically by Release Sentinel via Swytchcode.",
    ]
      .filter((line) => line !== "")
      .join("\n");

    const incident = await jira.createIssue({
      summary: `Incident: deploy ${failedDeploy?.id?.slice(0, 8) ?? "unknown"} ${
        reason === "unhealthy" ? "failed its health check" : "failed"
      } and was rolled back`,
      description: body,
      labels: [
        "release-sentinel",
        "incident",
        "auto-rollback",
        ...(reason === "unhealthy" ? ["health-check"] : []),
      ],
    });
    run.incidentIssue = incident;
    context.log("info", `filed incident ${incident.key}`);

    // Tie the incident to the pre-deploy review ticket so the history of the
    // release reads as one thread.
    if (run.jiraIssue?.key) {
      const linked = await jira.tryLink(incident.key, run.jiraIssue.key);
      if (!linked) {
        context.log("warn", "could not link the incident to the review ticket");
      }
    }
    context.emit();
  } else {
    context.log("warn", "Jira not configured; incident not filed");
  }

  context.setStep(
    "heal",
    "ok",
    [
      run.restoredDeploy ? `rolled back to ${run.restoredDeploy.id}` : "no rollback target",
      run.rollbackHealth?.healthy ? "production verified healthy" : undefined,
      run.rollbackHealth && !run.rollbackHealth.healthy
        ? "production still unhealthy"
        : undefined,
      run.incidentIssue ? `incident ${run.incidentIssue.key}` : undefined,
    ]
      .filter(Boolean)
      .join(", "),
  );
}

/**
 * Republishes the newest deploy that is both successful and built from a
 * different commit than the one that just failed, then proves production is
 * serving a good page before declaring the rollback done.
 */
async function rollBack(
  context: RunContext,
  failedDeploy: DeployRef | undefined,
): Promise<void> {
  const { netlify, run, config } = context;

  const candidates = await netlify.goodDeployCandidates(
    failedDeploy?.id,
    failedDeploy?.commitRef,
  );

  if (candidates.length === 0) {
    context.log("warn", "no previously successful deploy found; nothing to roll back to");
    return;
  }

  for (const candidate of candidates.slice(0, MAX_ROLLBACK_ATTEMPTS)) {
    const restored = await netlify.restoreDeploy(candidate.id);
    run.restoredDeploy = restored;
    context.log(
      "info",
      `rolled production back to deploy ${candidate.id} (${restored.url ?? "no url"})`,
    );
    context.emit();

    if (!config.health.enabled) return;

    const url = config.health.url || restored.url || candidate.url;
    if (!url) return;

    const health = await checkSiteHealth(url, config.health, {
      fetchSite: context.fetchSite,
    });
    run.rollbackHealth = health;
    context.emit();

    if (health.healthy) {
      context.log("info", `production verified healthy after rollback (${url})`);
      return;
    }

    context.log(
      "warn",
      `deploy ${candidate.id} is also unhealthy (${health.reason}); stepping further back`,
    );
  }

  context.log(
    "error",
    "rolled back but production is still unhealthy; manual intervention required",
  );
}

import type { RunContext } from "./context.ts";
import type { VerifyOutcome } from "./verify.ts";

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

  const lastGood = await netlify.lastGoodDeploy(failedDeploy?.id);

  if (lastGood?.id) {
    const restored = await netlify.restoreDeploy(lastGood.id);
    run.restoredDeploy = restored;
    context.log(
      "info",
      `rolled production back to deploy ${lastGood.id} (${restored.url ?? "no url"})`,
    );
    context.emit();
  } else {
    context.log(
      "warn",
      "no previously successful deploy found; nothing to roll back to",
    );
  }

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
      run.incidentIssue ? `incident ${run.incidentIssue.key}` : undefined,
    ]
      .filter(Boolean)
      .join(", "),
  );
}

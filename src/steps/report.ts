import type { RunOutcome, RunState } from "../types.ts";
import type { RunContext } from "./context.ts";

/**
 * Stage 6: write the human-readable record to Notion.
 *
 * Runs on every terminal path — shipped, held or rolled back — so the Notion
 * page becomes a continuous release log rather than only an incident archive.
 */

const OUTCOME_HEADINGS: Record<RunOutcome, string> = {
  shipped: "Release published",
  held: "Release blocked",
  rolled_back: "Incident: release rolled back",
  no_changes: "No changes",
  failed: "Run failed",
};

export function buildReportMarkdown(run: RunState, siteId: string): string {
  const outcome = run.outcome ?? "failed";
  const when = new Date(run.startedAt).toISOString().replace("T", " ").slice(0, 19);
  const lines: string[] = [];

  lines.push(`## ${OUTCOME_HEADINGS[outcome]} - ${when} UTC`);
  lines.push("");

  if (run.verdict) {
    lines.push(
      `**Risk score:** ${run.verdict.riskScore}/100 -> **${run.verdict.action}**${run.verdict.degraded ? " _(heuristic fallback)_" : ""}`,
    );
    lines.push("");
    lines.push(`**Rationale:** ${run.verdict.rationale}`);
    lines.push("");
    if (run.verdict.concerns.length > 0) {
      lines.push("**Concerns:**");
      for (const concern of run.verdict.concerns) lines.push(`- ${concern}`);
      lines.push("");
    }
  }

  if (run.commits.length > 0) {
    lines.push("**Commits:**");
    for (const commit of run.commits) {
      const suffix = commit.url ? ` ([${commit.shortSha}](${commit.url}))` : ` (${commit.shortSha})`;
      lines.push(
        `- ${commit.message} - ${commit.author}, +${commit.additions}/-${commit.deletions}${suffix}`,
      );
    }
    lines.push("");
  }

  if (run.features) {
    lines.push(
      `**Change surface:** ${run.features.filesChanged} file(s), ${run.features.churn} lines churned, ${run.features.failedChecks} failing check(s), combined CI status \`${run.features.combinedCheckState}\`.`,
    );
    lines.push("");
  }

  if (run.deploy) {
    lines.push(`**Deploy:** \`${run.deploy.id}\` ended in state \`${run.deploy.state}\`.`);
    if (run.deploy.url) lines.push(`Deploy URL: ${run.deploy.url}`);
    if (run.deploy.errorMessage) lines.push(`Netlify error: ${run.deploy.errorMessage}`);
    lines.push("");
  }

  if (run.healthCheck) {
    const health = run.healthCheck;
    lines.push(
      health.healthy
        ? `**Health check:** passed on attempt ${health.attempts} - ${health.url} served \`${health.marker}\`.`
        : `**Health check:** FAILED after ${health.attempts} attempt(s) against ${health.url} - ${health.reason}. The build exited zero, so the deploy published; the served page did not pass the smoke test.`,
    );
    lines.push("");
  }

  if (run.restoredDeploy) {
    lines.push(
      `**Rollback:** production was automatically restored to deploy \`${run.restoredDeploy.id}\`.`,
    );
    lines.push("");
  }

  const tickets: string[] = [];
  if (run.jiraIssue?.key) tickets.push(`review ${run.jiraIssue.key} (${run.jiraIssue.url})`);
  if (run.incidentIssue?.key)
    tickets.push(`incident ${run.incidentIssue.key} (${run.incidentIssue.url})`);
  if (tickets.length > 0) {
    lines.push(`**Jira:** ${tickets.join(", ")}`);
    lines.push("");
  }

  if (siteId) {
    lines.push(`**Netlify deploys:** https://app.netlify.com/sites/${siteId}/deploys`);
    lines.push("");
  }

  const ok = run.swytchcodeCalls.filter((call) => call.ok).length;
  lines.push(
    `_${run.swytchcodeCalls.length} Swytchcode call(s) executed this run (${ok} succeeded). Written automatically by Release Sentinel._`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

export async function report(context: RunContext): Promise<void> {
  const { notion, run, config } = context;
  context.setStep("report", "running");

  if (!notion.configured) {
    context.setStep("report", "skipped", "Notion not configured");
    context.log("warn", "Notion not configured; skipping the written report");
    return;
  }

  const markdown = buildReportMarkdown(run, config.netlify.siteId);
  const result = await notion.appendReport(markdown);

  if (result.ok) {
    run.notionReportUrl = notion.pageUrl;
    context.log("info", `wrote the report to Notion via ${result.via}`);
    context.setStep("report", "ok", `written via ${result.via}`);
  } else {
    context.log("error", `could not write the Notion report: ${result.detail ?? "unknown"}`);
    context.setStep("report", "error", result.detail ?? "unknown error");
  }
}

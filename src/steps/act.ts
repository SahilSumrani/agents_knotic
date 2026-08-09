import type { RunContext } from "./context.ts";

export type ActResult =
  | { kind: "held" }
  | { kind: "deploying"; deployId: string }
  | { kind: "skipped"; reason: string };

/**
 * Stage 3: act on the verdict.
 *
 * HOLD files a blocking Jira ticket and stops. SHIP_WITH_TICKET files a
 * follow-up ticket and continues. Both ship paths trigger a Netlify build.
 */
export async function act(context: RunContext): Promise<ActResult> {
  const { run, jira, netlify, config } = context;
  context.setStep("act", "running");

  const verdict = run.verdict;
  if (!verdict) throw new Error("act called before assess produced a verdict");

  const commitList = run.commits
    .map((commit) => `- ${commit.shortSha} ${commit.message} (${commit.author})`)
    .join("\n");

  const ticketBody = [
    verdict.ticketDescription,
    "",
    `Risk score: ${verdict.riskScore}/100 (threshold ${config.agent.riskThreshold})`,
    `Decision: ${verdict.action}`,
    "",
    "Rationale:",
    verdict.rationale,
    "",
    verdict.concerns.length > 0 ? `Concerns:\n${verdict.concerns.map((c) => `- ${c}`).join("\n")}` : "",
    "",
    "Commits:",
    commitList,
    "",
    `Repository: https://github.com/${config.github.owner}/${config.github.repo}`,
    "",
    "Filed automatically by Release Sentinel via Swytchcode.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  // A ticket is filed whenever a human needs to look at something, whether or
  // not the change ships.
  if (verdict.action === "HOLD" || verdict.action === "SHIP_WITH_TICKET") {
    if (jira.configured) {
      const issue = await jira.createIssue({
        summary: verdict.ticketSummary,
        description: ticketBody,
        labels: [
          "release-sentinel",
          verdict.action === "HOLD" ? "deploy-blocked" : "post-deploy-review",
        ],
      });
      run.jiraIssue = issue;
      context.log("info", `filed Jira issue ${issue.key}`);
      context.emit();
    } else {
      context.log("warn", "Jira not configured; skipping ticket creation");
    }
  }

  if (verdict.action === "HOLD") {
    context.setStep(
      "act",
      "ok",
      run.jiraIssue
        ? `deploy blocked, filed ${run.jiraIssue.key}`
        : "deploy blocked",
    );
    return { kind: "held" };
  }

  if (!netlify.configured) {
    context.setStep("act", "skipped", "Netlify not configured");
    context.log("warn", "Netlify not configured; cannot trigger a deploy");
    return { kind: "skipped", reason: "netlify not configured" };
  }

  if (config.agent.dryRun) {
    context.setStep("act", "skipped", "AGENT_DRY_RUN=true, no deploy triggered");
    context.log("warn", "dry-run mode: skipping the real deploy");
    return { kind: "skipped", reason: "dry run" };
  }

  const head = run.commits[0];
  const title = `Release Sentinel: ${head?.shortSha ?? "unknown"} (risk ${verdict.riskScore})`;
  const build = await netlify.triggerBuild(title);

  // Netlify does not always return a deploy id on the build record, so fall
  // back to the newest deploy for the site.
  let deployId = build.deployId;
  if (!deployId) {
    context.log("info", "build response carried no deploy id; resolving newest deploy");
    const latest = await netlify.latestDeploy();
    deployId = latest?.id ?? "";
  }

  if (!deployId) {
    context.setStep("act", "error", "could not resolve a deploy id");
    return { kind: "skipped", reason: "no deploy id" };
  }

  run.deploy = { id: deployId, state: "building" };
  context.log("info", `triggered Netlify build, tracking deploy ${deployId}`);
  context.setStep("act", "ok", `deploy ${deployId} triggered`);
  return { kind: "deploying", deployId };
}

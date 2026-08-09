import { checkReadiness, loadConfig } from "./config.ts";
import { runPipeline } from "./pipeline.ts";

/**
 * Headless single pass, for cron, CI, or a terminal demo without the dashboard.
 * Exits non-zero when the release did not end in a healthy state so a scheduler
 * can alert on it.
 */

const config = loadConfig();
const blocking = checkReadiness(config).filter((problem) => problem.blocking);

if (blocking.length > 0) {
  for (const problem of blocking) {
    console.error(`missing config: ${problem.service} - ${problem.detail}`);
  }
  process.exit(1);
}

const run = await runPipeline(config, "manual", {
  onLog: (entry) => {
    const stream = entry.level === "error" ? process.stderr : process.stdout;
    stream.write(`[${entry.level}] ${entry.message}\n`);
  },
});

const summary = [
  `run ${run.id} finished: ${run.outcome}`,
  run.verdict ? `risk ${run.verdict.riskScore} (${run.verdict.action})` : undefined,
  run.deploy ? `deploy ${run.deploy.id} ${run.deploy.state}` : undefined,
  run.restoredDeploy ? `rolled back to ${run.restoredDeploy.id}` : undefined,
  run.jiraIssue ? `review ${run.jiraIssue.key}` : undefined,
  run.incidentIssue ? `incident ${run.incidentIssue.key}` : undefined,
  `${run.swytchcodeCalls.length} Swytchcode calls`,
]
  .filter(Boolean)
  .join(" | ");

console.log(summary);

process.exitCode =
  run.outcome === "shipped" || run.outcome === "no_changes" ? 0 : 1;

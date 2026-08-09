import { checkSiteHealth } from "../health.ts";
import type { HealthCheckResult } from "../types.ts";
import type { RunContext } from "./context.ts";

export type VerifyOutcome = "succeeded" | "failed" | "timeout" | "unhealthy";

/**
 * Stage 4: watch the deploy until it settles, then prove the site actually works.
 *
 * Each poll updates the run so the dashboard shows the state transitions live
 * rather than jumping straight from "building" to a final answer. Reaching
 * `ready` is necessary but not sufficient: Netlify only reports the build's exit
 * code, so a published-but-broken page would otherwise be recorded as a healthy
 * release. An unhealthy site is treated as a failed deploy and takes the same
 * recovery path as a build failure.
 */
export async function verify(
  context: RunContext,
  deployId: string,
): Promise<VerifyOutcome> {
  const { netlify, run } = context;
  context.setStep("verify", "running");

  const result = await netlify.waitForDeploy(deployId, (deploy) => {
    run.deploy = deploy;
    context.emit();
  });

  run.deploy = result.deploy;

  if (result.outcome === "succeeded") {
    context.log("info", `deploy ${deployId} published: ${result.deploy.url ?? "no url"}`);

    const health = await smokeTest(context);

    if (health && !health.healthy) {
      context.log(
        "error",
        `deploy ${deployId} published but the site is unhealthy: ${health.reason}`,
      );
      context.setStep("verify", "error", `health check failed: ${health.reason}`);
      return "unhealthy";
    }

    context.setStep(
      "verify",
      "ok",
      health
        ? `published (${result.deploy.state}), site healthy on attempt ${health.attempts}`
        : `published (${result.deploy.state})`,
    );
    return "succeeded";
  }

  if (result.outcome === "failed") {
    context.log(
      "error",
      `deploy ${deployId} failed: ${result.deploy.errorMessage ?? result.deploy.state}`,
    );
    context.setStep("verify", "error", result.deploy.errorMessage ?? result.deploy.state);
    return "failed";
  }

  // A timeout is treated as a failure: an unfinished deploy is not a safe state
  // to leave production in, so the agent recovers rather than waiting forever.
  context.log("error", `deploy ${deployId} did not settle before the timeout`);
  context.setStep("verify", "error", "timed out waiting for the deploy to settle");
  return "timeout";
}

/**
 * Fetches the published site. Returns undefined when the check is switched off
 * or there is no URL to hit, in which case the deploy state stands on its own.
 */
async function smokeTest(
  context: RunContext,
): Promise<HealthCheckResult | undefined> {
  const { config, run } = context;

  if (!config.health.enabled) {
    context.log("warn", "post-deploy health check is disabled; trusting the deploy state");
    return undefined;
  }

  const url = config.health.url || run.deploy?.url;
  if (!url) {
    context.log("warn", "no deploy URL to health check; trusting the deploy state");
    return undefined;
  }

  context.log("info", `health checking ${url} for "${config.health.marker}"`);

  const health = await checkSiteHealth(url, config.health, {
    fetchSite: context.fetchSite,
    onAttempt: (attempt, reason) =>
      context.log(
        "warn",
        `health check attempt ${attempt}/${config.health.attempts} failed: ${reason}`,
      ),
  });

  run.healthCheck = health;
  context.emit();
  return health;
}

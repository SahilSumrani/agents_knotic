import type { RunContext } from "./context.ts";

export type VerifyOutcome = "succeeded" | "failed" | "timeout";

/**
 * Stage 4: watch the deploy until it settles.
 *
 * Each poll updates the run so the dashboard shows the state transitions live
 * rather than jumping straight from "building" to a final answer.
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
    context.setStep("verify", "ok", `published (${result.deploy.state})`);
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

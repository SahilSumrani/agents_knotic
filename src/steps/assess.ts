import type { RunContext } from "./context.ts";

/** Stage 2: score the candidate and decide what to do with it. */
export async function assess(context: RunContext): Promise<void> {
  const { run, assessor } = context;
  context.setStep("assess", "running");

  if (!run.features) throw new Error("assess called before ingest produced features");

  const verdict = await assessor.assess(run.commits, run.features);
  run.verdict = verdict;

  context.log(
    verdict.action === "HOLD" ? "warn" : "info",
    `risk ${verdict.riskScore}/100 -> ${verdict.action}: ${verdict.rationale}`,
  );
  if (verdict.degraded) {
    context.log("warn", "verdict produced by heuristic fallback, not the language model");
  }

  context.setStep(
    "assess",
    "ok",
    `risk ${verdict.riskScore}/100, action ${verdict.action}${verdict.degraded ? " (heuristic)" : ""}`,
  );
}

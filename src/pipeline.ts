import { randomUUID } from "node:crypto";
import { RiskAssessor } from "./agent/risk.ts";
import type { Config } from "./config.ts";
import { GitHubIntegration } from "./integrations/github.ts";
import { JiraIntegration } from "./integrations/jira.ts";
import { NetlifyIntegration } from "./integrations/netlify.ts";
import { NotionIntegration } from "./integrations/notion.ts";
import { SwytchcodeClient } from "./swytch.ts";
import { act } from "./steps/act.ts";
import { assess } from "./steps/assess.ts";
import type { RunContext } from "./steps/context.ts";
import { heal } from "./steps/heal.ts";
import { ingest } from "./steps/ingest.ts";
import { report } from "./steps/report.ts";
import { verify } from "./steps/verify.ts";
import type {
  RunState,
  StepName,
  StepStatus,
  SwytchcodeCallRecord,
} from "./types.ts";

/**
 * The agent loop as an explicit state machine.
 *
 * ingest -> assess -> act -> verify -> (heal) -> report
 *
 * The interesting property is that control flow is decided by the verdict and by
 * the observed deploy state, not by a fixed script: a HOLD skips deployment
 * entirely, and a failed verify diverts into recovery before reporting.
 */

const STEP_ORDER: StepName[] = [
  "ingest",
  "assess",
  "act",
  "verify",
  "heal",
  "report",
];

function emptyRun(trigger: RunState["trigger"]): RunState {
  return {
    id: randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    trigger,
    steps: STEP_ORDER.map((name) => ({ name, status: "pending" })),
    commits: [],
    swytchcodeCalls: [],
    logs: [],
  };
}

export interface PipelineHooks {
  onUpdate?: (run: RunState) => void;
  onLog?: (entry: { at: string; level: string; message: string }) => void;
}

export interface PipelineOverrides {
  /**
   * Substitute the Swytchcode client. Used by `npm run selftest` to drive the
   * state machine through its branches — including rollback — without touching
   * live services or mutating anyone's Jira project.
   */
  swytch?: SwytchcodeClient;
}

export async function runPipeline(
  config: Config,
  trigger: RunState["trigger"] = "manual",
  hooks: PipelineHooks = {},
  overrides: PipelineOverrides = {},
): Promise<RunState> {
  const run = emptyRun(trigger);

  const emit = () => hooks.onUpdate?.(run);

  const log = (level: "info" | "warn" | "error", message: string) => {
    const entry = { at: new Date().toISOString(), level, message };
    run.logs.push(entry);
    hooks.onLog?.(entry);
    emit();
  };

  const setStep = (name: StepName, status: StepStatus, detail?: string) => {
    const step = run.steps.find((candidate) => candidate.name === name);
    if (!step) return;
    step.status = status;
    if (status === "running") step.startedAt = new Date().toISOString();
    if (status !== "running" && status !== "pending") {
      step.finishedAt = new Date().toISOString();
    }
    if (detail !== undefined) step.detail = detail;
    if (status === "error") step.error = detail;
    emit();
  };

  // Every integration call lands in the run record, which is what the dashboard
  // shows and what makes the Swytchcode usage auditable after the fact.
  const recorder = (record: SwytchcodeCallRecord) => {
    run.swytchcodeCalls.push(record);
    emit();
  };
  const swytch =
    overrides.swytch ?? new SwytchcodeClient({ recorder });
  swytch.setRecorder(recorder);

  const context: RunContext = {
    config,
    github: new GitHubIntegration(swytch, config),
    jira: new JiraIntegration(swytch, config),
    netlify: new NetlifyIntegration(swytch, config),
    notion: new NotionIntegration(swytch, config),
    assessor: new RiskAssessor(config),
    run,
    emit,
    log,
    setStep,
  };

  try {
    const hasChanges = await ingest(context);
    if (!hasChanges) {
      run.outcome = "no_changes";
      for (const name of ["assess", "act", "verify", "heal", "report"] as StepName[]) {
        setStep(name, "skipped", "no new commits");
      }
      return finish(run, emit);
    }

    await assess(context);
    const action = await act(context);

    if (action.kind === "held") {
      run.outcome = "held";
      setStep("verify", "skipped", "deploy was blocked");
      setStep("heal", "skipped", "nothing was deployed");
      await report(context);
      return finish(run, emit);
    }

    if (action.kind === "skipped") {
      run.outcome = "held";
      setStep("verify", "skipped", action.reason);
      setStep("heal", "skipped", action.reason);
      await report(context);
      return finish(run, emit);
    }

    const outcome = await verify(context, action.deployId);

    if (outcome === "succeeded") {
      run.outcome = "shipped";
      setStep("heal", "skipped", "deploy was healthy");
    } else {
      await heal(context, outcome);
      run.outcome = "rolled_back";
    }

    await report(context);
    return finish(run, emit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.error = message;
    run.outcome = "failed";
    log("error", `run failed: ${message}`);

    // Mark whatever was mid-flight as errored so the dashboard does not leave a
    // step spinning forever.
    for (const step of run.steps) {
      if (step.status === "running") {
        step.status = "error";
        step.error = message;
        step.finishedAt = new Date().toISOString();
      }
    }

    // Still try to leave a written record of the failure.
    try {
      if (run.commits.length > 0) await report(context);
    } catch {
      // Reporting failure on top of a failed run is not worth escalating.
    }

    return finish(run, emit);
  }
}

function finish(run: RunState, emit: () => void): RunState {
  run.finishedAt = new Date().toISOString();
  emit();
  return run;
}

import type { Config } from "../config.ts";
import type { SiteFetch } from "../health.ts";
import type { GitHubIntegration } from "../integrations/github.ts";
import type { JiraIntegration } from "../integrations/jira.ts";
import type { NetlifyIntegration } from "../integrations/netlify.ts";
import type { NotionIntegration } from "../integrations/notion.ts";
import type { RiskAssessor } from "../agent/risk.ts";
import type { RunState, StepName, StepStatus } from "../types.ts";

/**
 * Everything a step needs: the integrations, the mutable run record, and the
 * hooks used to report progress. Steps never talk to the transport layer
 * directly — they mutate the run and call `emit`, and the worker forwards it.
 */
export interface RunContext {
  config: Config;
  github: GitHubIntegration;
  jira: JiraIntegration;
  netlify: NetlifyIntegration;
  notion: NotionIntegration;
  assessor: RiskAssessor;
  /** How the verify step reaches the deployed site for its smoke test. */
  fetchSite: SiteFetch;
  run: RunState;
  /** Publishes the current run state to listeners. */
  emit: () => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
  setStep: (name: StepName, status: StepStatus, detail?: string) => void;
}

/** Domain types shared by the pipeline steps, the worker and the dashboard. */

export interface CommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  url: string;
  committedAt: string;
}

/** A commit enriched with the diff stats and CI signals used for risk scoring. */
export interface EnrichedCommit extends CommitSummary {
  additions: number;
  deletions: number;
  files: CommitFile[];
  checks: {
    total: number;
    failed: number;
    pending: number;
    combinedState: string;
  };
  pullRequests: { number: number; title: string; url: string }[];
}

export interface RiskFeatures {
  commitCount: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  churn: number;
  touchesConfig: boolean;
  touchesDependencies: boolean;
  touchesCi: boolean;
  touchesInfrastructure: boolean;
  hasRevert: boolean;
  hasHotfix: boolean;
  failedChecks: number;
  pendingChecks: number;
  combinedCheckState: string;
  largestFile: string | null;
  riskySignals: string[];
}

export type RiskAction = "SHIP" | "SHIP_WITH_TICKET" | "HOLD";

export interface RiskVerdict {
  riskScore: number;
  action: RiskAction;
  rationale: string;
  concerns: string[];
  ticketSummary: string;
  ticketDescription: string;
  /** True when the LLM was unavailable and the heuristic fallback decided. */
  degraded: boolean;
}

export interface JiraIssueRef {
  key: string;
  id: string;
  url: string;
}

export interface DeployRef {
  id: string;
  state: string;
  url?: string;
  adminUrl?: string;
  errorMessage?: string;
  /** The commit this deploy was built from; used to pick a rollback target. */
  commitRef?: string;
}

/** Result of the post-deploy smoke test against the published site. */
export interface HealthCheckResult {
  healthy: boolean;
  url: string;
  attempts: number;
  marker: string;
  /** Why the site was judged unhealthy; absent when it passed. */
  reason?: string;
}

export type RunOutcome =
  | "shipped"
  | "held"
  | "rolled_back"
  | "no_changes"
  | "failed";

export type StepName =
  | "ingest"
  | "assess"
  | "act"
  | "verify"
  | "heal"
  | "report";

export type StepStatus = "pending" | "running" | "ok" | "skipped" | "error";

export interface StepRecord {
  name: StepName;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
  error?: string;
}

export interface SwytchcodeCallRecord {
  canonicalId: string;
  integration: string;
  ok: boolean;
  durationMs: number;
  attempts: number;
  at: string;
  error?: string;
}

export interface RunState {
  id: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: RunOutcome;
  trigger: "manual" | "poll" | "webhook";
  steps: StepRecord[];
  commits: EnrichedCommit[];
  features?: RiskFeatures;
  verdict?: RiskVerdict;
  jiraIssue?: JiraIssueRef;
  incidentIssue?: JiraIssueRef;
  deploy?: DeployRef;
  healthCheck?: HealthCheckResult;
  restoredDeploy?: DeployRef;
  /** Proof that the deploy we rolled back to is actually serving a good page. */
  rollbackHealth?: HealthCheckResult;
  notionReportUrl?: string;
  swytchcodeCalls: SwytchcodeCallRecord[];
  logs: { at: string; level: string; message: string }[];
  error?: string;
}

/** Messages the pipeline worker streams back to the server for SSE fan-out. */
export type WorkerEvent =
  | { type: "run:started"; run: RunState }
  | { type: "run:updated"; run: RunState }
  | { type: "run:finished"; run: RunState }
  | { type: "log"; at: string; level: string; message: string };

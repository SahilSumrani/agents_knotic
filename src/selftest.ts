import type { ExecArgs } from "@swytchcode/runtime";
import type { Config } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import { SwytchcodeClient } from "./swytch.ts";
import type { CallOptions } from "./swytch.ts";
import type { RunOutcome } from "./types.ts";

/**
 * Drives the pipeline through each of its branches against a stubbed kernel.
 *
 * The point is the recovery path: you cannot rehearse a rollback on demand
 * against a live Netlify site without deliberately breaking production, so the
 * branch that matters most would otherwise be the least tested. Here a scripted
 * deploy failure exercises cancel -> restore -> incident every time.
 *
 * Run with: npm run selftest
 */

type Handler = (args: ExecArgs) => unknown;

class StubClient extends SwytchcodeClient {
  readonly seen: string[] = [];

  constructor(private readonly handlers: Record<string, Handler>) {
    super();
  }

  override async call<T>(
    canonicalId: string,
    args: ExecArgs,
    _options: CallOptions = {},
  ): Promise<T> {
    this.seen.push(canonicalId);
    const handler = this.handlers[canonicalId];
    if (!handler) throw new Error(`stub has no handler for ${canonicalId}`);
    const value = handler(args);
    this.record({
      canonicalId,
      integration: canonicalId.split(".")[0] ?? "unknown",
      ok: true,
      durationMs: 1,
      attempts: 1,
      at: new Date().toISOString(),
    });
    return value as T;
  }
}

function baseConfig(): Config {
  return {
    github: { auth: "Bearer test", owner: "acme", repo: "widget", branch: "main" },
    jira: {
      auth: "Basic test",
      baseUrl: "https://acme.atlassian.net",
      projectKey: "SEN",
      taskIssueType: "Task",
      useAdf: true,
    },
    netlify: { auth: "Bearer test", siteId: "site-1" },
    notion: {
      auth: "Bearer test",
      reportPageId: "page-1",
      version: "2026-03-11",
    },
    // No OpenAI key: the assessor uses its deterministic heuristic, which keeps
    // these assertions stable and free.
    openai: { apiKey: "", model: "stub" },
    agent: {
      riskThreshold: 65,
      deployTimeoutMs: 5_000,
      deployPollIntervalMs: 1,
      lookbackMinutes: 120,
      dryRun: false,
      maxCommits: 10,
    },
    server: { port: 0 },
  };
}

function commit(message: string, files: string[]) {
  return {
    sha: "a".repeat(40),
    html_url: "https://github.com/acme/widget/commit/aaaaaaa",
    commit: { message, author: { name: "dev", date: new Date().toISOString() } },
    author: { login: "dev" },
    stats: { additions: 12, deletions: 3 },
    files: files.map((filename) => ({
      filename,
      status: "modified",
      additions: 6,
      deletions: 1,
    })),
  };
}

/** Shared handlers; each scenario overrides only what it needs to vary. */
function handlers(options: {
  message?: string;
  files?: string[];
  failedCheck?: boolean;
  deployStates?: string[];
}): Record<string, Handler> {
  const single = commit(options.message ?? "fix: copy tweak", options.files ?? ["site/index.html"]);
  const states = [...(options.deployStates ?? ["ready"])];

  return {
    "github.commit.get.1": () => [single],
    "github.commit.get.2": () => single,
    "github.commit.checkRuns.get": () => ({
      check_runs: options.failedCheck
        ? [{ status: "completed", conclusion: "failure" }]
        : [{ status: "completed", conclusion: "success" }],
    }),
    "github.commit.status.get": () => ({
      state: options.failedCheck ? "failure" : "success",
    }),
    "github.commit.pulls.get": () => [],
    "netlify.build.create": () => ({ id: "build-1", deploy_id: "deploy-new" }),
    "netlify.deploy.get.1": () => ({
      id: "deploy-new",
      // Walks the scripted state sequence, holding on the final state.
      state: states.length > 1 ? states.shift() : states[0],
      error_message: states[0] === "error" ? "Build script returned non-zero exit code: 1" : undefined,
      deploy_ssl_url: "https://deploy-new--acme.netlify.app",
    }),
    "netlify.deploy.get": () => [
      { id: "deploy-new", state: "error" },
      { id: "deploy-old", state: "ready", deploy_ssl_url: "https://acme.netlify.app" },
    ],
    "netlify.cancel.create": () => ({ id: "deploy-new", state: "canceled" }),
    "netlify.deploy.restore.create": () => ({
      id: "deploy-old",
      state: "ready",
      deploy_ssl_url: "https://acme.netlify.app",
    }),
    "jira.api.issue.create": (args) => {
      const fields = (args.body as { fields?: { summary?: string } })?.fields;
      if (!fields?.summary) throw new Error("jira create called without a summary");
      return { key: "SEN-1", id: "10001" };
    },
    "jira.api.issueLink.create": () => ({}),
    "notion.markdown.update": (args) => {
      const body = args.body as { type?: string };
      if (body?.type !== "insert_content") {
        throw new Error(`unexpected notion payload type ${String(body?.type)}`);
      }
      return { object: "page" };
    },
  };
}

interface Scenario {
  name: string;
  config?: Partial<Config["agent"]>;
  handlers: Record<string, Handler>;
  expect: {
    outcome: RunOutcome;
    verdictAction?: string;
    deployed: boolean;
    rolledBack: boolean;
    jiraFiled: boolean;
    incidentFiled: boolean;
  };
}

const scenarios: Scenario[] = [
  {
    name: "low-risk change ships and is reported",
    handlers: handlers({}),
    expect: {
      outcome: "shipped",
      verdictAction: "SHIP",
      deployed: true,
      rolledBack: false,
      jiraFiled: false,
      incidentFiled: false,
    },
  },
  {
    name: "failing CI check is gated before any deploy",
    handlers: handlers({ failedCheck: true }),
    expect: {
      outcome: "held",
      verdictAction: "HOLD",
      deployed: false,
      rolledBack: false,
      jiraFiled: true,
      incidentFiled: false,
    },
  },
  {
    name: "failed deploy triggers rollback and an incident",
    handlers: handlers({ deployStates: ["building", "error"] }),
    expect: {
      outcome: "rolled_back",
      deployed: true,
      rolledBack: true,
      jiraFiled: false,
      incidentFiled: true,
    },
  },
  {
    // Scores 49: elevated by the dependency, config and urgency signals, but
    // below the default threshold. The agent ships it *and* files a review
    // ticket, which is the middle path working as intended.
    name: "risky dependency bump ships with a follow-up review ticket",
    handlers: handlers({
      message: "hotfix: urgent bump of every dependency",
      files: ["package.json", "package-lock.json", "netlify.toml"],
    }),
    expect: {
      outcome: "shipped",
      verdictAction: "SHIP_WITH_TICKET",
      deployed: true,
      rolledBack: false,
      jiraFiled: true,
      incidentFiled: false,
    },
  },
  {
    // Same change, stricter threshold: proves the gate is driven by the
    // threshold and not only by a failing check.
    name: "the same change is blocked once the risk threshold is tightened",
    config: { riskThreshold: 40 },
    handlers: handlers({
      message: "hotfix: urgent bump of every dependency",
      files: ["package.json", "package-lock.json", "netlify.toml"],
    }),
    expect: {
      outcome: "held",
      verdictAction: "HOLD",
      deployed: false,
      rolledBack: false,
      jiraFiled: true,
      incidentFiled: false,
    },
  },
];

let failures = 0;

for (const scenario of scenarios) {
  const config = baseConfig();
  Object.assign(config.agent, scenario.config ?? {});
  const stub = new StubClient(scenario.handlers);

  const run = await runPipeline(config, "manual", {}, { swytch: stub });

  const actual = {
    outcome: run.outcome,
    verdictAction: run.verdict?.action,
    deployed: Boolean(run.deploy?.id),
    rolledBack: Boolean(run.restoredDeploy?.id),
    jiraFiled: Boolean(run.jiraIssue?.key),
    incidentFiled: Boolean(run.incidentIssue?.key),
  };

  const problems: string[] = [];
  const check = (label: string, got: unknown, want: unknown) => {
    if (want !== undefined && got !== want) {
      problems.push(`${label}: expected ${String(want)}, got ${String(got)}`);
    }
  };

  check("outcome", actual.outcome, scenario.expect.outcome);
  check("verdict action", actual.verdictAction, scenario.expect.verdictAction);
  check("deployed", actual.deployed, scenario.expect.deployed);
  check("rolled back", actual.rolledBack, scenario.expect.rolledBack);
  check("jira filed", actual.jiraFiled, scenario.expect.jiraFiled);
  check("incident filed", actual.incidentFiled, scenario.expect.incidentFiled);
  if (run.error) problems.push(`run error: ${run.error}`);

  if (problems.length === 0) {
    console.log(
      `PASS ${scenario.name}\n     ${actual.outcome} | risk ${run.verdict?.riskScore} ${actual.verdictAction} | ${stub.seen.length} calls`,
    );
  } else {
    failures += 1;
    console.error(`FAIL ${scenario.name}`);
    for (const problem of problems) console.error(`     ${problem}`);
    console.error(`     calls: ${stub.seen.join(", ")}`);
  }
}

console.log(
  `\n${scenarios.length - failures}/${scenarios.length} scenarios passed.`,
);
process.exit(failures > 0 ? 1 : 0);

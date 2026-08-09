import "dotenv/config";

/**
 * Every credential is a static, non-expiring token: GitHub PAT, Jira email + API
 * token (Basic), Netlify PAT, Notion integration token. Nothing here needs an
 * OAuth refresh cycle, which is why the agent can run unattended.
 */

export class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`missing required env var ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`env var ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Jira Cloud uses Basic auth with the account email and an API token, not a
 * bearer token. Swytchcode's bundle ships a bearer placeholder, so we build the
 * correct header ourselves and override it per call.
 */
function jiraAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

export interface Config {
  github: {
    auth: string;
    owner: string;
    repo: string;
    branch: string;
  };
  jira: {
    auth: string;
    baseUrl: string;
    projectKey: string;
    taskIssueType: string;
    /** Jira Cloud REST v3 requires Atlassian Document Format for text fields. */
    useAdf: boolean;
  };
  netlify: {
    auth: string;
    siteId: string;
  };
  notion: {
    auth: string;
    reportPageId: string;
    version: string;
  };
  llm: {
    apiKey: string;
    model: string;
    /** Set for OpenAI-compatible providers such as Groq. */
    baseUrl: string | undefined;
    provider: "openai" | "groq" | "custom";
    /**
     * Strict schema adherence is only honoured by some models; when false the
     * assessor asks for JSON without constrained decoding and validates itself.
     */
    strictSchema: boolean;
  };
  /**
   * Post-deploy smoke test. Netlify reporting `ready` only means the build
   * command exited zero — the published page can still be broken — so the
   * agent fetches the deployed site before calling a release healthy.
   */
  health: {
    /** When false, a `ready` deploy is accepted without fetching the site. */
    enabled: boolean;
    /** Overrides the deploy's own URL; normally left empty. */
    url: string;
    /** Text that must appear in the served HTML. */
    marker: string;
    /** Attempts before declaring the site unhealthy; CDN propagation is not instant. */
    attempts: number;
    retryDelayMs: number;
    /** Per-request timeout. */
    timeoutMs: number;
  };
  agent: {
    /** Risk score at or above which the agent refuses to ship. */
    riskThreshold: number;
    /** How long to wait for a Netlify deploy to settle before giving up. */
    deployTimeoutMs: number;
    deployPollIntervalMs: number;
    /** Commits newer than this window are considered for a run. */
    lookbackMinutes: number;
    /** When false, the agent reasons and reports but performs no writes. */
    dryRun: boolean;
    maxCommits: number;
  };
  server: {
    port: number;
  };
}

/**
 * Resolves the language model provider.
 *
 * Groq speaks the OpenAI wire protocol, so the same SDK works against it with a
 * different base URL. Strict structured output is only guaranteed on Groq's
 * `openai/gpt-oss-*` models, so it is enabled for those and left off elsewhere
 * rather than being requested and silently ignored.
 */
function resolveLlm(): Config["llm"] {
  const groqKey = optional("GROQ_API_KEY");
  const openaiKey = optional("OPENAI_API_KEY");
  const explicitBase = optional("LLM_BASE_URL");
  const explicitModel = optional("LLM_MODEL") || optional("OPENAI_MODEL");

  if (groqKey) {
    const model = explicitModel || "openai/gpt-oss-20b";
    return {
      apiKey: groqKey,
      model,
      baseUrl: explicitBase || "https://api.groq.com/openai/v1",
      provider: "groq",
      strictSchema: model.startsWith("openai/gpt-oss"),
    };
  }

  return {
    apiKey: openaiKey,
    model: explicitModel || "gpt-4o-mini",
    baseUrl: explicitBase || undefined,
    provider: explicitBase ? "custom" : "openai",
    strictSchema: true,
  };
}

export function loadConfig(): Config {
  const jiraEmail = optional("JIRA_EMAIL");
  const jiraToken = optional("JIRA_API_TOKEN");

  return {
    github: {
      auth: `Bearer ${optional("GITHUB_TOKEN")}`,
      owner: optional("GITHUB_OWNER"),
      repo: optional("GITHUB_REPO"),
      branch: optional("GITHUB_BRANCH", "main"),
    },
    jira: {
      auth: jiraEmail && jiraToken ? jiraAuthHeader(jiraEmail, jiraToken) : "",
      baseUrl: optional("JIRA_BASE_URL").replace(/\/+$/, ""),
      projectKey: optional("JIRA_PROJECT_KEY"),
      taskIssueType: optional("JIRA_ISSUE_TYPE", "Task"),
      useAdf: optional("JIRA_USE_ADF", "true") !== "false",
    },
    netlify: {
      auth: `Bearer ${optional("NETLIFY_TOKEN")}`,
      siteId: optional("NETLIFY_SITE_ID"),
    },
    notion: {
      auth: `Bearer ${optional("NOTION_TOKEN")}`,
      reportPageId: optional("NOTION_REPORT_PAGE_ID"),
      // The markdown content API is only available on recent API versions.
      version: optional("NOTION_VERSION", "2026-03-11"),
    },
    llm: resolveLlm(),
    health: {
      enabled: optional("HEALTH_CHECK_ENABLED", "true") !== "false",
      url: optional("HEALTH_CHECK_URL"),
      marker: optional("HEALTH_CHECK_MARKER", "Guarded by Release Sentinel"),
      attempts: int("HEALTH_CHECK_ATTEMPTS", 4),
      retryDelayMs: int("HEALTH_CHECK_RETRY_DELAY_MS", 4_000),
      timeoutMs: int("HEALTH_CHECK_TIMEOUT_MS", 10_000),
    },
    agent: {
      riskThreshold: int("RISK_THRESHOLD", 65),
      deployTimeoutMs: int("DEPLOY_TIMEOUT_MS", 300_000),
      deployPollIntervalMs: int("DEPLOY_POLL_INTERVAL_MS", 6_000),
      lookbackMinutes: int("LOOKBACK_MINUTES", 120),
      dryRun: optional("AGENT_DRY_RUN", "false") === "true",
      maxCommits: int("MAX_COMMITS", 10),
    },
    server: {
      port: int("PORT", 3000),
    },
  };
}

export interface ReadinessProblem {
  service: string;
  detail: string;
  /** Blocking problems stop a run; non-blocking degrade a single step. */
  blocking: boolean;
}

/**
 * Reports what is missing rather than throwing on load, so the dashboard can
 * boot and show a setup checklist instead of crashing on an empty .env.
 */
export function checkReadiness(config: Config): ReadinessProblem[] {
  const problems: ReadinessProblem[] = [];
  const need = (
    ok: boolean,
    service: string,
    detail: string,
    blocking = true,
  ) => {
    if (!ok) problems.push({ service, detail, blocking });
  };

  need(config.github.auth !== "Bearer ", "github", "GITHUB_TOKEN is not set");
  need(Boolean(config.github.owner), "github", "GITHUB_OWNER is not set");
  need(Boolean(config.github.repo), "github", "GITHUB_REPO is not set");

  need(
    Boolean(config.llm.apiKey),
    "llm",
    "no model key set (GROQ_API_KEY or OPENAI_API_KEY)",
  );

  need(
    config.netlify.auth !== "Bearer ",
    "netlify",
    "NETLIFY_TOKEN is not set",
    false,
  );
  need(
    Boolean(config.netlify.siteId),
    "netlify",
    "NETLIFY_SITE_ID is not set",
    false,
  );

  need(Boolean(config.jira.auth), "jira", "JIRA_EMAIL / JIRA_API_TOKEN not set", false);
  need(Boolean(config.jira.baseUrl), "jira", "JIRA_BASE_URL is not set", false);
  need(
    Boolean(config.jira.projectKey),
    "jira",
    "JIRA_PROJECT_KEY is not set",
    false,
  );

  need(
    config.notion.auth !== "Bearer ",
    "notion",
    "NOTION_TOKEN is not set",
    false,
  );
  need(
    Boolean(config.notion.reportPageId),
    "notion",
    "NOTION_REPORT_PAGE_ID is not set",
    false,
  );

  return problems;
}

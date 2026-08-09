import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkReadiness, loadConfig } from "./config.ts";
import { GitHubIntegration } from "./integrations/github.ts";
import { JiraIntegration } from "./integrations/jira.ts";
import { NetlifyIntegration } from "./integrations/netlify.ts";
import { NotionIntegration } from "./integrations/notion.ts";
import { SwytchcodeClient } from "./swytch.ts";

/**
 * Verifies the whole setup before you rely on it in front of an audience.
 *
 * Two jobs: point the Jira integration at your actual Cloud site, then make one
 * real read against each service so a bad token surfaces now rather than
 * mid-demo.
 */

const MANIFEST_PATH = join(
  process.cwd(),
  ".swytchcode",
  "integrations",
  "manifest.json",
);

/**
 * Swytchcode resolves each integration's base URL from manifest.json, and the
 * Jira bundle ships the literal placeholder `https://your-domain.atlassian.net`
 * because a Cloud site is per-tenant. This rewrites that one field from
 * JIRA_BASE_URL, which is the fix the CLI docs prescribe.
 */
async function alignJiraEndpoint(baseUrl: string): Promise<string> {
  if (!baseUrl) return "skipped (JIRA_BASE_URL not set)";

  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf8");
  } catch {
    return `skipped (no manifest at ${MANIFEST_PATH}; run \`swytchcode get Jira\`)`;
  }

  const manifest = JSON.parse(raw) as Record<
    string,
    { production_endpoint?: string }
  >;
  const entry = manifest["Jira.jira"];
  if (!entry) return "skipped (Jira integration not installed)";

  if (entry.production_endpoint === baseUrl) return `already set to ${baseUrl}`;

  const previous = entry.production_endpoint ?? "(unset)";
  entry.production_endpoint = baseUrl;
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return `rewrote ${previous} -> ${baseUrl}`;
}

type CheckResult = { name: string; ok: boolean; detail: string };

async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const config = loadConfig();
const swytch = new SwytchcodeClient();

console.log("Release Sentinel preflight\n");

console.log(`jira endpoint: ${await alignJiraEndpoint(config.jira.baseUrl)}\n`);

const readiness = checkReadiness(config);
if (readiness.length > 0) {
  console.log("configuration gaps:");
  for (const problem of readiness) {
    console.log(
      `  ${problem.blocking ? "[blocking]" : "[degraded]"} ${problem.service}: ${problem.detail}`,
    );
  }
  console.log("");
}

const github = new GitHubIntegration(swytch, config);
const jira = new JiraIntegration(swytch, config);
const netlify = new NetlifyIntegration(swytch, config);
const notion = new NotionIntegration(swytch, config);

const results: CheckResult[] = [];

results.push(
  await check("github", async () => {
    const commits = await github.listCommits(
      new Date(Date.now() - 365 * 24 * 60 * 60_000),
      3,
    );
    if (commits.length === 0) return "reachable, but the branch has no commits";
    const head = commits[0];
    return `head ${head?.shortSha} "${head?.message?.slice(0, 60)}" by ${head?.author}`;
  }),
);

results.push(
  await check("netlify", async () => {
    if (!netlify.configured) return "skipped (not configured)";
    const site = await netlify.getSite();
    const deploys = await netlify.listDeploys(5);
    const lastGood = await netlify.lastGoodDeploy();
    return `site "${site.name}" (${site.url}), ${deploys.length} recent deploy(s), rollback target ${lastGood?.id ?? "none"}`;
  }),
);

results.push(
  await check("jira", async () => {
    if (!jira.configured) return "skipped (not configured)";
    // A create is the only way to prove the project key, issue type and ADF
    // format all work. The throwaway ticket is labelled so it is easy to find.
    const issue = await jira.createIssue({
      summary: "Release Sentinel preflight check",
      description:
        "Created by `npm run preflight` to verify Jira credentials, project key and issue type. Safe to delete.",
      labels: ["release-sentinel", "preflight"],
    });
    return `created ${issue.key} (${issue.url}) - delete it when you are done`;
  }),
);

results.push(
  await check("notion", async () => {
    if (!notion.configured) return "skipped (not configured)";
    const workspace = await notion.whoAmI();
    const appended = await notion.appendReport(
      `## Release Sentinel preflight\n\nConnectivity verified at ${new Date().toISOString()}.\n\n---\n\n`,
    );
    if (!appended.ok) {
      throw new Error(
        `token valid for "${workspace}" but the report write failed: ${appended.detail ?? "unknown"}. Confirm the page is shared with the integration.`,
      );
    }
    return `workspace "${workspace}", report written via ${appended.via}`;
  }),
);

results.push(
  await check("llm", async () => {
    if (!config.llm.apiKey) return "skipped (not configured)";
    const { RiskAssessor } = await import("./agent/risk.ts");
    const assessor = new RiskAssessor(config);
    const verdict = await assessor.assess(
      [
        {
          sha: "0".repeat(40),
          shortSha: "0000000",
          message: "chore: preflight probe",
          author: "preflight",
          url: "",
          committedAt: new Date().toISOString(),
          additions: 1,
          deletions: 0,
          files: [
            { filename: "README.md", status: "modified", additions: 1, deletions: 0 },
          ],
          checks: { total: 0, failed: 0, pending: 0, combinedState: "success" },
          pullRequests: [],
        },
      ],
      {
        commitCount: 1,
        filesChanged: 1,
        additions: 1,
        deletions: 0,
        churn: 1,
        touchesConfig: false,
        touchesDependencies: false,
        touchesCi: false,
        touchesInfrastructure: false,
        hasRevert: false,
        hasHotfix: false,
        failedChecks: 0,
        pendingChecks: 0,
        combinedCheckState: "success",
        largestFile: "README.md",
        riskySignals: [],
      },
    );
    if (verdict.degraded) throw new Error(`model unavailable: ${verdict.rationale}`);
    return `${config.llm.provider}:${config.llm.model} scored a trivial change ${verdict.riskScore}/100 -> ${verdict.action}`;
  }),
);

console.log("checks:");
for (const result of results) {
  console.log(`  ${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed.`,
);

// Setting exitCode rather than calling process.exit() lets Node close its
// handles cleanly; forcing exit here trips a libuv assertion on Windows.
process.exitCode = failed.length > 0 ? 1 : 0;

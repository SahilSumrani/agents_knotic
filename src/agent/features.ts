import type { EnrichedCommit, RiskFeatures } from "../types.ts";

/**
 * Turns raw commit data into the evidence the risk model reasons over.
 *
 * Extracting these deterministically (rather than handing the model a diff and
 * hoping) keeps scoring reproducible, keeps token usage bounded, and means the
 * heuristic fallback in risk.ts has the same inputs the LLM does.
 */

const CONFIG_PATTERNS = [
  /(^|\/)netlify\.toml$/i,
  /(^|\/)vercel\.json$/i,
  /(^|\/)\.env/i,
  /(^|\/)[\w.-]*config\.(js|ts|json|yaml|yml|toml)$/i,
  /(^|\/)tsconfig[\w.]*\.json$/i,
];

const DEPENDENCY_PATTERNS = [
  /(^|\/)package\.json$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)requirements.*\.txt$/i,
  /(^|\/)go\.(mod|sum)$/i,
  /(^|\/)Cargo\.(toml|lock)$/i,
];

const CI_PATTERNS = [/(^|\/)\.github\/workflows\//i, /(^|\/)\.gitlab-ci\.yml$/i];

const INFRA_PATTERNS = [
  /(^|\/)Dockerfile$/i,
  /(^|\/)docker-compose\.ya?ml$/i,
  /\.tf$/i,
  /(^|\/)k8s\//i,
  /(^|\/)helm\//i,
  /(^|\/)migrations?\//i,
];

function matchesAny(filename: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(filename));
}

export function extractFeatures(commits: EnrichedCommit[]): RiskFeatures {
  const files = commits.flatMap((commit) => commit.files);
  const uniqueFiles = new Set(files.map((file) => file.filename));

  const additions = commits.reduce((total, commit) => total + commit.additions, 0);
  const deletions = commits.reduce((total, commit) => total + commit.deletions, 0);

  const touchesConfig = files.some((file) =>
    matchesAny(file.filename, CONFIG_PATTERNS),
  );
  const touchesDependencies = files.some((file) =>
    matchesAny(file.filename, DEPENDENCY_PATTERNS),
  );
  const touchesCi = files.some((file) => matchesAny(file.filename, CI_PATTERNS));
  const touchesInfrastructure = files.some((file) =>
    matchesAny(file.filename, INFRA_PATTERNS),
  );

  const messages = commits.map((commit) => commit.message.toLowerCase());
  const hasRevert = messages.some((message) => /\brevert\b/.test(message));
  const hasHotfix = messages.some((message) =>
    /\b(hotfix|hot-fix|urgent|emergency|wip)\b/.test(message),
  );

  const failedChecks = commits.reduce(
    (total, commit) => total + commit.checks.failed,
    0,
  );
  const pendingChecks = commits.reduce(
    (total, commit) => total + commit.checks.pending,
    0,
  );

  const largestFile =
    [...files]
      .sort(
        (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
      )[0]?.filename ?? null;

  const riskySignals: string[] = [];
  if (touchesDependencies) riskySignals.push("dependency manifest changed");
  if (touchesConfig) riskySignals.push("build or runtime config changed");
  if (touchesCi) riskySignals.push("CI workflow changed");
  if (touchesInfrastructure) riskySignals.push("infrastructure or migrations changed");
  if (hasRevert) riskySignals.push("commit message mentions a revert");
  if (hasHotfix) riskySignals.push("commit message signals urgency or work-in-progress");
  if (failedChecks > 0) riskySignals.push(`${failedChecks} failing check run(s)`);
  if (pendingChecks > 0) riskySignals.push(`${pendingChecks} check run(s) still pending`);
  if (additions + deletions > 800) riskySignals.push("large diff (>800 lines changed)");

  // The most recent commit's combined status best represents the tip being shipped.
  const combinedCheckState = commits[0]?.checks.combinedState ?? "unknown";

  return {
    commitCount: commits.length,
    filesChanged: uniqueFiles.size,
    additions,
    deletions,
    churn: additions + deletions,
    touchesConfig,
    touchesDependencies,
    touchesCi,
    touchesInfrastructure,
    hasRevert,
    hasHotfix,
    failedChecks,
    pendingChecks,
    combinedCheckState,
    largestFile,
    riskySignals,
  };
}

/**
 * Rule-based score used when the LLM is unavailable, and as a sanity floor on
 * the model's output so a confidently-wrong "SHIP" cannot override hard evidence
 * like a failing CI check.
 */
export function heuristicScore(features: RiskFeatures): number {
  let score = 10;

  if (features.failedChecks > 0) score += 45;
  if (features.pendingChecks > 0) score += 12;
  if (features.combinedCheckState === "failure") score += 25;

  if (features.touchesDependencies) score += 12;
  if (features.touchesConfig) score += 12;
  if (features.touchesCi) score += 8;
  if (features.touchesInfrastructure) score += 18;
  if (features.hasRevert) score += 10;
  if (features.hasHotfix) score += 15;

  if (features.churn > 2000) score += 20;
  else if (features.churn > 800) score += 12;
  else if (features.churn > 300) score += 6;

  if (features.filesChanged > 30) score += 10;
  else if (features.filesChanged > 10) score += 5;

  return Math.max(0, Math.min(100, score));
}

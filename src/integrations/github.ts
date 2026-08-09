import type { Config } from "../config.ts";
import type { SwytchcodeClient } from "../swytch.ts";
import type { CommitFile, CommitSummary, EnrichedCommit } from "../types.ts";
import { asArray, unwrap } from "./response.ts";

/**
 * GitHub reads used to build the release candidate.
 *
 * Uses the direct commits endpoint (`github.commit.get.1`) rather than the
 * commit *search* method, because search results are served from an index that
 * lags behind pushes by seconds to minutes — unusable when the whole point is
 * reacting to a commit that just landed.
 */

interface RawCommitListItem {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string };
}

interface RawCommitDetail {
  sha?: string;
  html_url?: string;
  stats?: { additions?: number; deletions?: number };
  files?: {
    filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
  }[];
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string };
}

export class GitHubIntegration {
  constructor(
    private readonly swytch: SwytchcodeClient,
    private readonly config: Config,
  ) {}

  private get auth(): string {
    return this.config.github.auth;
  }

  private get repoArgs(): { owner: string; repo: string } {
    return { owner: this.config.github.owner, repo: this.config.github.repo };
  }

  /** Commits on the tracked branch newer than `since`, newest first. */
  async listCommits(since: Date, limit: number): Promise<CommitSummary[]> {
    const raw = await this.swytch.call("github.commit.get.1", {
      ...this.repoArgs,
      sha: this.config.github.branch,
      since: since.toISOString(),
      per_page: limit,
      page: 1,
      Authorization: this.auth,
    });

    const items = asArray<RawCommitListItem>(unwrap("github list commits", raw));
    return items.filter((item) => item.sha).map((item) => toSummary(item));
  }

  /**
   * Diff stats plus CI signals for one commit. Check runs and combined status
   * are fetched tolerantly: a repo with no CI configured returns nothing useful
   * and must not fail the run.
   */
  async enrichCommit(summary: CommitSummary): Promise<EnrichedCommit> {
    const detailRaw = await this.swytch.call("github.commit.get.2", {
      ...this.repoArgs,
      ref: summary.sha,
      Authorization: this.auth,
    });
    const detail = unwrap<RawCommitDetail>("github get commit", detailRaw);

    const files: CommitFile[] = (detail.files ?? []).map((file) => ({
      filename: file.filename ?? "unknown",
      status: file.status ?? "modified",
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    }));

    const [checks, pullRequests] = await Promise.all([
      this.fetchChecks(summary.sha),
      this.fetchPullRequests(summary.sha),
    ]);

    return {
      ...summary,
      additions:
        detail.stats?.additions ??
        files.reduce((total, file) => total + file.additions, 0),
      deletions:
        detail.stats?.deletions ??
        files.reduce((total, file) => total + file.deletions, 0),
      files,
      checks,
      pullRequests,
    };
  }

  private async fetchChecks(ref: string): Promise<EnrichedCommit["checks"]> {
    const checks = { total: 0, failed: 0, pending: 0, combinedState: "unknown" };

    const runsResult = await this.swytch.tryCall("github.commit.checkRuns.get", {
      ...this.repoArgs,
      ref,
      per_page: 30,
      page: 1,
      Authorization: this.auth,
    });

    if (runsResult.ok) {
      const payload = unwrap<{ check_runs?: unknown }>(
        "github check runs",
        runsResult.value,
      );
      const runs = asArray<{ conclusion?: string; status?: string }>(
        payload?.check_runs ?? payload,
      );
      checks.total = runs.length;
      for (const run of runs) {
        if (run.status && run.status !== "completed") checks.pending += 1;
        else if (
          run.conclusion &&
          ["failure", "timed_out", "cancelled", "startup_failure"].includes(
            run.conclusion,
          )
        ) {
          checks.failed += 1;
        }
      }
    }

    const statusResult = await this.swytch.tryCall("github.commit.status.get", {
      ...this.repoArgs,
      ref,
      per_page: 30,
      page: 1,
      Authorization: this.auth,
    });

    if (statusResult.ok) {
      const combined = unwrap<{ state?: string }>(
        "github combined status",
        statusResult.value,
      );
      checks.combinedState = combined?.state ?? "unknown";
    }

    return checks;
  }

  private async fetchPullRequests(
    ref: string,
  ): Promise<EnrichedCommit["pullRequests"]> {
    const result = await this.swytch.tryCall("github.commit.pulls.get", {
      ...this.repoArgs,
      commit_sha: ref,
      per_page: 10,
      page: 1,
      Authorization: this.auth,
    });
    if (!result.ok) return [];

    const pulls = asArray<{ number?: number; title?: string; html_url?: string }>(
      unwrap("github commit pulls", result.value),
    );
    return pulls
      .filter((pull) => typeof pull.number === "number")
      .map((pull) => ({
        number: pull.number as number,
        title: pull.title ?? "(untitled)",
        url: pull.html_url ?? "",
      }));
  }
}

function toSummary(item: RawCommitListItem): CommitSummary {
  const sha = item.sha as string;
  const message = item.commit?.message ?? "";
  return {
    sha,
    shortSha: sha.slice(0, 7),
    // Commit bodies can be long; the subject line is what drives risk signals.
    message: message.split("\n")[0] ?? "",
    author: item.author?.login ?? item.commit?.author?.name ?? "unknown",
    url: item.html_url ?? "",
    committedAt: item.commit?.author?.date ?? new Date().toISOString(),
  };
}

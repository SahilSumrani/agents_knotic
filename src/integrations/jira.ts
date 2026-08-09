import type { Config } from "../config.ts";
import type { SwytchcodeClient } from "../swytch.ts";
import type { JiraIssueRef } from "../types.ts";
import { unwrap } from "./response.ts";

/**
 * Jira writes: the review ticket the agent files when it refuses to ship, and
 * the incident ticket it files after a rollback.
 *
 * Two Jira-specific details are handled here. The bundle targets REST v3, whose
 * text fields require Atlassian Document Format rather than plain strings; and
 * Jira Cloud authenticates with Basic (email + API token), not the bearer
 * placeholder the bundle ships, so `config.jira.auth` overrides it per call.
 */

/** Minimal ADF document: paragraphs, with blank lines dropped. */
function toAdf(text: string): unknown {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : ["(no detail)"]).map(
      (block) => ({
        type: "paragraph",
        content: [{ type: "text", text: block }],
      }),
    ),
  };
}

export class JiraIntegration {
  constructor(
    private readonly swytch: SwytchcodeClient,
    private readonly config: Config,
  ) {}

  get configured(): boolean {
    const { auth, baseUrl, projectKey } = this.config.jira;
    return Boolean(auth && baseUrl && projectKey);
  }

  /**
   * Creates an issue. Labels are best-effort: some projects restrict the field,
   * and losing a label must not cost us the ticket, so a rejected create is
   * retried once without them.
   */
  async createIssue(input: {
    summary: string;
    description: string;
    labels?: string[];
  }): Promise<JiraIssueRef> {
    const { projectKey, taskIssueType, useAdf } = this.config.jira;

    const buildFields = (withLabels: boolean): Record<string, unknown> => ({
      project: { key: projectKey },
      summary: input.summary.slice(0, 250),
      description: useAdf ? toAdf(input.description) : input.description,
      issuetype: { name: taskIssueType },
      ...(withLabels && input.labels?.length ? { labels: input.labels } : {}),
    });

    let raw: unknown;
    try {
      raw = await this.create(buildFields(true));
    } catch (error) {
      if (!input.labels?.length) throw error;
      raw = await this.create(buildFields(false));
    }

    const issue = unwrap<{ key?: string; id?: string }>("jira create issue", raw);
    const key = issue?.key ?? "";
    return {
      key,
      id: issue?.id ?? "",
      url: key ? `${this.config.jira.baseUrl}/browse/${key}` : "",
    };
  }

  private create(fields: Record<string, unknown>): Promise<unknown> {
    // Writes are not retried: a duplicated ticket is worse than a failed one.
    return this.swytch.call(
      "jira.api.issue.create",
      { body: { fields }, Authorization: this.config.jira.auth },
      { maxAttempts: 1 },
    );
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    const { useAdf, auth } = this.config.jira;
    await this.swytch.call(
      "jira.api.comment.create",
      {
        issueIdOrKey: issueKey,
        body: { body: useAdf ? toAdf(text) : text },
        Authorization: auth,
      },
      { maxAttempts: 1 },
    );
  }

  /**
   * Linking is cosmetic, and the "Relates" link type is not guaranteed to exist
   * in every Jira project, so a failure here must not fail incident reporting.
   */
  async tryLink(inwardKey: string, outwardKey: string): Promise<boolean> {
    try {
      await this.linkIssues(inwardKey, outwardKey);
      return true;
    } catch {
      return false;
    }
  }

  /** Links the incident ticket back to the review ticket when both exist. */
  async linkIssues(
    inwardKey: string,
    outwardKey: string,
    linkType = "Relates",
  ): Promise<void> {
    await this.swytch.call(
      "jira.api.issueLink.create",
      {
        body: {
          type: { name: linkType },
          inwardIssue: { key: inwardKey },
          outwardIssue: { key: outwardKey },
        },
        Authorization: this.config.jira.auth,
      },
      { maxAttempts: 1 },
    );
  }
}

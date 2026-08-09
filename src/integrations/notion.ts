import type { Config } from "../config.ts";
import type { SwytchcodeClient } from "../swytch.ts";
import { unwrap } from "./response.ts";

/**
 * Notion reporting.
 *
 * The Notion bundle in the registry has unresolved response structs for most
 * page/block write methods, so `notion.page.create` and `notion.children.update`
 * cannot be enabled at all. What does work is `notion.markdown.update`, which
 * appends Markdown to an existing page — a better fit for release notes anyway,
 * since reports are authored as Markdown rather than assembled block-by-block.
 *
 * Consequence for setup: the agent appends to a page you create and share with
 * the integration; it does not create the page itself.
 *
 * The bundle types the `insert_content` payload as an opaque object with no
 * sub-schema, so the exact field name is not discoverable from `swytchcode info`.
 * We probe a small set of documented-looking shapes once, remember the one the
 * API accepts, and reuse it for the rest of the process.
 */

type PayloadBuilder = (markdown: string) => Record<string, unknown>;

const APPEND_PAYLOADS: { label: string; build: PayloadBuilder }[] = [
  {
    label: "insert_content.content",
    build: (markdown) => ({
      type: "insert_content",
      insert_content: { content: markdown, position: "end" },
    }),
  },
  {
    label: "insert_content.content(no position)",
    build: (markdown) => ({
      type: "insert_content",
      insert_content: { content: markdown },
    }),
  },
  {
    label: "insert_content.markdown",
    build: (markdown) => ({
      type: "insert_content",
      insert_content: { markdown },
    }),
  },
];

export class NotionIntegration {
  /** Cached winner from the shape probe, so we pay for it at most once. */
  private workingPayload: PayloadBuilder | undefined;

  constructor(
    private readonly swytch: SwytchcodeClient,
    private readonly config: Config,
  ) {}

  get configured(): boolean {
    return (
      this.config.notion.auth !== "Bearer " &&
      Boolean(this.config.notion.reportPageId)
    );
  }

  private get baseArgs(): Record<string, unknown> {
    return {
      page_id: this.config.notion.reportPageId,
      "Notion-Version": this.config.notion.version,
      Authorization: this.config.notion.auth,
    };
  }

  /**
   * Appends a Markdown report to the configured page. Falls back to posting the
   * report as a page comment, which uses a fully-specified schema and therefore
   * always works — a slightly worse-looking report beats no report during a demo.
   */
  async appendReport(markdown: string): Promise<{ ok: boolean; via: string; detail?: string }> {
    if (!this.configured) {
      return { ok: false, via: "none", detail: "notion not configured" };
    }

    if (this.workingPayload) {
      const result = await this.tryAppend(this.workingPayload, markdown);
      if (result.ok) return { ok: true, via: "markdown" };
    } else {
      for (const candidate of APPEND_PAYLOADS) {
        const result = await this.tryAppend(candidate.build, markdown);
        if (result.ok) {
          this.workingPayload = candidate.build;
          return { ok: true, via: `markdown (${candidate.label})` };
        }
      }
    }

    const comment = await this.addComment(markdown);
    return comment.ok
      ? { ok: true, via: "comment" }
      : { ok: false, via: "none", detail: comment.detail };
  }

  private async tryAppend(
    build: PayloadBuilder,
    markdown: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    const result = await this.swytch.tryCall(
      "notion.markdown.update",
      { ...this.baseArgs, body: build(markdown) },
      { maxAttempts: 1 },
    );
    if (!result.ok) return { ok: false, detail: result.error.message };

    try {
      unwrap("notion append markdown", result.value);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Notion caps a single rich-text run at 2000 characters. */
  private async addComment(text: string): Promise<{ ok: boolean; detail?: string }> {
    const result = await this.swytch.tryCall(
      "notion.comment.create",
      {
        "Notion-Version": this.config.notion.version,
        Authorization: this.config.notion.auth,
        body: {
          parent: { page_id: this.config.notion.reportPageId },
          rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
        },
      },
      { maxAttempts: 1 },
    );
    if (!result.ok) return { ok: false, detail: result.error.message };
    try {
      unwrap("notion create comment", result.value);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Confirms the token is valid and reports the integration's own identity. */
  async whoAmI(): Promise<string> {
    const raw = await this.swytch.call("notion.me.list", {
      "Notion-Version": this.config.notion.version,
      Authorization: this.config.notion.auth,
    });
    const me = unwrap<{ name?: string; bot?: { workspace_name?: string } }>(
      "notion me",
      raw,
    );
    return me?.bot?.workspace_name ?? me?.name ?? "unknown";
  }

  get pageUrl(): string {
    const id = this.config.notion.reportPageId.replace(/-/g, "");
    return id ? `https://www.notion.so/${id}` : "";
  }
}

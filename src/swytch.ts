import { exec } from "@swytchcode/runtime";
import { isSwytchcodeError } from "@swytchcode/runtime";
import type { ExecArgs } from "@swytchcode/runtime";
import type { SwytchcodeCallRecord } from "./types.ts";

/**
 * The single place in this codebase that talks to Swytchcode.
 *
 * Everything the agent does to GitHub, Jira, Netlify and Notion goes through
 * `call()`, so retry policy, timing, redaction and the audit trail are defined
 * exactly once instead of being sprinkled across the steps.
 */

/** Categories the CLI reports as transient; anything else needs human action. */
const RETRYABLE_CATEGORIES = new Set(["network", "rate_limit", "internal"]);

export interface CallOptions {
  /** Defaults to 3 for reads; writes should pass 1 to stay idempotent. */
  maxAttempts?: number;
  timeoutMs?: number;
  dryRun?: boolean;
}

export class IntegrationError extends Error {
  readonly canonicalId: string;
  readonly category: string;
  readonly retryable: boolean;

  constructor(
    canonicalId: string,
    message: string,
    category: string,
    retryable: boolean,
  ) {
    super(`${canonicalId}: ${message}`);
    this.name = "IntegrationError";
    this.canonicalId = canonicalId;
    this.category = category;
    this.retryable = retryable;
  }
}

export type CallRecorder = (record: SwytchcodeCallRecord) => void;

function integrationOf(canonicalId: string): string {
  return canonicalId.split(".")[0] ?? "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The CLI interleaves human-readable progress lines with its classified JSON
 * error on stderr, so the runtime's own parser (which requires stderr to be
 * pure JSON) falls back to the raw blob. Digging the JSON object out of the
 * noise turns a 6-line dump into one actionable sentence on the dashboard.
 */
function extractClassified(
  message: string,
): { error: string; category?: string; retryable?: boolean } | null {
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"error"')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.error === "string") return parsed;
    } catch {
      // Keep scanning; a later line may hold the real payload.
    }
  }
  return null;
}

function classify(error: unknown): { message: string; category: string; retryable: boolean } {
  if (isSwytchcodeError(error)) {
    const embedded = extractClassified(error.message);
    const category = error.details?.category ?? embedded?.category ?? "unknown";
    // Trust the CLI's own retryable flag when present, since it knows more
    // about the failure than a category name alone conveys.
    const retryable =
      error.details?.retryable ??
      embedded?.retryable ??
      RETRYABLE_CATEGORIES.has(category);
    const message = (embedded?.error ?? error.message)
      .replace(/\s*input validation failed:\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { message, category, retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, category: "unknown", retryable: false };
}

export class SwytchcodeClient {
  private recorder: CallRecorder | undefined;
  private readonly globalDryRun: boolean;

  constructor(options: { recorder?: CallRecorder; dryRun?: boolean } = {}) {
    this.recorder = options.recorder;
    this.globalDryRun = options.dryRun ?? false;
  }

  /** Lets the pipeline attach its own audit trail to an injected client. */
  setRecorder(recorder: CallRecorder): void {
    this.recorder = recorder;
  }

  /**
   * Execute one Swytchcode method. Retries only failures the kernel marks as
   * transient, with exponential backoff, and records every attempt so the
   * dashboard can show the real integration call count.
   */
  async call<T = unknown>(
    canonicalId: string,
    args: ExecArgs,
    options: CallOptions = {},
  ): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const startedAt = Date.now();
    let attempts = 0;
    let lastError: unknown;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const result = await exec(canonicalId, args, {
          timeoutMs: options.timeoutMs ?? 60_000,
          dryRun: options.dryRun ?? this.globalDryRun,
        });
        this.record({
          canonicalId,
          integration: integrationOf(canonicalId),
          ok: true,
          durationMs: Date.now() - startedAt,
          attempts,
          at: new Date().toISOString(),
        });
        return result as T;
      } catch (error) {
        lastError = error;
        const { retryable } = classify(error);
        if (!retryable || attempts >= maxAttempts) break;
        await sleep(400 * 2 ** (attempts - 1));
      }
    }

    const { message, category, retryable } = classify(lastError);
    this.record({
      canonicalId,
      integration: integrationOf(canonicalId),
      ok: false,
      durationMs: Date.now() - startedAt,
      attempts,
      at: new Date().toISOString(),
      error: message,
    });
    throw new IntegrationError(canonicalId, message, category, retryable);
  }

  /**
   * For steps that should degrade rather than abort the run — a missing Notion
   * token should not prevent a rollback from being reported elsewhere.
   */
  async tryCall<T = unknown>(
    canonicalId: string,
    args: ExecArgs,
    options: CallOptions = {},
  ): Promise<{ ok: true; value: T } | { ok: false; error: IntegrationError }> {
    try {
      return { ok: true, value: await this.call<T>(canonicalId, args, options) };
    } catch (error) {
      if (error instanceof IntegrationError) return { ok: false, error };
      throw error;
    }
  }

  protected record(record: SwytchcodeCallRecord): void {
    this.recorder?.(record);
  }
}

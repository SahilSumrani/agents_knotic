import type { Config } from "./config.ts";
import type { HealthCheckResult } from "./types.ts";

/**
 * The post-deploy smoke test.
 *
 * Netlify never publishes a build that exits non-zero, so polling the deploy
 * state only ever catches build failures. The failure that actually reaches
 * users is the other one: a green build that serves a broken page. This fetches
 * the deployed site and asserts it answers 2xx with the expected marker, which
 * is the class of failure a state poll can never see.
 */

/** The slice of an HTTP response the check needs; injectable for the selftest. */
export type SiteFetch = (
  url: string,
  timeoutMs: number,
) => Promise<{ status: number; body: string }>;

export const fetchSite: SiteFetch = async (url, timeoutMs) => {
  const response = await fetch(url, {
    redirect: "follow",
    // Netlify's CDN would happily hand back the deploy we just replaced.
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.text() };
};

export async function checkSiteHealth(
  url: string,
  config: Config["health"],
  deps: {
    fetchSite?: SiteFetch;
    onAttempt?: (attempt: number, reason: string) => void;
  } = {},
): Promise<HealthCheckResult> {
  const request = deps.fetchSite ?? fetchSite;
  let reason = "the site was never fetched";

  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      const { status, body } = await request(url, config.timeoutMs);
      if (status < 200 || status >= 300) {
        reason = `HTTP ${status}`;
      } else if (!body.includes(config.marker)) {
        reason = `HTTP ${status} but the page did not contain "${config.marker}"`;
      } else {
        return { healthy: true, url, attempts: attempt, marker: config.marker };
      }
    } catch (error) {
      reason = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    deps.onAttempt?.(attempt, reason);
    if (attempt < config.attempts) {
      await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs));
    }
  }

  return {
    healthy: false,
    url,
    attempts: config.attempts,
    marker: config.marker,
    reason,
  };
}

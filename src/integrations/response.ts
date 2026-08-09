/**
 * The kernel returns a normalized envelope and exits 0 even for API-level
 * errors (the docs say to check `status_code` in the JSON). These helpers pull
 * the payload out of whichever envelope shape came back and turn a 4xx/5xx into
 * a thrown error, so callers can treat a resolved promise as real data.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(context: string, status: number, payload: unknown) {
    super(`${context} failed with status ${status}: ${summarize(payload)}`);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function summarize(payload: unknown): string {
  if (payload == null) return "<empty>";
  if (typeof payload === "string") return payload.slice(0, 400);
  try {
    return JSON.stringify(payload).slice(0, 400);
  } catch {
    return String(payload);
  }
}

const ENVELOPE_STATUS_KEYS = ["status_code", "statusCode", "status"];
const ENVELOPE_BODY_KEYS = ["body", "data", "response", "result"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts the API payload and validates the status code when the kernel
 * surfaces one. Unknown shapes pass through untouched rather than being
 * rejected, so a bundle that returns a bare body still works.
 */
export function unwrap<T>(context: string, raw: unknown): T {
  if (!isRecord(raw)) return raw as T;

  let status: number | undefined;
  for (const key of ENVELOPE_STATUS_KEYS) {
    const value = raw[key];
    if (typeof value === "number") {
      status = value;
      break;
    }
  }

  let payload: unknown = raw;
  let unwrapped = false;
  if (status !== undefined) {
    for (const key of ENVELOPE_BODY_KEYS) {
      if (key in raw) {
        payload = raw[key];
        unwrapped = true;
        break;
      }
    }
  }

  if (status !== undefined && (status < 200 || status >= 300)) {
    throw new ApiError(context, status, payload);
  }

  // A payload that is a JSON string (some bundles pass bodies through as text)
  // still needs parsing before callers can read fields off it.
  if (unwrapped && typeof payload === "string") {
    const text = payload.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return payload as T;
      }
    }
  }

  return payload as T;
}

export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value)) {
    // GitHub search-style responses nest the list under `items`.
    for (const key of ["items", "values", "results", "deploys"]) {
      const nested = value[key];
      if (Array.isArray(nested)) return nested as T[];
    }
  }
  return [];
}

/**
 * notifier.ts -- lightweight HTTP notifier for billing events.
 *
 * Sends a JSON POST to pi-remote (http://localhost:7681/api/notify) which
 * then broadcasts the payload to all connected WebSocket clients (toast +
 * system notification in the browser).
 *
 * This module is intentionally pure: importing it has zero side effects,
 * no top-level await, no eager network calls. The single export, sendNotify(),
 * is fire-and-forget from the caller's perspective -- it never throws.
 *
 * Auth: shared secret via the X-Notify-Token header. The token is read from
 * PI_REMOTE_NOTIFY_TOKEN (set in the extension's environment) by default, and
 * can be overridden per-call for tests.
 */

const DEFAULT_URL = "http://localhost:7681/api/notify";
const DEFAULT_TIMEOUT_MS = 3000;

export type NotifyPayload = {
  type: "billing:window_reset";
  provider: string;
  title: string;
  body: string;
  timestamp: number;
};

export type NotifyOptions = {
  url?: string;
  token?: string;
  timeoutMs?: number;
};

export type NotifyResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

function resolveUrl(opts?: NotifyOptions): string | null {
  const url = opts?.url ?? DEFAULT_URL;
  if (typeof url !== "string" || url.length === 0) return null;
  return url;
}

function resolveToken(opts?: NotifyOptions): string | null {
  // Explicit option wins. Otherwise look at env. Empty string is treated as
  // "no token" (we won't send the header at all).
  const fromOpts = opts?.token;
  if (typeof fromOpts === "string" && fromOpts.length > 0) return fromOpts;
  const fromEnv = process.env.PI_REMOTE_NOTIFY_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return null;
}

function resolveTimeout(opts?: NotifyOptions): number {
  const t = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return t;
}

/**
 * POST the payload to pi-remote. Never throws -- all failure modes are
 * surfaced through the returned object so callers can use it as a true
 * fire-and-forget (e.g. `void sendNotify(...)`).
 *
 * Failure modes (all -> { ok: false }):
 *   - url is empty                  -> { error: "no url" }
 *   - HTTP response with non-2xx    -> { status, error: "http <code>" }
 *   - fetch rejected (network)      -> { error: e.message }
 *   - AbortController timeout       -> { error: "timeout" } (or fetch's own error)
 *
 * Success -> { ok: true, status }.
 */
export async function sendNotify(
  payload: NotifyPayload,
  options?: NotifyOptions,
): Promise<NotifyResult> {
  const url = resolveUrl(options);
  if (url === null) {
    return { ok: false, error: "no url" };
  }

  const token = resolveToken(options);
  const timeoutMs = resolveTimeout(options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token !== null) {
    headers["X-Notify-Token"] = token;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    const message =
      err && typeof err.message === "string" && err.message.length > 0
        ? err.name === "AbortError"
          ? "timeout"
          : err.message
        : "network error";
    try {
      console.warn(`[notifier] send failed: ${message}`);
    } catch {}
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const code = response.status;
    try {
      console.warn(`[notifier] non-2xx response: ${code}`);
    } catch {}
    return { ok: false, status: code, error: `http ${code}` };
  }

  return { ok: true, status: response.status };
}

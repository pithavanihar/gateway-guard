import { GatewayRequestError, TimeoutError } from "./errors.js";
import type { GatewayName } from "./types.js";

export interface HttpDeps {
  fetch: typeof fetch;
  timeoutMs: number;
}

/**
 * Performs a request and parses a JSON response.
 *
 * Errors carry only the gateway name, HTTP status and a fixed reason string. Request
 * headers (credentials), request bodies and response bodies are never put into an
 * error, so callers can log errors safely.
 */
export async function fetchJson<T>(
  gateway: GatewayName,
  url: string,
  init: RequestInit,
  deps: HttpDeps,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rejects even if the injected fetch ignores the abort signal.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(gateway));
    }, deps.timeoutMs);
  });

  try {
    let res: Response;
    try {
      res = await Promise.race([deps.fetch(url, { ...init, signal: controller.signal }), timeout]);
    } catch (err) {
      if (err instanceof TimeoutError || controller.signal.aborted) throw new TimeoutError(gateway);
      throw new GatewayRequestError(gateway, null, "gateway", "network");
    }

    if (!res.ok) {
      // Drain the body so the connection can be reused; its content is not exposed.
      await Promise.race([res.text(), timeout]).catch(() => undefined);
      throw new GatewayRequestError(
        gateway,
        res.status,
        res.status >= 500 ? "gateway" : "unknown",
        `http_${res.status}`,
      );
    }

    let text: string;
    try {
      text = await Promise.race([res.text(), timeout]);
    } catch (err) {
      if (err instanceof TimeoutError || controller.signal.aborted) {
        throw new TimeoutError(gateway, res.status);
      }
      throw new GatewayRequestError(gateway, res.status, "gateway", "network");
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GatewayRequestError(gateway, res.status, "gateway", "invalid_json");
    }
  } finally {
    clearTimeout(timer);
  }
}

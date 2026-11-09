import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "../errors.js";

/**
 * Reads one header by name, case-insensitively. A missing, empty or repeated header
 * gives `undefined`, so callers treat it as absent.
 */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const v = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
    return v ? v : undefined;
  }
  return undefined;
}

/** Constant-time comparison; different lengths are a mismatch, never a RangeError. */
export function safeEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * The exact bytes of a webhook body. Signatures are computed over the raw request body, so
 * a parsed object (for example from `express.json()`) is rejected with a clear error.
 */
export function rawBodyBytes(rawBody: unknown): Uint8Array {
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (rawBody instanceof Uint8Array) return rawBody;
  throw new ValidationError("pass the raw request body");
}

import type { Context } from "hono";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function nowMs(): number {
  return Date.now();
}

export function floorTo(value: number, interval: number): number {
  return Math.floor(value / interval) * interval;
}

export function toIso(value: number): string {
  return new Date(value).toISOString();
}

export function parseCloudflareTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stableId(...parts: Array<string | number | null | undefined>): string {
  const source = parts.map((part) => String(part ?? "")).join("\u001f");
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

export function encodeCursor(value: { occurredAt: number; id: string }): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursor(value: string | undefined): { occurredAt: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    const record = asRecord(parsed);
    const occurredAt = asNumber(record.occurredAt);
    const id = asString(record.id);
    return occurredAt !== null && id !== null ? { occurredAt, id } : null;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [REDACTED]").slice(0, 500);
}

export function jsonError(
  context: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return context.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

export function parseCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function parseTimeRange(from: string | undefined, to: string | undefined): { from: number; to: number } {
  const parsedTo = to ? Date.parse(to) : nowMs();
  const parsedFrom = from ? Date.parse(from) : parsedTo - DAY_MS;
  if (!Number.isFinite(parsedFrom) || !Number.isFinite(parsedTo) || parsedFrom >= parsedTo) {
    throw new Error("时间范围无效");
  }
  return { from: parsedFrom, to: parsedTo };
}

export function dayKey(timestamp = nowMs()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

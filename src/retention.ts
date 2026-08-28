// cx-agent retention — prune old jobs, redact creds.

import { readdirSync, unlinkSync, statSync, existsSync, readFileSync } from "node:fs";
import { joinFs } from "./paths.js";

const META_SUFFIX = ".meta.json";
const JSONL_SUFFIX = ".jsonl";

export interface RetentionPolicy {
  maxAgeDays: number;
  maxCount: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxAgeDays: 14,
  maxCount: 500,
};


export function retainJobs(root: string, policy: RetentionPolicy = DEFAULT_RETENTION, now: number = Date.now()): string[] {
  if (!existsSync(root)) return [];
  const entries: { jobId: string; metaPath: string; jsonlPath: string | null; mtimeMs: number }[] = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith(META_SUFFIX) && !f.endsWith(JSONL_SUFFIX)) continue;
    const full = joinFs(root, f);
    let mtimeMs: number;
    try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
    const jobId = f.endsWith(META_SUFFIX) ? f.slice(0, -META_SUFFIX.length) : f.slice(0, -JSONL_SUFFIX.length);
    entries.push({ jobId, metaPath: joinFs(root, `${jobId}${META_SUFFIX}`), jsonlPath: joinFs(root, `${jobId}${JSONL_SUFFIX}`), mtimeMs });
  }
  const byId = new Map<string, { jobId: string; metaPath: string; jsonlPath: string | null; mtimeMs: number }>();
  for (const e of entries) {
    const cur = byId.get(e.jobId);
    if (!cur || e.mtimeMs > cur.mtimeMs) byId.set(e.jobId, e);
  }
  let jobs = [...byId.values()];
  const removed: string[] = [];
  const isRunning = (j: { metaPath: string }): boolean => {
    try {
      const meta = JSON.parse(readFileSync(j.metaPath, "utf8")) as { status?: unknown };
      return meta.status === "running";
    } catch { return false; }
  };
  jobs = jobs.filter((j) => !isRunning(j));

  if (policy.maxAgeDays > 0) {
    const cutoff = now - policy.maxAgeDays * 86_400_000;
    const aged = jobs.filter((j) => j.mtimeMs < cutoff);
    for (const j of aged) removeJob(j, removed);
    jobs = jobs.filter((j) => j.mtimeMs >= cutoff);
  }
  if (policy.maxCount > 0 && jobs.length > policy.maxCount) {
    jobs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const excess = jobs.slice(policy.maxCount);
    for (const j of excess) removeJob(j, removed);
  }
  return removed;
}

function removeJob(j: { jobId: string; metaPath: string; jsonlPath: string | null }, removed: string[]): void {
  for (const p of [j.metaPath, j.jsonlPath]) {
    if (!p) continue;
    try { if (existsSync(p)) unlinkSync(p); } catch { /* locked file on Windows, skip */ }
  }
  removed.push(j.jobId);
}

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_\-]{8,}/g },
  { name: "gateway-local-token", re: /sk-cx-[A-Za-z0-9_\-]{4,}/g },
  { name: "generic-sk", re: /\bsk-[A-Za-z0-9]{12,}\b/g },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9_\-\.=]{12,}/gi },
  { name: "auth-header", re: /Authorization\s*:\s*[A-Za-z0-9_\-\.=]{8,}/gi },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g },
  { name: "aws", re: /AKIA[0-9A-Z]{12,}/g },
  { name: "github-pat", re: /gh[pousr]_[A-Za-z0-9]{16,}/g },
];

const REDACTED = "[REDACTED]";

/** Strip credential-shaped substrings from text. Idempotent. */
export function redactText(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const { re } of SECRET_PATTERNS) { out = out.replace(re, REDACTED); }
  return out;
}

const SENSITIVE_KEYS = new Set([
  "token", "auth_token", "accesstoken", "access_token",
  "refreshtoken", "refresh_token", "apikey", "api_key",
  "secret", "secretkey", "secret_key", "clientsecret", "client_secret",
  "authorization", "password", "passwd", "x-api-key",
  "anthropic_auth_token", "anthropic_api_key",
]);

const NEVER_REDACT_KEYS = new Set([
  "input_tokens", "output_tokens", "cache_creation_input_tokens",
  "cache_read_input_tokens", "server_tool_use", "service_tier",
  "tokens", "usage", "apikeysource",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const n = normalizeKey(key);
  if (NEVER_REDACT_KEYS.has(n)) return false;
  return SENSITIVE_KEYS.has(n);
}

/** Recursively sanitize an SDK message payload before persistence. */
export function redactPayload(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactPayload(child);
    }
    return out;
  }
  return value;
}

/** True if text contains a credential-shaped substring. */
export function looksSecret(text: string): boolean {
  if (!text) return false;
  for (const { re } of SECRET_PATTERNS) { re.lastIndex = 0; if (re.test(text)) return true; }
  return false;
}

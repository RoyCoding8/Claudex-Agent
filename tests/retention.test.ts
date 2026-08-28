import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainJobs, redactText, redactPayload, looksSecret, DEFAULT_RETENTION } from "../src/retention.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cxagent-retention-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function jobFiles(jobId: string) {
  return [join(root, `${jobId}.meta.json`), join(root, `${jobId}.jsonl`)];
}
function writeJob(jobId: string, mtimeMsOffset: number) {
  for (const p of jobFiles(jobId)) writeFileSync(p, "{}");
  const ts = new Date(mtimeMsOffset);
  for (const p of jobFiles(jobId)) {
    const fd = (require("fs").openSync(p, "r+"));
    require("fs").utimesSync(p, ts, ts);
    require("fs").closeSync(fd);
  }
}

describe("retainJobs", () => {
  it("prunes jobs older than the age cap", () => {
    const now = Date.parse("2026-08-08T12:00:00Z");
    const fresh = now - 1 * 86_400_000; // 1 day ago
    const stale = now - 20 * 86_400_000; // 20 days ago, past 14d cap
    writeJob("fresh", fresh);
    writeJob("stale", stale);
    const removed = retainJobs(root, { maxAgeDays: 14, maxCount: 0 }, now);
    expect(removed).toContain("stale");
    expect(removed).not.toContain("fresh");
    expect(existsSync(join(root, "fresh.meta.json"))).toBe(true);
    expect(existsSync(join(root, "stale.meta.json"))).toBe(false);
  });

  it("never prunes a running job even when it is beyond the age cap", () => {
    const now = Date.parse("2026-08-08T12:00:00Z");
    writeJob("still-running", now - 20 * 86_400_000);
    writeFileSync(join(root, "still-running.meta.json"), JSON.stringify({ status: "running" }));
    const removed = retainJobs(root, { maxAgeDays: 14, maxCount: 1 }, now);
    expect(removed).not.toContain("still-running");
    expect(existsSync(join(root, "still-running.meta.json"))).toBe(true);
  });

  it("prunes oldest beyond the count cap", () => {
    // All jobs "now" — age cap won't fire; count cap keeps newest 2.
    const now = Date.parse("2026-08-08T12:00:00Z");
    writeJob("old", now - 3000);
    writeJob("mid", now - 2000);
    writeJob("new", now - 1000);
    const removed = retainJobs(root, { maxAgeDays: 0, maxCount: 2 }, now);
    expect(removed).toEqual(["old"]);
    expect(existsSync(join(root, "new.meta.json"))).toBe(true);
    expect(existsSync(join(root, "mid.meta.json"))).toBe(true);
    expect(existsSync(join(root, "old.meta.json"))).toBe(false);
  });

  it("removes both .meta.json and .jsonl for a pruned job", () => {
    const now = Date.parse("2026-08-08T12:00:00Z");
    writeJob("gone", now - 20 * 86_400_000);
    retainJobs(root, DEFAULT_RETENTION, now);
    expect(existsSync(join(root, "gone.meta.json"))).toBe(false);
    expect(existsSync(join(root, "gone.jsonl"))).toBe(false);
  });

  it("returns [] for a missing dir and does not throw", () => {
    expect(retainJobs(join(root, "nope"), DEFAULT_RETENTION)).toEqual([]);
  });

  it("ignores non-meta/jsonl files", () => {
    writeFileSync(join(root, "stray.txt"), "x");
    const now = Date.parse("2026-08-08T12:00:00Z");
    writeJob("real", now - 1000);
    const removed = retainJobs(root, { maxAgeDays: 0, maxCount: 0 }, now);
    expect(removed).toEqual([]);
    expect(existsSync(join(root, "stray.txt"))).toBe(true);
  });
});

describe("redactText", () => {
  it("strips sk-ant- and sk-cx- tokens", () => {
    const out = redactText("token was sk-ant-api03-xxxxxxxxxxxxxxxx and sk-cx-local-secret");
    expect(out).not.toContain("sk-ant");
    expect(out).not.toContain("sk-cx-local");
    expect(out).toContain("[REDACTED]");
  });

  it("strips Bearer and Authorization headers", () => {
    expect(redactText("Authorization: Bearer abc123def456ghi789jkl"))
      .not.toContain("abc123");
    expect(redactText("header Authorization: secretvalue1234567"))
      .not.toContain("secretvalue1234567");
  });

  it("strips JWT-shaped strings", () => {
    const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.c3VwZXJzZWNyZXRrZXk";
    const out = redactText(`jwt ${jwt} here`);
    expect(out).not.toContain(jwt);
  });

  it("strips GitHub PATs and AWS keys", () => {
    expect(redactText("ghp_" + "a".repeat(20))).not.toContain("ghp_");
    expect(redactText("AKIA" + "ABCDEFGHIJKLMNOP")).not.toContain("AKIA");
  });

  it("preserves ordinary paths and model names", () => {
    const txt = "Edited D:/AI/cx-agent/src/worker.ts using grok-4.5 via http://127.0.0.1:4000";
    expect(redactText(txt)).toBe(txt);
  });

  it("is idempotent (does not re-redact the marker)", () => {
    const once = redactText("key sk-ant-supersecretvalue1234");
    expect(redactText(once)).toBe(once);
  });

  it("returns empty string for null/undefined", () => {
    expect(redactText(null)).toBe("");
    expect(redactText(undefined)).toBe("");
    expect(redactText("")).toBe("");
  });
});

describe("looksSecret", () => {
  it("detects secrets", () => {
    expect(looksSecret("here: sk-ant-api03-xxxxxxxx")).toBe(true);
    expect(looksSecret("Bearer abc123def456ghi789jkl")).toBe(true);
  });
  it("does not flag clean text", () => {
    expect(looksSecret("just a normal path D:/AI/x")).toBe(false);
  });
});

describe("redactPayload", () => {
  it("redacts strings inside nested objects", () => {
    const out = redactPayload({ a: { b: "token sk-ant-secret1234567" } }) as { a: { b: string } };
    expect(out.a.b).toContain("[REDACTED]");
    expect(out.a.b).not.toContain("sk-ant");
  });
  it("masks values under sensitive keys regardless of shape", () => {
    const out = redactPayload({ api_key: "anything-here", Authorization: "x" }) as Record<string, string>;
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
  });
  it("redacts strings inside arrays", () => {
    const out = redactPayload(["ok", "key sk-ant-arraysecret12345"]) as string[];
    expect(out[1]).toContain("[REDACTED]");
    expect(out[0]).toBe("ok");
  });
  it("passes through numbers and nulls", () => {
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload(null)).toBe(null);
  });

  it("preserves usage token counters and apiKeySource (regression: B-02 substring match used to redact them)", () => {
    const usage = {
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 890,
      cache_read_input_tokens: 12,
      server_tool_use: { grep: { input_tokens: 3 } },
      service_tier: "standard",
    };
    const out = redactPayload(usage) as Record<string, unknown>;
    expect(out.input_tokens).toBe(1234);
    expect(out.output_tokens).toBe(567);
    expect(out.cache_creation_input_tokens).toBe(890);
    expect(out.cache_read_input_tokens).toBe(12);
    expect(out.server_tool_use).toEqual({ grep: { input_tokens: 3 } });
    expect(out.service_tier).toBe("standard");
  });

  it("redacts exact sensitive keys but not substring lookalikes", () => {
    const out = redactPayload({
      api_key: "leak-this",
      token: "leak-too",
      apiKeySource: "env", // must survive (never-redact)
      monkey: "keep",
      keyboard: "keep",
      turnkey: "keep",
      input_tokens: 10,
    }) as Record<string, unknown>;
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKeySource).toBe("env");
    expect(out.monkey).toBe("keep");
    expect(out.keyboard).toBe("keep");
    expect(out.turnkey).toBe("keep");
    expect(out.input_tokens).toBe(10);
  });
});

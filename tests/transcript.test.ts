import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, rmdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript, newJobId, type JobMeta } from "../src/transcript.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cxagent-transcript-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Transcript", () => {
  it("reports a missing metadata directory instead of reporting a successful write", () => {
    const transcript = new Transcript("missing-directory", { root });
    rmdirSync(root);
    expect(() => transcript.writeMeta({ job_id: "missing-directory", status: "completed", pool: "model", pool_resolved: [],
      cwd: root, started_at: "2026-11-05T00:00:00Z", ended_at: "2026-11-05T00:00:01Z", turns: 1, error: null,
    })).toThrow();
  });

  it("creates root dir and writes a .jsonl + .meta.json at the right paths", () => {
    const t = new Transcript("job-1", { root });
    t.append("system", { msg: "start" });
    const meta: JobMeta = {
      job_id: "job-1",
      status: "running",
      pool: "Worker lvl",
      pool_resolved: [],
      cwd: "D:/AI",
      started_at: "2026-08-08T00:00:00Z",
      ended_at: null,
      turns: 0,
      cost_usd: null,
      error: null,
    };
    t.writeMeta(meta);
    expect(existsSync(join(root, "job-1.jsonl"))).toBe(true);
    expect(existsSync(join(root, "job-1.meta.json"))).toBe(true);
  });

  it("append produces strictly increasing seq starting at 1, with ts/job_id filled", () => {
    const t = new Transcript("job-2", { root });
    const r1 = t.append("assistant", { text: "hi" }, "2026-08-08T00:00:01Z");
    const r2 = t.append("progress", { step: 2 }, "2026-08-08T00:00:02Z");
    const r3 = t.append("tool_use", { name: "Read" }, "2026-08-08T00:00:03Z");
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r3.seq).toBe(3);
    expect(r1.job_id).toBe("job-2");
    expect(r1.kind).toBe("assistant");
    expect(r2.ts).toBe("2026-08-08T00:00:02Z");
  });

  it("is append-only: round-trips all records in order", () => {
    const t = new Transcript("job-3", { root });
    t.append("system", { a: 1 }, "2026-08-08T00:00:00Z");
    t.append("assistant", { a: 2 }, "2026-08-08T00:00:01Z");
    t.append("result", { a: 3 }, "2026-08-08T00:00:02Z");
    const recs = t.records();
    expect(recs.map((r) => r.kind)).toEqual(["system", "assistant", "result"]);
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("writes and reads meta sidecar", () => {
    const t = new Transcript("job-4", { root });
    const meta: JobMeta = {
      job_id: "job-4",
      status: "completed",
      pool: "Worker lvl",
      pool_resolved: ["minimax-m2.5"],
      cwd: "D:/AI",
      started_at: "2026-08-08T00:00:00Z",
      ended_at: "2026-08-08T00:05:00Z",
      turns: 4,
      cost_usd: 0.001,
      error: null,
    };
    t.writeMeta(meta);
    const back = t.readMeta();
    expect(back).toEqual(meta);
  });

  it("readMeta returns null when no sidecar exists", () => {
    const t = new Transcript("job-5", { root });
    expect(t.readMeta()).toBeNull();
  });

  it("meta can transition running -> failed and overwrite", () => {
    const t = new Transcript("job-6", { root });
    t.writeMeta({
      job_id: "job-6", status: "running", pool: "Worker lvl", pool_resolved: [],
      cwd: "D:/AI", started_at: "2026-08-08T00:00:00Z", ended_at: null,
      turns: 0, cost_usd: null, error: null,
    });
    t.writeMeta({
      job_id: "job-6", status: "failed", pool: "Worker lvl", pool_resolved: [],
      cwd: "D:/AI", started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
      turns: 2, cost_usd: 0.0002, error: "boom",
    });
    const back = t.readMeta();
    expect(back?.status).toBe("failed");
    expect(back?.error).toBe("boom");
  });

  it("records() returns [] when the jsonl does not exist", () => {
    const t = new Transcript("job-7", { root });
    expect(t.records()).toEqual([]);
  });

  it("flushes per line: each append is independently visible on disk", () => {
    const t = new Transcript("job-8", { root });
    t.append("system", { n: 1 }, "2026-08-08T00:00:00Z");
        const raw1 = readFileSync(t.path, "utf8").trim().split("\n");
    expect(raw1.length).toBe(1);
    t.append("assistant", { n: 2 }, "2026-08-08T00:00:01Z");
    const raw2 = readFileSync(t.path, "utf8").trim().split("\n");
    expect(raw2.length).toBe(2);
  });

  it("writes the file into the dir mkdir created, even with a relative root + cwd drift (B-10)", () => {
    const relRoot = ".";
    const origCwd = process.cwd();
    process.chdir(root);
    try {
      const t = new Transcript("job-b10", { root: relRoot });
      const wander = mkdtempSync(join(tmpdir(), "cxagent-b10-wander-"));
      process.chdir(wander);
      t.append("system", { msg: "lands in the mkdir dir" }, "2026-08-08T00:00:00Z");
      t.writeMeta({
        job_id: "job-b10", status: "running", pool: "Worker lvl", pool_resolved: [],
        cwd: root, started_at: "2026-08-08T00:00:00Z", ended_at: null,
        turns: 0, cost_usd: null, error: null,
      });
      expect(existsSync(join(root, "job-b10.jsonl"))).toBe(true);
      expect(existsSync(join(root, "job-b10.meta.json"))).toBe(true);
      expect(existsSync(join(wander, "job-b10.jsonl"))).toBe(false);
      const recs = t.records();
      expect(recs.length).toBe(1);
      expect(recs[0].kind).toBe("system");
      process.chdir(origCwd);
      rmSync(wander, { recursive: true, force: true });
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("newJobId", () => {
  it("produces unique-ish ids with a readable timestamp prefix", () => {
    const a = newJobId();
    const b = newJobId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d{8}T\d{6}-[a-z0-9]+$/);
  });
});

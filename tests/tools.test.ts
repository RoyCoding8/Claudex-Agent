import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleRun,
  handleList,
  handleFetchJob,
  handleInterrupt,
  handleReply,
  handleSetup,
  makeMcpProgressSender,
  toSlimResult,
  runInputSchema,
  listInputSchema,
  fetchInputSchema,
  interruptInputSchema,
  type ToolHandlerExtra,
} from "../src/tools.js";
import { SessionStore } from "../src/session-store.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobMeta } from "../src/transcript.js";
import type { WorkerResult } from "../src/worker.js";

function extra(progressToken?: string | number): ToolHandlerExtra {
  return {
    progressToken,
    sendNotification: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
  };
}

describe("makeMcpProgressSender", () => {
  it("sends a notifications/progress with the right shape", async () => {
    const calls: unknown[] = [];
    const send = vi.fn().mockImplementation(async (n: unknown) => { calls.push(n); });
    const sender = makeMcpProgressSender(send, "tok-42");
    sender({ progressToken: "tok-42", progress: 3, message: "turn 1" });
        await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      method: "notifications/progress",
      params: { progressToken: "tok-42", progress: 3, message: "turn 1" },
    });
  });

  it("drops silently when no progressToken is provided", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sender = makeMcpProgressSender(send, undefined);
    sender({ progressToken: "x", progress: 1 } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows sendNotification errors (non-fatal)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("transport gone"));
    const sender = makeMcpProgressSender(send, "t");
    expect(() => sender({ progressToken: "t", progress: 1 })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("handleRun", () => {
  it("returns isError=true + status failed when worker fails", async () => {
    const fakeWorker = vi.fn().mockResolvedValue({
      status: "failed", result: "", job_id: "j1", pool_resolved: [], turns: 0,
      cost_usd: null, transcript_path: "/tmp/j.jsonl", error: "boom",
    });
    const out = await handleRun({ prompt: "x" }, extra("t"), { runWorker: fakeWorker });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content.text);
    expect(parsed).toEqual({ job_id: "j1", status: "failed", error: { code: "INTERNAL", message: "boom" }, resumable: false });
        expect(fakeWorker.mock.calls[0][0]).toMatchObject({ prompt: "x", progressToken: "t" });
    expect(typeof fakeWorker.mock.calls[0][0].sendProgress).toBe("function");
  });

  it("returns isError=false on completed", async () => {
    const fakeWorker = vi.fn().mockResolvedValue({
      status: "completed", result: "done", job_id: "j2", pool_resolved: [], turns: 1,
      cost_usd: 0.001, transcript_path: "/tmp/j.jsonl", error: null,
    });
    const out = await handleRun({ prompt: "x" }, extra(), { runWorker: fakeWorker });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.content.text)).toEqual({ job_id: "j2", result: "done" });
  });

  it("catches a thrown worker and returns isError (defends the never-throws invariant)", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("unexpected"));
    const out = await handleRun({ prompt: "x" }, extra(), { runWorker: throwing });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content.text).status).toBe("failed");
  });

      it("forwards disallowed_tools onto the WorkerInput (B-2)", async () => {
    const fakeWorker = vi.fn().mockResolvedValue({
      status: "completed", result: "ok", job_id: "j", pool_resolved: [], turns: 0,
      cost_usd: null, transcript_path: "/t/j.jsonl", error: null,
    });
    await handleRun({ prompt: "x", disallowed_tools: ["Bash", "WebFetch"] }, extra(), { runWorker: fakeWorker });
    expect(fakeWorker.mock.calls[0][0].disallowedTools).toEqual(["Bash", "WebFetch"]);
  });

          it("cancels the interrupt immediately when extra.signal is already aborted (B-11)", async () => {
    const fakeWorker = vi.fn().mockImplementation(async (input: { jobId?: string; prompt?: string }) => {
                              return {
        status: "interrupted", result: "", job_id: input.jobId ?? "j", pool_resolved: [], turns: 0,
        cost_usd: null, transcript_path: "/t/j.jsonl", error: "client cancellation",
      };
    });
    const registry: InterruptRegistry = new Map();
    const abortedExtra: ToolHandlerExtra = {
      progressToken: undefined,
      sendNotification: vi.fn().mockResolvedValue(undefined),
      signal: AbortSignal.abort(),
    };
    await handleRun({ prompt: "x" }, abortedExtra, { runWorker: fakeWorker, registry });
        expect(registry.size).toBe(0);
  });

          it("cleans up the registry entry even when the worker throws (B-11 finally)", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("boom between paths"));
    const registry: InterruptRegistry = new Map();
    await handleRun({ prompt: "x" }, extra(), { runWorker: throwing, registry });
        expect(registry.size).toBe(0);
  });
});

describe("handleList", () => {
  let root: string;
  it("lists jobs from .meta.json sidecars, most recent first", () => {
    root = mkdtempSync(join(tmpdir(), "cxagent-tools-"));
    const meta = (job_id: string, started: string, status: "running" | "completed"): JobMeta =>
      ({ job_id, status, pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI", started_at: started, ended_at: null, turns: 0, cost_usd: null, error: null });
    writeFileSync(join(root, "b.meta.json"), JSON.stringify(meta("job-b", "2026-08-08T00:00:00Z", "running")));
    writeFileSync(join(root, "a.meta.json"), JSON.stringify(meta("job-a", "2026-08-08T01:00:00Z", "completed")));
        writeFileSync(join(root, "stray.jsonl"), "noise");
    const out = handleList({ root });
    const text = out.content.text;
    expect(text).toContain("job-a");
    expect(text).toContain("job-b");
        expect(text.indexOf("job-a")).toBeLessThan(text.indexOf("job-b"));
  });

  it("returns 'No jobs.' when the dir is empty or missing", () => {
    const out = handleList({ root: "/nonexistent/zz" });
    expect(out.content.text).toBe("No jobs.");
  });

  it("skips parsed-but-invalid sidecars without breaking the list", () => {
    const invalidRoot = mkdtempSync(join(tmpdir(), "cxagent-invalid-meta-"));
    try {
      writeFileSync(join(invalidRoot, "null.meta.json"), "null");
      writeFileSync(join(invalidRoot, "number.meta.json"), "42");
      writeFileSync(join(invalidRoot, "missing-status.meta.json"), JSON.stringify({ job_id: "bad", pool: "Worker lvl" }));
      writeFileSync(join(invalidRoot, "valid.meta.json"), JSON.stringify({
        job_id: "good", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: null, turns: 1, cost_usd: null, error: null,
      }));
      const out = handleList({ root: invalidRoot });
      expect(out.content.text).toContain("good");
      expect(out.content.text).not.toContain("bad");
    } finally {
      rmSync(invalidRoot, { recursive: true, force: true });
    }
  });

          it("emits rows in header column order (B-5)", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-list-header-"));
    try {
      writeFileSync(join(root, "ord.meta.json"), JSON.stringify({
        job_id: "job-ord", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T01:00:00Z", ended_at: null, turns: 1, cost_usd: null, error: "boom-x",
      }));
      const out = handleList({ root });
      const lines = out.content.text.split("\n");
      expect(lines.length).toBe(2);
            expect(lines[0].trimStart().startsWith("job_id")).toBe(true);
      expect(lines[1].trimStart().startsWith("job-ord")).toBe(true);
            const idxId = lines[1].indexOf("job-ord");
      const idxStatus = lines[1].indexOf("completed");
      const idxStarted = lines[1].indexOf("2026-08-08T01:00:00Z");
      const idxPool = lines[1].indexOf("Worker lvl");
      const idxError = lines[1].indexOf("boom-x");
      expect(idxId).toBeLessThan(idxStatus);
      expect(idxStatus).toBeLessThan(idxStarted);
      expect(idxStarted).toBeLessThan(idxPool);
      expect(idxPool).toBeLessThan(idxError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("handleFetchJob", () => {
  it("returns only explicitly requested persisted fields", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-"));
    try {
      writeFileSync(join(root, "job-1.meta.json"), JSON.stringify({
        job_id: "job-1", status: "completed", pool: "Worker lvl", pool_resolved: ["kimi"],
        cwd: "D:/AI", started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 4, cost_usd: 0.123, error: null, result: "the complete answer",
      }));
      const out = handleFetchJob({ job_id: "job-1", fields: ["result", "turns"] }, { root });
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(out.content.text)).toEqual({ job_id: "job-1", result: "the complete answer", turns: 4 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults to status and error, and returns not_found for a missing job", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-default-"));
    try {
      writeFileSync(join(root, "job-2.meta.json"), JSON.stringify({
        job_id: "job-2", status: "failed", pool: "Worker lvl", pool_resolved: [],
        cwd: "D:/AI", started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 1, cost_usd: null, error: "boom", result: "",
      }));
      expect(JSON.parse(handleFetchJob({ job_id: "job-2" }, { root }).content.text))
        .toEqual({ job_id: "job-2", status: "failed", error: "boom" });
      const missing = handleFetchJob({ job_id: "missing" }, { root });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content.text).status).toBe("not_found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

          it("returns result: null when the meta sidecar has no result key (distinct from empty)", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-nullresult-"));
    try {
            const legacy: Record<string, unknown> = {
        job_id: "legacy", status: "completed", pool: "Worker lvl", pool_resolved: [],
        cwd: "D:/AI", started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 1, cost_usd: 0.1, error: null,
      };
      delete legacy.result;
      writeFileSync(join(root, "legacy.meta.json"), JSON.stringify(legacy));
      const out = JSON.parse(handleFetchJob({ job_id: "legacy", fields: ["result"] }, { root }).content.text);
      expect(out.result).toBeNull();
      expect(out).not.toHaveProperty("truncated");

            writeFileSync(join(root, "running.meta.json"), JSON.stringify({
        job_id: "running", status: "running", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: null, turns: 0, cost_usd: null, error: null,
        result: null,
      }));
      const out2 = JSON.parse(handleFetchJob({ job_id: "running", fields: ["result"] }, { root }).content.text);
      expect(out2.result).toBeNull();

            writeFileSync(join(root, "empty.meta.json"), JSON.stringify({
        job_id: "empty", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 0, cost_usd: null, error: null, result: "",
      }));
      const out3 = JSON.parse(handleFetchJob({ job_id: "empty", fields: ["result"] }, { root }).content.text);
      expect(out3.result).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

      it("falls back to the JSONL transcript's result record when the meta omits result", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-fallback-"));
    try {
      const legacy: Record<string, unknown> = {
        job_id: "fb", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 1, cost_usd: 0.1, error: null,
      };
      delete legacy.result;
      writeFileSync(join(root, "fb.meta.json"), JSON.stringify(legacy));
      writeFileSync(join(root, "fb.jsonl"), JSON.stringify({
        ts: "2026-08-08T00:01:00Z", job_id: "fb", seq: 5, kind: "result",
        payload: { status: "completed", result: "recovered from jsonl" },
      }) + "\n");
      const out = JSON.parse(handleFetchJob({ job_id: "fb", fields: ["result"] }, { root }).content.text);
      expect(out.result).toBe("recovered from jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

    it("returns usage counters from the meta sidecar (B-13)", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-usage-"));
    try {
      writeFileSync(join(root, "u.meta.json"), JSON.stringify({
        job_id: "u", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 2, cost_usd: 0.02, error: null, result: "ok",
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 75,
        },
      }));
      const out = JSON.parse(handleFetchJob({ job_id: "u", fields: ["usage"] }, { root }).content.text);
      expect(out.usage).toEqual({
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 75,
      });

            writeFileSync(join(root, "leg.meta.json"), JSON.stringify({
        job_id: "leg", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 0, cost_usd: null, error: null, result: "",
      }));
      const leg = JSON.parse(handleFetchJob({ job_id: "leg", fields: ["usage"] }, { root }).content.text);
      expect(leg.usage).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

      it("returns files_changed from the meta sidecar, defaulting to []", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-files-"));
    try {
      writeFileSync(join(root, "fc.meta.json"), JSON.stringify({
        job_id: "fc", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 3, error: null, result: "done",
        files_changed: ["a.ts", "b.ts"],
      }));
      const out = JSON.parse(handleFetchJob({ job_id: "fc", fields: ["files_changed"] }, { root }).content.text);
      expect(out.files_changed).toEqual(["a.ts", "b.ts"]);

            writeFileSync(join(root, "nofile.meta.json"), JSON.stringify({
        job_id: "nofile", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 0, error: null, result: "",
      }));
      const empty = JSON.parse(handleFetchJob({ job_id: "nofile", fields: ["files_changed"] }, { root }).content.text);
      expect(empty.files_changed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

      it("returns session_id from the meta sidecar, defaulting to null", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-sid-"));
    try {
      writeFileSync(join(root, "sid.meta.json"), JSON.stringify({
        job_id: "sid", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 1, error: null, result: "ok", session_id: "sdk-session-xyz",
      }));
      const out = JSON.parse(handleFetchJob({ job_id: "sid", fields: ["session_id"] }, { root }).content.text);
      expect(out.session_id).toBe("sdk-session-xyz");

            writeFileSync(join(root, "old.meta.json"), JSON.stringify({
        job_id: "old", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
        turns: 0, error: null, result: "",
      }));
      const old = JSON.parse(handleFetchJob({ job_id: "old", fields: ["session_id"] }, { root }).content.text);
      expect(old.session_id).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the resume/continuation fields and the caps the job ran under", () => {
    const root = mkdtempSync(join(tmpdir(), "cxagent-fetch-res-"));
    try {
      writeFileSync(join(root, "r1.meta.json"), JSON.stringify({
        job_id: "r1", status: "incomplete", pool: "Opus lvl", pool_resolved: [], cwd: "D:/AI/cx-agent/src",
        started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:05:00Z", turns: 150,
        error: "reached max_turns", result: "partial", session_id: "sid-1",
        resumable: true, resumed_from: "r0", continuations: 2, agent: "reviewer",
        max_turns: 50, timeout_ms: 900000, max_budget_usd: 1.25,
      }));
      const out = JSON.parse(handleFetchJob(
        { job_id: "r1", fields: ["resumable", "resumed_from", "continuations", "cwd", "agent", "budget"] },
        { root },
      ).content.text);
      expect(out.resumable).toBe(true);
      expect(out.resumed_from).toBe("r0");
      expect(out.continuations).toBe(2);
      expect(out.cwd).toBe("D:/AI/cx-agent/src");
      expect(out.agent).toBe("reviewer");
      expect(out.budget).toMatchObject({ max_turns: 50, timeout_ms: 900000, max_budget_usd: 1.25 });

                  writeFileSync(join(root, "r2.meta.json"), JSON.stringify({
        job_id: "r2", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
        started_at: "2026-08-08T00:00:00Z", ended_at: null, turns: 1, error: null, result: "ok",
        session_id: "sid-2",
      }));
      const back = JSON.parse(handleFetchJob({ job_id: "r2", fields: ["resumable", "continuations"] }, { root }).content.text);
      expect(back.resumable).toBe(true);
      expect(back.continuations).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("toSlimResult — partial-result envelope (B-03)", () => {
  it("returns {job_id,result} for completed", () => {
    const out = toSlimResult({ status: "completed", result: "all done", job_id: "j", pool_resolved: [], turns: 1, cost_usd: 0.1, transcript_path: "/t", error: null });
    expect(out).toEqual({ job_id: "j", result: "all done" });
  });
  it("includes a bounded excerpt + truncated flag on failed with partial text", () => {
    const big = "x".repeat(5000);
    const out = toSlimResult({ status: "failed", result: big, job_id: "j", pool_resolved: [], turns: 9, cost_usd: 0.1, transcript_path: "/t", error: "boom" }) as Record<string, unknown>;
    expect(out.status).toBe("failed");
    expect((out.error as { code: string }).code).toBe("INTERNAL");
    expect((out.error as { message: string }).message).toBe("boom");
    expect(out.truncated).toBe(true);
    expect((out.result as string).length).toBeLessThan(big.length);
  });
  it("omits result/truncated when the worker produced no text (hard failure)", () => {
    const out = toSlimResult({ status: "failed", result: "", job_id: "j", pool_resolved: [], turns: 0, cost_usd: null, transcript_path: "/t", error: "spawn ENOENT" }) as Record<string, unknown>;
    expect(out.status).toBe("failed");
    expect((out.error as { code: string }).code).toBe("INTERNAL");
    expect((out.error as { message: string }).message).toBe("spawn ENOENT");
    expect(out).not.toHaveProperty("result");
    expect(out).not.toHaveProperty("truncated");
  });
  it("maps incomplete (error_max_turns) as its own status with partial text", () => {
    const out = toSlimResult({ status: "incomplete", result: "partial work done", job_id: "j", pool_resolved: [], turns: 50, cost_usd: 0.2, transcript_path: "/t", error: "reached max_turns" }) as Record<string, unknown>;
    expect(out.status).toBe("incomplete");
    expect(out.result).toBe("partial work done");
    expect(out.truncated).toBe(false);
    expect((out.error as { code: string }).code).toBe("INCOMPLETE");
    expect((out.error as { message: string }).message).toBe("reached max_turns");
  });

      it("advertises resumability and the exact recovery call on a resumable stop", () => {
    const out = toSlimResult({
      status: "incomplete", result: "partial", job_id: "j7", pool_resolved: [], turns: 50,
      cost_usd: null, transcript_path: "/t", error: "reached max_turns",
      session_id: "sid", resumable: true, continuations: 2,
    } as WorkerResult) as Record<string, unknown>;
    expect(out.resumable).toBe(true);
    expect(out.resume_with).toBe('cx_agent_reply(job_id:"j7", prompt:"…")');
  });

  it("marks a stop with no session as not resumable and omits the hint", () => {
    const out = toSlimResult({
      status: "failed", result: "", job_id: "j8", pool_resolved: [], turns: 0,
      cost_usd: null, transcript_path: "/t", error: "spawn ENOENT",
      session_id: null, resumable: false, continuations: 0,
    } as WorkerResult) as Record<string, unknown>;
    expect(out.resumable).toBe(false);
    expect(out).not.toHaveProperty("resume_with");
  });

  it("keeps the completed envelope minimal — no resume noise on a finished job", () => {
    const out = toSlimResult({
      status: "completed", result: "done", job_id: "j9", pool_resolved: [], turns: 3,
      cost_usd: null, transcript_path: "/t", error: null,
      session_id: "sid", resumable: true, continuations: 0,
    } as WorkerResult);
    expect(out).toEqual({ job_id: "j9", result: "done" });
  });
});

describe("handleRun — live-job visibility to the lifecycle tools", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cxagent-runvis-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  
  function blockingStore(): SessionStore {
    const blockingWorker = vi.fn().mockImplementation(
      (input: { jobId?: string }, deps: { interrupt: { signal: AbortSignal } }) =>
        new Promise<WorkerResult>((resolve) => {
          deps.interrupt.signal.addEventListener("abort", () => {
            resolve({ status: "interrupted", result: "", job_id: input.jobId ?? "x", pool_resolved: [], turns: 0, cost_usd: null, transcript_path: "/t", error: "interrupted" } as WorkerResult);
          }, { once: true });
        }),
    );
    return new SessionStore({
      defaults: { ...FALLBACK_DEFAULTS, pool: "Worker lvl" },
      validate: vi.fn().mockResolvedValue(undefined),
      runWorker: blockingWorker as never,
      transcriptRoot: root,
    });
  }

  it("announces the job_id on the progress channel and makes it interruptible mid-flight", async () => {
    const store = blockingStore();
    const notes: { params: { progress: number; message?: string } }[] = [];
    const runExtra: ToolHandlerExtra = {
      progressToken: "tok",
      sendNotification: vi.fn().mockImplementation(async (n: unknown) => { notes.push(n as never); }),
      signal: new AbortController().signal,
    };
    const pending = handleRun({ prompt: "long job" }, runExtra, { store });
    await new Promise((r) => setTimeout(r, 20));

        const announced = notes.find((n) => n.params.message?.startsWith("job "));
    expect(announced).toBeDefined();
    expect(announced!.params.progress).toBe(0);
    const jobId = announced!.params.message!.replace(/^job (\S+) started$/, "$1");

        expect(store.isRunning(jobId)).toBe(true);
    expect(store.poll(jobId).terminal).toBe(false);
    const intr = await handleInterrupt({ job_id: jobId }, extra(), store);
    expect(JSON.parse(intr.content.text).status).toBe("interrupted");

    const out = await pending;
    expect(JSON.parse(out.content.text).status).toBe("interrupted");
  });
});

describe("handleInterrupt", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cxagent-intr-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  
  function liveStore(): SessionStore {
    const blockingWorker = vi.fn().mockImplementation(
      (_input: unknown, deps: { interrupt: { signal: { addEventListener: (e: string, cb: () => void, o?: { once?: boolean }) => void } } }) =>
        new Promise<WorkerResult>((resolve) => {
          deps.interrupt.signal.addEventListener("abort", () => {
            resolve({ status: "interrupted", result: "", job_id: "x", pool_resolved: [], turns: 0, cost_usd: null, transcript_path: "/t", error: "interrupted" });
          }, { once: true });
        }),
    );
    return new SessionStore({
      defaults: { ...FALLBACK_DEFAULTS, pool: "Worker lvl" },
      validate: vi.fn().mockResolvedValue(undefined),
      runWorker: blockingWorker as never,
      transcriptRoot: root,
    });
  }

  it("cancels a registered job and returns status interrupted (structured INTERRUPTED)", async () => {
    const s = liveStore();
    const { jobId } = s.start({ prompt: "x" });
    const out = await handleInterrupt({ job_id: jobId }, extra(), s);
    const parsed = JSON.parse(out.content.text);
    expect(parsed.status).toBe("interrupted");
    expect(parsed.job_id).toBe(jobId);
    expect(parsed.error.code).toBe("INTERRUPTED");
  });

  it("returns isError when the job is not found (structured SESSION_NOT_FOUND)", async () => {
    const s = liveStore();
    const out = await handleInterrupt({ job_id: "nope" }, extra(), s);
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content.text);
    expect(parsed.status).toBe("not_found");
    expect(parsed.error.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("handleReply — the recovery path for a budget-killed job", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cxagent-reply-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  
  function echoStore(): { store: SessionStore; worker: ReturnType<typeof vi.fn> } {
    const worker = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
      status: "completed", result: "resumed and finished", job_id: input.jobId as string,
      pool_resolved: [], turns: 2, transcript_path: "/t", error: null,
      session_id: "sid-src", resumable: true, continuations: 0,
    } as WorkerResult));
    const store = new SessionStore({
      defaults: { ...FALLBACK_DEFAULTS, pool: "Worker lvl" },
      validate: vi.fn().mockResolvedValue(undefined),
      runWorker: worker as never,
      transcriptRoot: root,
    });
    return { store, worker };
  }

  function seed(jobId: string, extraMeta: Record<string, unknown> = {}): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${jobId}.meta.json`), JSON.stringify({
      job_id: jobId, status: "incomplete", pool: "Opus lvl", pool_resolved: [], cwd: "D:/AI/cx-agent/src",
      started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z", turns: 50,
      error: "reached max_turns", result: "partial", session_id: "sid-src", resumable: true,
      ...extraMeta,
    }));
  }

  it("resumes a budget-killed job in its own cwd and returns the completed envelope", async () => {
    const { store, worker } = echoStore();
    seed("dead-job");
    const out = await handleReply({ job_id: "dead-job", prompt: "keep going" }, extra(), { store });
    expect(out.isError).toBe(false);
    const parsed = JSON.parse(out.content.text);
    expect(parsed.result).toBe("resumed and finished");
    // A NEW job id continuing the SAME session, under the SOURCE job's cwd/model.
    expect(parsed.job_id).not.toBe("dead-job");
    expect(worker.mock.calls[0][0]).toMatchObject({
      prompt: "keep going", cwd: "D:/AI/cx-agent/src", pool: "Opus lvl",
      resumeSessionId: "sid-src", resumedFrom: "dead-job",
    });
  });

  it("forwards the caller's fresh budget knobs onto the resumed turn", async () => {
    const { store, worker } = echoStore();
    seed("dead-job-2", { max_turns: 1, max_budget_usd: 0.01 });
    await handleReply(
      { job_id: "dead-job-2", prompt: "keep going", max_turns: 400, max_budget_usd: 5, auto_continue: 3 },
      extra(), { store },
    );
    expect(worker.mock.calls[0][0]).toMatchObject({ maxTurns: 400, maxBudgetUsd: 5, autoContinue: 3 });
  });

  it("names which failure it was — unknown job vs. a job with no session", async () => {
    const { store } = echoStore();
    const unknown = await handleReply({ job_id: "ghost", prompt: "x" }, extra(), { store });
    expect(unknown.isError).toBe(true);
    const u = JSON.parse(unknown.content.text);
    expect(u.error.code).toBe("SESSION_NOT_FOUND");
    expect(u.error.message).toMatch(/no job with that id/);

    seed("pre-flight-fail", { session_id: null, resumable: false, status: "failed" });
    const noSession = await handleReply({ job_id: "pre-flight-fail", prompt: "x" }, extra(), { store });
    expect(JSON.parse(noSession.content.text).error.message).toMatch(/never recorded an SDK session/);
  });

  it("rejects a missing job_id or prompt as INVALID_ARGUMENT", async () => {
    const { store } = echoStore();
    const noId = await handleReply({ prompt: "x" }, extra(), { store });
    expect(JSON.parse(noId.content.text).error.code).toBe("INVALID_ARGUMENT");
    const noPrompt = await handleReply({ job_id: "j" }, extra(), { store });
    expect(JSON.parse(noPrompt.content.text).error.code).toBe("INVALID_ARGUMENT");
  });

  it("branches to a new session when fork:true", async () => {
    const { store, worker } = echoStore();
    seed("dead-job-3");
    await handleReply({ job_id: "dead-job-3", prompt: "branch", fork: true }, extra(), { store });
    expect(worker.mock.calls[0][0]).toMatchObject({ resumeSessionId: "sid-src", fork: true });
  });
});

describe("schemas", () => {
  it("runInputSchema parses valid input", () => {
    const z = require("zod").object(runInputSchema);
    const out = z.parse({ prompt: "do it", pool: "Worker lvl", max_turns: 10 });
    expect(out.prompt).toBe("do it");
  });
  it("runInputSchema rejects empty prompt", () => {
    const z = require("zod").object(runInputSchema);
    expect(() => z.parse({ prompt: "" })).toThrow();
  });
  it("interruptInputSchema requires job_id", () => {
    const z = require("zod").object(interruptInputSchema);
    expect(() => z.parse({})).toThrow();
    expect(z.parse({ job_id: "x" }).job_id).toBe("x");
  });

  // B-2: disallowed_tools must survive MCP validation. The MCP framework runs
  // z.object(runInputSchema).parse — which STRIPS unknown keys — before the
  // handler sees args. Before this fix runInputSchema never declared
  // disallowed_tools, so a caller's extra deny was silently dropped and the
  // worker ran with only the built-in hazard list.
  it("runInputSchema retains disallowed_tools (B-2)", () => {
    const z = require("zod").object(runInputSchema);
    const out = z.parse({ prompt: "x", disallowed_tools: ["Bash", "WebFetch"] });
    expect(out.disallowed_tools).toEqual(["Bash", "WebFetch"]);
  });

  it("allowed_tools/:assets (B-4) schema parses a restricting menu + disallowed_tools together", () => {
    const z = require("zod").object(runInputSchema);
    const out = z.parse({ prompt: "x", allowed_tools: ["Read", "Bash"], disallowed_tools: ["Edit"] });
    expect(out.allowed_tools).toEqual(["Read", "Bash"]);
    expect(out.disallowed_tools).toEqual(["Edit"]);
  });
  it("fetchInputSchema accepts a job id and selected fields", () => {
    const z = require("zod").object(fetchInputSchema);
    expect(z.parse({ job_id: "x", fields: ["result", "turns"] })).toEqual({ job_id: "x", fields: ["result", "turns"] });
    expect(() => z.parse({ job_id: "x", fields: ["not-real"] })).toThrow();
  });
});

describe("handleSetup — gateway readiness", () => {
  const provider = (over: Partial<{ models: string[]; ready: boolean; diagnostics: string[] }> = {}) => ({
    id: "test",
    discover: async () => ({
      models: over.models ?? ["Worker lvl", "Opus lvl"],
      ready: over.ready ?? true,
      diagnostics: over.diagnostics ?? [],
    }),
    connection: async (model: string) => ({ baseUrl: "http://g:1", apiKey: "k", model }),
  });

  it("reports endpoint-neutral readiness fields", async () => {
    const out = await handleSetup("Worker lvl", { provider: provider() });
    const parsed = JSON.parse(out.content.text);
    expect(parsed).toEqual({
      ready: true, model: "Worker lvl", models: ["Worker lvl", "Opus lvl"], diagnostics: [],
      engine: "claude", capabilities: { resume: true, fork: true, compact: false, auto_compact: true, context: ["window_tokens", "max_output_tokens", "compaction.enabled"] }, context: null,
    });
    expect(out.isError).toBe(false);
  });

  it("flags an unknown model against the catalog", async () => {
    const out = await handleSetup("Bogus", { provider: provider() });
    const parsed = JSON.parse(out.content.text);
    expect(parsed.ready).toBe(false);
    expect(parsed.diagnostics.join(" ")).toMatch(/unknown model "Bogus"; valid models: Worker lvl, Opus lvl/);
    expect(out.isError).toBe(true);
  });

  it("reports adapter controls even when gateway discovery throws", async () => {
    const out = await handleSetup("Worker lvl", { engine: "pi", provider: {
      ...provider(), discover: async () => { throw new Error("gateway offline"); },
    } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content.text)).toMatchObject({ ready: false, engine: "pi", diagnostics: ["gateway offline"],
      capabilities: { auto_compact: true, context: ["window_tokens", "max_output_tokens", "compaction.enabled", "compaction.trigger_tokens", "compaction.keep_recent_tokens"] },
      context: { window_tokens: 128000, max_output_tokens: 8192, compaction: { enabled: true, trigger_tokens: 111616, keep_recent_tokens: 20000 } },
    });
  });

  it("surfaces provider resolution errors as diagnostics instead of throwing", async () => {
    const prev = process.env.CX_AGENT_PROVIDER;
    process.env.CX_AGENT_PROVIDER = "cx";
    try {
      const out = await handleSetup("Worker lvl");
      const parsed = JSON.parse(out.content.text);
      expect(parsed.ready).toBe(false);
      expect(parsed.diagnostics[0]).toMatch(/removed in v0\.3\.0/);
      expect(out.isError).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CX_AGENT_PROVIDER;
      else process.env.CX_AGENT_PROVIDER = prev;
    }
  });

  it("flags a missing model configuration", async () => {
    const prevModel = process.env.CX_AGENT_MODEL;
    const prevConfig = process.env.CX_AGENT_CONFIG;
    const prevLegacy = process.env.CX_AGENT_SETTINGS;
    delete process.env.CX_AGENT_MODEL;
    delete process.env.CX_AGENT_CONFIG;
    delete process.env.CX_AGENT_SETTINGS;
    try {
      const out = await handleSetup(undefined, { provider: provider() });
      const parsed = JSON.parse(out.content.text);
      expect(parsed.ready).toBe(false);
      expect(parsed.diagnostics.join(" ")).toMatch(/no model configured/);
    } finally {
      for (const [k, v] of [["CX_AGENT_MODEL", prevModel], ["CX_AGENT_CONFIG", prevConfig], ["CX_AGENT_SETTINGS", prevLegacy]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("carries gateway diagnostics into the setup result", async () => {
    const out = await handleSetup("Worker lvl", { provider: provider({ ready: false, models: [], diagnostics: ["gateway unreachable at http://g:1"] }) });
    const parsed = JSON.parse(out.content.text);
    expect(parsed.ready).toBe(false);
    expect(parsed).not.toHaveProperty("routerReady");
    expect(parsed).not.toHaveProperty("routerPid");
    expect(parsed.diagnostics).toContain("gateway unreachable at http://g:1");
  });
});

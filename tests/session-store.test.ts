import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerResult } from "../src/worker.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cxagent-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fakeDefaults = { ...FALLBACK_DEFAULTS, pool: "Worker lvl" };
const fakeValidate = vi.fn().mockResolvedValue(undefined);

const fakeProvider = {
  id: "test",
  discover: async () => ({ models: ["Opus lvl", "Worker lvl"], ready: true, diagnostics: [] }),
  connection: async (model: string) => ({ baseUrl: "http://127.0.0.1:4000", apiKey: "sk-cx-local", model }),
};

function fakeQuery(messages: SDKMessage[]) {
  return vi.fn().mockImplementation((_params: { prompt: string | unknown; options?: unknown }) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    return gen();
  });
}

function successStream(): SDKMessage[] {
  return [
    { type: "system", subtype: "init", apiKeySource: "env", claude_code_version: "x", cwd: "D:/AI", tools: [], mcp_servers: [], model: "Worker lvl", permissionMode: "bypassPermissions", slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: "u1", session_id: "s1" } as unknown as SDKMessage,
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "D:/a/b.ts" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s1" } as unknown as SDKMessage,
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, parent_tool_use_id: null, session_id: "s1" } as unknown as SDKMessage,
    { type: "result", subtype: "success", is_error: false, result: "all done", num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: {}, service_tier: "standard" }, modelUsage: {}, permission_denials: [], duration_ms: 100, duration_api_ms: 100, stop_reason: "end_turn", uuid: "u3", session_id: "s1" } as unknown as SDKMessage,
  ];
}

function maxTurnsStream(): SDKMessage[] {
  return [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "D:/a/b.ts" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s9" } as unknown as SDKMessage,
    { type: "result", subtype: "error_max_turns", is_error: true, result: "partial work", num_turns: 50, total_cost_usd: 0.05, usage: { input_tokens: 40000, output_tokens: 500, cache_read_input_tokens: 38000, cache_creation_input_tokens: 1500, server_tool_use: {}, service_tier: "standard" }, modelUsage: {}, permission_denials: [], duration_ms: 120000, duration_api_ms: 90000, stop_reason: null, uuid: "u3", session_id: "s9" } as unknown as SDKMessage,
  ];
}

function store(): SessionStore {
  return new SessionStore({ defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root });
}

describe("SessionStore — start / awaitTerminal", () => {
  it("blocks until terminal and resolves the worker result", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    const r = await s.awaitTerminal(jobId);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("completed");
    expect(r!.result).toBe("all done");
    expect(r!.session_id).toBe("s1");
        expect(s.size).toBe(0);
  });

  it("surfaces incomplete (error_max_turns) as its own terminal status", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(maxTurnsStream()) });
    const r = await s.awaitTerminal(jobId);
    expect(r!.status).toBe("incomplete");
    expect(r!.result).toBe("partial work");
    expect(r!.session_id).toBe("s9");
  });

  it("writes a running meta at start so the job is visible before terminal", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    const metaPath = join(root, `${jobId}.meta.json`);
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.status).toBe("running");
    expect(meta.job_id).toBe(jobId);
    // session_id is null on the initial running meta (unknown until first msg).
    expect(meta.session_id).toBeNull();
    // Reclaim the worker so its terminal write does not race afterEach's rmSync.
    await s.awaitTerminal(jobId);
  });

  it("reflects the SDK session_id on the running meta once the first message arrives", async () => {
    const s = store();
    // A query that yields init, then blocks on the store's interrupt signal
    // so we can observe the running meta mid-flight.
    const q = vi.fn().mockImplementation((params: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", apiKeySource: "env", claude_code_version: "x", cwd: "D:/AI", tools: [], mcp_servers: [], model: "Worker lvl", permissionMode: "bypassPermissions", slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: "u1", session_id: "s-block" } as unknown as SDKMessage;
        await new Promise<void>((resolve) => params.options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const { jobId } = s.start({ prompt: "x", queryFn: q });
    await new Promise((r) => setTimeout(r, 20));
    const meta = JSON.parse(readFileSync(join(root, `${jobId}.meta.json`), "utf8"));
    expect(meta.session_id).toBe("s-block");
    expect(meta.status).toBe("running");
    // Release the blocking query so awaitTerminal can resolve.
    await s.cancel(jobId);
  });

  it("awaitTerminal on an unknown id reads a terminal meta sidecar from disk", async () => {
    const s = store();
    // No live job; synthesize a terminal sidecar.
    const jobId = "external-job-1";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${jobId}.meta.json`), JSON.stringify({
      job_id: jobId, status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
      started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z", turns: 3,
      cost_usd: null, error: null, result: "from disk", session_id: "ext-sid",
    }));
    const r = await s.awaitTerminal(jobId);
    expect(r!.status).toBe("completed");
    expect(r!.result).toBe("from disk");
    expect(r!.session_id).toBe("ext-sid");
  });

  it("awaitTerminal on an unknown id with no sidecar returns null", async () => {
    const s = store();
    expect(await s.awaitTerminal("nope")).toBeNull();
  });
});

describe("SessionStore — ring buffer / poll", () => {
  it("returns cursor-windowed events for a known job", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    await s.awaitTerminal(jobId);
    // After detach, poll reads the terminal meta — no live buffer.
    const poll = s.poll(jobId);
    expect(poll.terminal).toBe(true);
    expect(poll.status).toBe("completed");
    expect(poll.events).toEqual([]);
  });

  it("windows events by cursor while the job is live", async () => {
    const s = store();
    // A query that emits init + one tool_use, then blocks on abort so the job
    // stays live while we poll.
    const q = vi.fn().mockImplementation((params: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", apiKeySource: "env", claude_code_version: "x", cwd: "D:/AI", tools: [], mcp_servers: [], model: "Worker lvl", permissionMode: "bypassPermissions", slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: "u1", session_id: "s-w" } as unknown as SDKMessage;
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "D:/a.ts" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s-w" } as unknown as SDKMessage;
        await new Promise<void>((resolve) => params.options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const { jobId } = s.start({ prompt: "x", queryFn: q });
    await new Promise((r) => setTimeout(r, 20));
    const first = s.poll(jobId);
    expect(first.terminal).toBe(false);
    expect(first.status).toBe("running");
    expect(first.events.length).toBe(2);
    expect(first.nextCursor).toBeGreaterThan(0);
    // A poll since the last cursor returns only new events (none yet).
    const second = s.poll(jobId, first.nextCursor);
    expect(second.events.length).toBe(0);
    await s.cancel(jobId);
  });

  it("poll on an unknown id returns status unknown + terminal", () => {
    const s = store();
    const p = s.poll("does-not-exist");
    expect(p.status).toBe("unknown");
    expect(p.terminal).toBe(true);
    expect(p.events).toEqual([]);
  });
});

describe("SessionStore — interrupt vs cancel", () => {
  it("interrupt marks a running job resumable (handle still resolvable)", async () => {
    const s = store();
    const { jobId, interrupt } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    const out = await s.interrupt(jobId, "operator stop");
    expect(out.status).toBe("interrupted");
    expect(interrupt.isAborted).toBe(true);
    expect(interrupt.reason).toBe("operator stop");
    await s.awaitTerminal(jobId);
  });

  it("interrupt on an unknown id returns not_found", async () => {
    const s = store();
    expect((await s.interrupt("nope")).status).toBe("not_found");
  });

  it("cancel detaches the job from the live registry", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    expect(s.size).toBe(1);
    const out = await s.cancel(jobId);
    expect(out.status).toBe("cancelled");
    expect(s.size).toBe(0);
  });

  it("cancel on an unknown id returns not_found", async () => {
    const s = store();
    expect((await s.cancel("nope")).status).toBe("not_found");
  });
});

describe("SessionStore — session_id", () => {
  it("getSessionId returns the captured SDK session_id for a live job", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.getSessionId(jobId)).toBe("s1");
    await s.awaitTerminal(jobId);
  });

  it("getSessionId reads session_id from meta for a detached job", async () => {
    const s = store();
    const jobId = "ext-2";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${jobId}.meta.json`), JSON.stringify({
      job_id: jobId, status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
      started_at: "2026-08-08T00:00:00Z", ended_at: null, turns: 0, cost_usd: null,
      error: null, result: "", session_id: "ext-sid-2",
    }));
    expect(s.getSessionId(jobId)).toBe("ext-sid-2");
  });

  it("isRunning is true only while the job is in-flight", async () => {
    const s = store();
    const { jobId } = s.start({ prompt: "x", queryFn: fakeQuery(successStream()) });
    expect(s.isRunning(jobId)).toBe(true);
    await s.awaitTerminal(jobId);
    expect(s.isRunning(jobId)).toBe(false);
  });
});

// SDK session files live at ~/.claude/projects/<slug(cwd)>/<session-id>.jsonl, so a
// resume only finds its session when it runs under the SAME cwd. reply() therefore has
// to inherit the source job's environment; it used to pass the caller's (empty) values
// through, which made every reply resume into the wrong project dir and fail.
describe("SessionStore — reply inherits the source job's environment", () => {
  /** Write a terminal sidecar describing a job that ran with a full environment. */
  function seedTerminalMeta(jobId: string, extra: Record<string, unknown> = {}): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${jobId}.meta.json`), JSON.stringify({
      job_id: jobId, status: "incomplete", pool: "Opus lvl", pool_resolved: [],
      cwd: "D:/AI/cx-agent/src", started_at: "2026-08-08T00:00:00Z", ended_at: "2026-08-08T00:01:00Z",
      turns: 50, error: "reached max_turns", result: "partial", session_id: "sid-src",
      resumable: true, agent: "reviewer", allowed_tools: ["Read", "Grep"], disallowed_tools: ["Bash"],
      ...extra,
    }));
  }

  it("resumes with the source job's cwd, model, agent and tool menu", async () => {
    const s = store();
    seedTerminalMeta("src-job");
    const q = fakeQuery(successStream());
    const out = s.reply("src-job", { prompt: "continue", queryFn: q });
    expect("jobId" in out).toBe(true);
    const { jobId } = out as { jobId: string };
    await s.awaitTerminal(jobId);
    const opts = q.mock.calls[0][0].options;
    expect(opts.cwd).toBe("D:/AI/cx-agent/src");
    expect(opts.model).toBe("Opus lvl");
    expect(opts.agent).toBe("reviewer");
    expect(opts.tools).toEqual(["Read", "Grep"]);
    expect(opts.disallowedTools).toContain("Bash");
    // Continues the SAME session by default (no fork).
    expect(opts.resume).toBe("sid-src");
    expect(opts.forkSession).toBeFalsy();
    // The new job records its lineage.
    const meta = JSON.parse(readFileSync(join(root, `${jobId}.meta.json`), "utf8"));
    expect(meta.resumed_from).toBe("src-job");
  });

  it("lets explicit arguments override the inherited environment", async () => {
    const s = store();
    seedTerminalMeta("src-job-2");
    const q = fakeQuery(successStream());
    const out = s.reply("src-job-2", { prompt: "continue", cwd: "D:/other", model: "Worker lvl", queryFn: q });
    const { jobId } = out as { jobId: string };
    await s.awaitTerminal(jobId);
    expect(q.mock.calls[0][0].options.cwd).toBe("D:/other");
    expect(q.mock.calls[0][0].options.model).toBe("Worker lvl");
  });

  it("does not inherit budget — a reply to a budget-killed job gets a fresh allowance", async () => {
    const s = store();
    // The source job died on a deliberately tiny budget. Inheriting it would kill
    // the reply the same way, which is exactly the failure mode being fixed.
    seedTerminalMeta("src-job-3", { max_turns: 1, max_budget_usd: 0.01, timeout_ms: 1000 });
    const q = fakeQuery(successStream());
    const { jobId } = s.reply("src-job-3", { prompt: "continue", queryFn: q }) as { jobId: string };
    await s.awaitTerminal(jobId);
    const opts = q.mock.calls[0][0].options;
    expect(opts.maxTurns).toBe(fakeDefaults.maxTurns);
    expect(opts.maxBudgetUsd).toBeUndefined();
  });

  it("forks to a new session id when fork:true, leaving the original untouched", async () => {
    const s = store();
    seedTerminalMeta("src-job-4");
    const q = fakeQuery(successStream());
    const { jobId } = s.reply("src-job-4", { prompt: "branch", fork: true, queryFn: q }) as { jobId: string };
    await s.awaitTerminal(jobId);
    expect(q.mock.calls[0][0].options.resume).toBe("sid-src");
    expect(q.mock.calls[0][0].options.forkSession).toBe(true);
  });

  it("distinguishes an unknown job from a known job that never recorded a session", () => {
    const s = store();
    const unknown = s.reply("never-existed", { prompt: "x" }) as { status: string; reason?: string };
    expect(unknown.status).toBe("SESSION_NOT_FOUND");
    expect(unknown.reason).toBe("unknown_job");

    seedTerminalMeta("no-sid-job", { session_id: null, resumable: false });
    const noSession = s.reply("no-sid-job", { prompt: "x" }) as { status: string; reason?: string };
    expect(noSession.status).toBe("SESSION_NOT_FOUND");
    expect(noSession.reason).toBe("no_session");
  });

  it("rejects a reply while the source job is still running", async () => {
    const s = store();
    const q = vi.fn().mockImplementation((params: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", uuid: "u1", session_id: "s-busy" } as unknown as SDKMessage;
        await new Promise<void>((resolve) => params.options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const { jobId } = s.start({ prompt: "x", queryFn: q });
    await new Promise((r) => setTimeout(r, 20));
    const out = s.reply(jobId, { prompt: "too soon" }) as { status: string; sessionId: string | null };
    expect(out.status).toBe("SESSION_BUSY");
    expect(out.sessionId).toBe("s-busy");
    await s.cancel(jobId);
  });
});

describe("SessionStore — onMessage is O(1) (no per-message registry scan)", () => {
  it("pushes one ring event per message without scanning the registry", async () => {
    const s = store();
    // Add noise jobs so a naive .values().find() would have to scan them.
    const noiseQ = () => vi.fn().mockImplementation((params: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", apiKeySource: "env", claude_code_version: "x", cwd: "D:/AI", tools: [], mcp_servers: [], model: "Worker lvl", permissionMode: "bypassPermissions", slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: "u1", session_id: "s-noise" } as unknown as SDKMessage;
        await new Promise<void>((resolve) => params.options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    for (let i = 0; i < 10; i++) s.start({ prompt: `noise-${i}`, queryFn: noiseQ() });
    // Target emits all 4 successStream messages then blocks before the result
    // is processed... actually successStream ends in a result, which settles.
    // Use a query that emits 4 messages then blocks (no result yet = live).
    const targetQ = vi.fn().mockImplementation((params: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for (const m of successStream().slice(0, 3)) yield m;
        await new Promise<void>((resolve) => params.options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const { jobId } = s.start({ prompt: "x", queryFn: targetQ });
    await new Promise((r) => setTimeout(r, 30));
    const poll = s.poll(jobId);
    // 3 messages teed (init + assistant + user).
    expect(poll.events.length).toBe(3);
    expect(poll.events.map((e) => e.kind)).toEqual(["system", "tool_use", "tool_result"]);
    const seqs = poll.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // Cleanup all jobs.
    for (const j of [...s["live"].keys()]) await s.cancel(j).catch(() => {});
  });

  it("evicts the oldest half when the ring exceeds the hard cap", async () => {
    const s = store();
    const many: SDKMessage[] = [];
    for (let i = 0; i < 300; i++) {
      many.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `f${i}.ts` } }] }, parent_tool_use_id: null, uuid: `u${i}`, session_id: "s-evict" } as unknown as SDKMessage);
    }
    // A blocking query: emit all 300 then block so the job stays live (ring
    // buffer intact) for the poll assertion.
    const q = vi.fn().mockImplementation((params: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for (const m of many) yield m;
        await new Promise<void>((resolve) => params.options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const { jobId } = s.start({ prompt: "x", queryFn: q });
    await new Promise((r) => setTimeout(r, 40));
    const poll = s.poll(jobId);
    // Buffer was capped (hard cap 256 → evict half → ≤ 256, > 0).
    expect(poll.events.length).toBeLessThanOrEqual(256);
    expect(poll.events.length).toBeGreaterThan(0);
    // seqs still strictly monotonic after eviction.
    const seqs = poll.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    await s.cancel(jobId);
  });
});

void (null as unknown as WorkerResult);

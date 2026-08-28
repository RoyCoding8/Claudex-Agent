import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { makeSpawnWithPid, runWorker, CONTINUE_PROMPT, type WorkerInput } from "../src/worker.js";
import { InterruptHandle } from "../src/interrupt.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProgressNotification, ProgressSender } from "../src/progress.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cxagent-worker-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});


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


function errorStream(): SDKMessage[] {
  return [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bad" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s1" } as unknown as SDKMessage,
    { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], num_turns: 1, total_cost_usd: 0.0001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: {}, service_tier: "standard" }, modelUsage: {}, permission_denials: [], duration_ms: 50, duration_api_ms: 50, stop_reason: null, uuid: "u3", session_id: "s1" } as unknown as SDKMessage,
  ];
}


function maxTurnsStream(): SDKMessage[] {
  return [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "D:/a/b.ts" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s1" } as unknown as SDKMessage,
    { type: "result", subtype: "error_max_turns", is_error: true, result: "partial work performed before the cap", num_turns: 50, total_cost_usd: 0.05, usage: { input_tokens: 40000, output_tokens: 500, cache_read_input_tokens: 38000, cache_creation_input_tokens: 1500, server_tool_use: {}, service_tier: "standard" }, modelUsage: {}, permission_denials: [], duration_ms: 120000, duration_api_ms: 90000, stop_reason: null, uuid: "u3", session_id: "s1" } as unknown as SDKMessage,
  ];
}


function budgetStopStream(): SDKMessage[] {
  return [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "D:/a/b.ts" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s1" } as unknown as SDKMessage,
    { type: "result", subtype: "error_max_budget_usd", is_error: true, result: "partial work before the cost cap", num_turns: 12, total_cost_usd: 1.5, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: {}, service_tier: "standard" }, modelUsage: {}, permission_denials: [], duration_ms: 1000, duration_api_ms: 900, stop_reason: null, uuid: "u3", session_id: "s1" } as unknown as SDKMessage,
  ];
}


function scriptedQuery(rounds: SDKMessage[][]) {
  let call = 0;
  return vi.fn().mockImplementation((_params: { prompt: string | unknown; options?: unknown }) => {
    const messages = rounds[Math.min(call++, rounds.length - 1)];
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    return gen();
  });
}

const fakeDefaults = { ...FALLBACK_DEFAULTS, pool: "Worker lvl" };
const fakeValidate = vi.fn().mockResolvedValue(undefined);

const fakeProvider = {
  id: "test",
  discover: async () => ({ models: ["Opus lvl", "Worker lvl"], ready: true, diagnostics: [] }),
  connection: async (model: string) => ({ baseUrl: "http://127.0.0.1:4000", apiKey: "sk-cx-local", model }),
};

function capturingSender(caps: ProgressNotification[]): ProgressSender {
  return (n) => caps.push(n);
}

describe("runWorker — happy path", () => {
  it("blocks until terminal, returns status=completed with result text + cost", async () => {
    const caps: ProgressNotification[] = [];
    const q = fakeQuery(successStream());
    const input: WorkerInput = {
      prompt: "do the thing",
      queryFn: q,
      sendProgress: capturingSender(caps),
      progressToken: "tok-1",
    };
    const result = await runWorker(input, {
      defaults: fakeDefaults,
      validate: fakeValidate,
      provider: fakeProvider,
      transcriptRoot: root,
    });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("all done");
            expect("cost_usd" in result).toBe(false);
    expect(result.turns).toBe(1);
    expect(result.error).toBeNull();
    expect(result.job_id).toMatch(/^\d{8}T\d{6}-[a-z0-9]+$/);
        expect(q).toHaveBeenCalledTimes(1);
    const callOpts = q.mock.calls[0][0].options;
    expect(callOpts.model).toBe("Worker lvl");
    expect(callOpts.cwd).toBe(process.cwd());
    expect(callOpts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(callOpts.env.ANTHROPIC_MODEL).toBe("Worker lvl");
    expect(callOpts.env.ANTHROPIC_API_KEY).toBe("");
    expect(callOpts.permissionMode).toBe("bypassPermissions");
        const p = caps.map((c) => c.progress);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
  });

  it("passes requested cwd to the SDK and writes terminal metadata", async () => {
    const q = fakeQuery(successStream());
    const result = await runWorker(
      { prompt: "x", cwd: "D:/AI/cx-agent", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    const { readFileSync, existsSync } = await import("node:fs");
    expect(q.mock.calls[0][0].options.cwd).toBe("D:/AI/cx-agent");
    expect(result.pool_resolved).toEqual([]);
    expect(existsSync(result.transcript_path)).toBe(true);
    const metaPath = result.transcript_path.replace(/\.jsonl$/, ".meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.status).toBe("completed");
    expect(meta.pool).toBe("Worker lvl");
    expect(meta.pool_resolved).toEqual([]);
        expect(meta.cost_usd).toBeUndefined();
    expect(meta.usage.input_tokens).toBe(1);
  });

  it("derives files_changed as the sorted de-duplicated union of tool_use file-like paths", async () => {
    const stream: SDKMessage[] = [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "D:/a/x.ts" } }] }, parent_tool_use_id: null, uuid: "u1", session_id: "s-fc" } as unknown as SDKMessage,
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "D:/b/y.ts" } }] }, parent_tool_use_id: null, uuid: "u2", session_id: "s-fc" } as unknown as SDKMessage,
            { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:/other/x.ts" } }] }, parent_tool_use_id: null, uuid: "u3", session_id: "s-fc" } as unknown as SDKMessage,
            { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] }, parent_tool_use_id: null, uuid: "u4", session_id: "s-fc" } as unknown as SDKMessage,
            { type: "assistant", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "D:/nb/z.ipynb" } }] }, parent_tool_use_id: null, uuid: "u5", session_id: "s-fc" } as unknown as SDKMessage,
      { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 4, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: {}, service_tier: "standard" }, modelUsage: {}, permission_denials: [], duration_ms: 10, duration_api_ms: 10, stop_reason: "end_turn", uuid: "u6", session_id: "s-fc" } as unknown as SDKMessage,
    ];
    const result = await runWorker(
      { prompt: "x", queryFn: fakeQuery(stream), sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("completed");
    expect(result.session_id).toBe("s-fc");
    const { readFileSync } = await import("node:fs");
    const meta = JSON.parse(readFileSync(result.transcript_path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    expect(meta.files_changed).toEqual(["x.ts", "y.ts", "z.ipynb"]);
  });
});

describe("runWorker — error path", () => {
  it("returns status=failed with the SDK error list when result.is_error", async () => {
    const q = fakeQuery(errorStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("failed");
                expect(result.result).toBe("");
    expect(result.error).toContain("boom");
  });

  it("records usage token counts on the terminal result record (B-09)", async () => {
    const q = fakeQuery(successStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("completed");
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(result.transcript_path, "utf8").split("\n").filter((l) => l.trim());
    const resultRec = lines.map((l) => JSON.parse(l)).find((r) => r.kind === "result" && r.payload?.status === "completed");
    expect(resultRec.payload.usage).toEqual({
      input_tokens: 1, output_tokens: 1,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    });
  });
});

describe("runWorker — incomplete (B-03)", () => {
  it("surfaces error_max_turns as status=incomplete and keeps the partial result", async () => {
        const q = fakeQuery(maxTurnsStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, autoContinue: 0, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("incomplete");
    expect(result.result).toBe("partial work performed before the cap");
    expect(result.turns).toBe(50);
    expect(result.error).toBe("reached max_turns");
    expect(q).toHaveBeenCalledTimes(1);
        expect(result.resumable).toBe(true);
    expect(result.continuations).toBe(0);
        const { readFileSync } = await import("node:fs");
    const meta = JSON.parse(readFileSync(result.transcript_path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    expect(meta.status).toBe("incomplete");
    expect(meta.result).toBe("partial work performed before the cap");
    expect(meta.resumable).toBe(true);
  });

  it("surfaces error_max_budget_usd as incomplete + resumable, not failed", async () => {
    const q = fakeQuery(budgetStopStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, autoContinue: 0, maxBudgetUsd: 1.5, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("incomplete");
    expect(result.error).toBe("reached max budget of 1.5 USD");
    expect(result.resumable).toBe(true);
  });

  it("passes maxBudgetUsd through to the SDK only when set", async () => {
    const withCap = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: withCap, maxBudgetUsd: 2, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(withCap.mock.calls[0][0].options.maxBudgetUsd).toBe(2);

    const noCap = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: noCap, sendProgress: capturingSender([]) },
      { defaults: { ...fakeDefaults, maxBudgetUsd: 0 }, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(noCap.mock.calls[0][0].options.maxBudgetUsd).toBeUndefined();
  });
});

describe("runWorker — auto-continue on a budget stop", () => {
  it("resumes the same session and finishes when a later round succeeds", async () => {
    const q = scriptedQuery([maxTurnsStream(), maxTurnsStream(), successStream()]);
    const result = await runWorker(
      { prompt: "original task", queryFn: q, autoContinue: 3, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("completed");
    expect(result.result).toBe("all done");
    expect(result.continuations).toBe(2);
    expect(q).toHaveBeenCalledTimes(3);
            expect(q.mock.calls[0][0].prompt).toBe("original task");
    expect(q.mock.calls[0][0].options.resume).toBeUndefined();
    expect(q.mock.calls[1][0].prompt).toBe(CONTINUE_PROMPT);
    expect(q.mock.calls[1][0].options.resume).toBe("s1");
    expect(q.mock.calls[1][0].options.forkSession).toBe(false);
        expect(result.turns).toBe(50 + 50 + 1);
  });

  it("gives up after autoContinue rounds and reports incomplete", async () => {
    const q = fakeQuery(maxTurnsStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, autoContinue: 2, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q).toHaveBeenCalledTimes(3);     expect(result.status).toBe("incomplete");
    expect(result.continuations).toBe(2);
    expect(result.turns).toBe(150);
    expect(result.resumable).toBe(true);
  });

  it("does not auto-continue a job that was interrupted", async () => {
    const interrupt = new InterruptHandle(vi.fn().mockResolvedValue(undefined));
    const q = vi.fn().mockImplementation(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", uuid: "u1", session_id: "s1" } as unknown as SDKMessage;
        await interrupt.cancel("stopped by operator");
        for (const m of maxTurnsStream()) yield m;
      }
      return gen();
    });
    const result = await runWorker(
      { prompt: "x", queryFn: q, autoContinue: 5, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root, interrupt },
    );
    expect(q).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("interrupted");
  });

  it("never auto-continues a successful round", async () => {
    const q = fakeQuery(successStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, autoContinue: 5, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.continuations).toBe(0);
  });
});

describe("runWorker — pre-flight (pool) failure", () => {
  it("returns status=failed without calling query() when pool validation throws", async () => {
    const badValidate = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      throw new Error("Unknown pool Nope");
    });
    const q = fakeQuery(successStream());
    const result = await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: badValidate, transcriptRoot: root },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Unknown pool Nope");
    expect(q).not.toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const meta = JSON.parse(readFileSync(result.transcript_path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    expect(meta.started_at).not.toBe(meta.ended_at);
  });
});

describe("runWorker — interruption", () => {
  it("returns status=interrupted when the query throws mid-stream", async () => {
    const q = vi.fn().mockImplementation(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", apiKeySource: "env", claude_code_version: "x", cwd: "D:/AI", tools: [], mcp_servers: [], model: "Worker lvl", permissionMode: "bypassPermissions", slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: "u1", session_id: "s1" } as unknown as SDKMessage;
        throw new Error("killed");
      }
      return gen();
    });
    const result = await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("killed");
  });

            it("returns incomplete + resumable with a readable cap-specific error on timeout (B-3)", async () => {
    const q = vi.fn().mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", uuid: "u1", session_id: "s-timeout" } as unknown as SDKMessage;
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const result = await runWorker(
      { prompt: "x", timeoutMs: 20, queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(result.status).toBe("incomplete");
    expect(result.error).toBe("timeout after 20ms");
    expect(result.resumable).toBe(true);
    expect(result.session_id).toBe("s-timeout");
  });

  it("keeps an explicit user interrupt as status=interrupted with its reason (B-3)", async () => {
    const interrupt = new InterruptHandle(vi.fn().mockResolvedValue(undefined));
    const q = vi.fn().mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return gen();
    });
    const cancelTimer = setTimeout(() => void interrupt.cancel("stopped by operator"), 10);
    try {
      const result = await runWorker(
        { prompt: "x", timeoutMs: 10_000, queryFn: q, sendProgress: capturingSender([]) },
        { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root, interrupt },
      );
      expect(result.status).toBe("interrupted");
      expect(result.error).toBe("stopped by operator");
    } finally {
      clearTimeout(cancelTimer);
    }
  });
});

describe("makeSpawnWithPid", () => {
  it("registers the spawned claude pid so cancellation tree-kills it", async () => {
    const killer = vi.fn().mockResolvedValue(undefined);
    const interrupt = new InterruptHandle(killer);
    const child = {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: null,
      killed: false,
      exitCode: null,
      kill: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    };
    const spawn = vi.fn().mockReturnValue(child);
    const customSpawn = makeSpawnWithPid(interrupt, false, spawn as never);

    customSpawn({
      command: "claude",
      args: ["--output-format", "stream-json"],
      cwd: "D:/AI/cx-agent",
      env: {},
      signal: interrupt.signal,
    });

    expect(spawn).toHaveBeenCalledWith("claude", ["--output-format", "stream-json"], expect.objectContaining({
      cwd: "D:/AI/cx-agent",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }));
    await interrupt.cancel();
    expect(killer).toHaveBeenCalledWith(4242);
  });
});

describe("runWorker — env hard constraint", () => {
  it("the worker env never inherits ambient ANTHROPIC_* (regression lock for S5)", async () => {
        process.env.ANTHROPIC_AUTH_TOKEN = "ambient-leak";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    process.env.ANTHROPIC_MODEL = "claude-ambient";
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    const callEnv = q.mock.calls[0][0].options.env;
    expect(callEnv.ANTHROPIC_AUTH_TOKEN).toBe("sk-cx-local");
    expect(callEnv.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(callEnv.ANTHROPIC_MODEL).toBe("Worker lvl");
        delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
  });
});

describe("runWorker — allowed_tools → Options.tools (B-4)", () => {
  it("sets options.tools to the caller's list when non-empty (restricts the menu)", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", allowedTools: ["Read", "Bash"], queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q.mock.calls[0][0].options.tools).toEqual(["Read", "Bash"]);
  });

  it("does NOT set options.tools when allowed_tools is empty (would disable ALL built-ins)", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", allowedTools: [], queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q.mock.calls[0][0].options.tools).toBeUndefined();
  });

  it("does NOT set options.tools when allowed_tools is omitted (full menu default)", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q.mock.calls[0][0].options.tools).toBeUndefined();
        expect(q.mock.calls[0][0].options.allowedTools).toBeUndefined();
  });

  it("applies disallowedTools in addition to the restrictive menu (independent)", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", allowedTools: ["Read", "Bash", "Edit"], disallowedTools: ["Bash"], queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    const opts = q.mock.calls[0][0].options;
    expect(opts.tools).toEqual(["Read", "Bash", "Edit"]);
    expect(opts.disallowedTools).toContain("Bash");
  });
});

describe("runWorker — worker isolation (B-01)", () => {
  it("denies the hazard tool list to the worker SDK options", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    const disallowed = q.mock.calls[0][0].options.disallowedTools as string[];
    expect(Array.isArray(disallowed)).toBe(true);
        expect(disallowed).toContain("AskUserQuestion");
    expect(disallowed).toContain("EnterPlanMode");
    expect(disallowed).toContain("ExitPlanMode");
    expect(disallowed).toContain("EnterWorktree");
    expect(disallowed).toContain("ExitWorktree");
        expect(disallowed).toContain("CronCreate");
    expect(disallowed).toContain("CronList");
    expect(disallowed).toContain("ScheduleWakeup");
    expect(disallowed).toContain("PushNotification");
            expect(disallowed).toContain("mcp__cx-agent__cx_agent_run");
    expect(disallowed).toContain("mcp__cx-agent__cx_agent_interrupt");
    expect(disallowed).toContain("mcp__cx-agent__cx_agent_list");
    expect(disallowed).toContain("mcp__cx-agent__cx_agent_fetch");
    expect(disallowed).toContain("cx_agent_run");
    expect(disallowed).toContain("cx_agent_fetch");
  });

  it("merges input.disallowedTools on top of the hazard list", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: q, disallowedTools: ["Bash", "Edit"], sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    const disallowed = q.mock.calls[0][0].options.disallowedTools as string[];
    expect(disallowed).toContain("Bash");
    expect(disallowed).toContain("Edit");
        expect(disallowed).toContain("AskUserQuestion");
  });

  it("stamps an incremented CX_AGENT_DEPTH into the worker env", async () => {
    const prev = process.env.CX_AGENT_DEPTH;
    process.env.CX_AGENT_DEPTH = "1";
    try {
      const q = fakeQuery(successStream());
      await runWorker(
        { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
        { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
      );
      expect(q.mock.calls[0][0].options.env.CX_AGENT_DEPTH).toBe("2");
    } finally {
      if (prev === undefined) delete process.env.CX_AGENT_DEPTH;
      else process.env.CX_AGENT_DEPTH = prev;
    }
  });

  it("refuses to spawn when incoming depth >= maxDepth (recursion guard)", async () => {
    const prev = process.env.CX_AGENT_DEPTH;
    process.env.CX_AGENT_DEPTH = "2";     try {
      const q = fakeQuery(successStream());
      const result = await runWorker(
        { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
        { defaults: { ...fakeDefaults, maxDepth: 2 }, validate: fakeValidate, transcriptRoot: root },
      );
      expect(result.status).toBe("failed");
      expect(result.error).toContain("recursion limit");
            expect(q).not.toHaveBeenCalled();
            const { readFileSync, existsSync } = await import("node:fs");
      expect(existsSync(result.transcript_path)).toBe(true);
      const meta = JSON.parse(readFileSync(result.transcript_path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
      expect(meta.status).toBe("failed");
      expect(meta.error).toContain("recursion limit");
    } finally {
      if (prev === undefined) delete process.env.CX_AGENT_DEPTH;
      else process.env.CX_AGENT_DEPTH = prev;
    }
  });

  it("allows a nested delegation strictly below maxDepth", async () => {
    const prev = process.env.CX_AGENT_DEPTH;
    process.env.CX_AGENT_DEPTH = "1";     try {
      const q = fakeQuery(successStream());
      const result = await runWorker(
        { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
        { defaults: { ...fakeDefaults, maxDepth: 2 }, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
      );
      expect(result.status).toBe("completed");
      expect(q).toHaveBeenCalledTimes(1);
      expect(q.mock.calls[0][0].options.env.CX_AGENT_DEPTH).toBe("2");
    } finally {
      if (prev === undefined) delete process.env.CX_AGENT_DEPTH;
      else process.env.CX_AGENT_DEPTH = prev;
    }
  });
});

describe("runWorker — worker isolation (B-01 residue)", () => {
  it("spawns with settingSources: [] by default (no operator hooks or MCP servers in the worker)", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q.mock.calls[0][0].options.settingSources).toEqual([]);
  });

  it("inherits user/project/local settings when defaults.inheritSettings is true", async () => {
    const q = fakeQuery(successStream());
    await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: { ...fakeDefaults, inheritSettings: true }, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
    );
    expect(q.mock.calls[0][0].options.settingSources).toEqual(["user", "project", "local"]);
  });
});

describe("runWorker — gateway pre-flight", () => {
  it("fails with 'unknown model' before spawning when the model is not in the gateway catalog", async () => {
    const q = fakeQuery(successStream());
    const provider = {
      id: "test",
      discover: async () => ({ models: ["Worker lvl"], ready: true, diagnostics: [] }),
      connection: async (model: string) => ({ baseUrl: "http://127.0.0.1:4000", apiKey: "k", model }),
    };
    const result = await runWorker(
      { prompt: "x", pool: "Bogus", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, provider, transcriptRoot: root },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unknown model "Bogus"/);
    expect(q).not.toHaveBeenCalled();
  });

  it("fails when the gateway reports not ready, surfacing its diagnostics", async () => {
    const q = fakeQuery(successStream());
    const provider = {
      id: "test",
      discover: async () => ({ models: [], ready: false, diagnostics: ["gateway unreachable at http://g:1"] }),
      connection: async (model: string) => ({ baseUrl: "http://g:1", apiKey: "k", model }),
    };
    const result = await runWorker(
      { prompt: "x", queryFn: q, sendProgress: capturingSender([]) },
      { defaults: fakeDefaults, provider, transcriptRoot: root },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/gateway not ready: gateway unreachable at http:\/\/g:1/);
    expect(q).not.toHaveBeenCalled();
  });
});

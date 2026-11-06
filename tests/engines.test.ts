import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/providers/types.js";
import { buildCodexOptions, runCodex } from "../src/runtime/codex.js";
import { assertEngineOptionsSupported, ENGINE_CAPABILITIES, parseEngineName, resolveEngine } from "../src/runtime/engine.js";
import { InterruptHandle } from "../src/interrupt.js";
import { runWorker } from "../src/worker.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";

const connection: Connection = {
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "secret-test-key",
  authMode: "bearer",
  model: "custom-model",
};

const request = {
  prompt: "do work",
  model: "custom-model",
  cwd: "D:/repo",
  timeoutMs: 1_000,
  connection,
};

describe("engine selection and capabilities", () => {
  it("selects explicit and configured engines with Claude as the default", () => {
    expect(resolveEngine(undefined, {}, "claude")).toBe("claude");
    expect(resolveEngine(undefined, { CX_AGENT_ENGINE: "pi" })).toBe("pi");
    expect(resolveEngine("codex", {})).toBe("codex");
    expect(parseEngineName("custom")).toBeUndefined();
    expect(() => resolveEngine("custom", {})).toThrow(/Expected claude, codex, pi/);
    expect(ENGINE_CAPABILITIES.codex).toEqual({ resume: true, fork: false, compact: false, auto_compact: true, context: ["window_tokens", "compaction.trigger_tokens"], read_only: "native-sandbox" });
  });

  it("rejects Claude-only restrictions rather than dropping them", () => {
    expect(() => assertEngineOptionsSupported("codex", { ...request, allowedTools: ["Read"] })).toThrow(/allowed_tools/);
    expect(() => assertEngineOptionsSupported("pi", { ...request, thinking: { type: "adaptive" } })).toThrow(/thinking/);
    expect(() => assertEngineOptionsSupported("pi", { ...request, effort: "high" })).toThrow(/effort/);
  });
});

describe("Codex SDK adapter", () => {
  it("isolates Codex auth/config and supplies the selected gateway endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "cx-agent-codex-test-"));
    try {
      const options = buildCodexOptions(connection, {
        home: join(root, "private-home"),
        sourceEnv: { PATH: "runtime-path", TEMP: "runtime-temp", UNRELATED_SECRET: "ambient-secret" },
        codexPathOverride: "test-codex",
        context: { window_tokens: 64000, compaction: { trigger_tokens: 48000 } },
      });
      expect(options.config?.model_provider).toBe("cx_agent");
      expect(options.config?.model_context_window).toBe(64000);
      expect(options.config?.model_auto_compact_token_limit).toBe(48000);
      const providers = options.config?.model_providers as Record<string, Record<string, unknown>>;
      expect(providers.cx_agent).toMatchObject({
        base_url: connection.baseUrl,
        env_key: "CX_AGENT_GATEWAY_KEY",
        wire_api: "responses",
      });
      expect(options.env?.CODEX_HOME).toBe(join(root, "private-home"));
      expect(options.env?.PATH).toBe("runtime-path");
      expect(options.env?.CX_AGENT_GATEWAY_KEY).toBe(connection.apiKey);
      expect(options.env?.UNRELATED_SECRET).toBeUndefined();
      expect(options.codexPathOverride).toBe("test-codex");
      expect(() => buildCodexOptions({ ...connection, authMode: "api-key" }, { home: root })).toThrow(/bearer-token/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes through the SDK and maps stream events to neutral worker events", async () => {
    const emitted: unknown[] = [];
    const agentMessage = { id: "message-1", type: "agent_message" as const, text: "Finished." };
    const command = {
      id: "command-1", type: "command_execution" as const,
      command: "npm test", aggregated_output: "passed", status: "completed" as const,
    };
    const toolError = { id: "error-1", type: "error" as const, message: "first command failed" };
    const events = async function* () {
      yield { type: "turn.started" as const };
      yield { type: "item.started" as const, item: command };
      yield { type: "item.completed" as const, item: command };
      yield { type: "item.completed" as const, item: toolError };
      yield { type: "item.completed" as const, item: agentMessage };
      yield { type: "turn.completed" as const, usage: {
        input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0,
      } };
    };
    const runStreamed = vi.fn(async (_prompt: string, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { events: events() };
    });
    const resumeThread = vi.fn(() => ({ id: "thread-1", runStreamed }));
    const startThread = vi.fn(() => ({ id: null, runStreamed }));
    const createClient = vi.fn(() => ({ startThread, resumeThread }));
    const result = await runCodex(
      { ...request, resumeSessionId: "thread-1", effort: "high" },
      { signal: new AbortController().signal, emit: (event) => emitted.push(event) },
      new InterruptHandle(),
      createClient,
    );

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ model_provider: "cx_agent" }),
      env: expect.objectContaining({ CX_AGENT_GATEWAY_KEY: connection.apiKey }),
    }));
    expect(resumeThread).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      model: "custom-model", workingDirectory: "D:/repo", modelReasoningEffort: "high",
      approvalPolicy: "never", sandboxMode: "workspace-write",
    }));
    expect(startThread).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: "Finished.", sessionId: "thread-1", turns: 1, status: "completed", error: null });
    expect(emitted).toEqual([
      { kind: "session", sessionId: "thread-1" },
      { kind: "system", summary: "Codex turn started" },
      { kind: "tool_use", name: "command", summary: "npm test" },
      { kind: "tool_result", summary: "passed" },
      { kind: "tool_result", summary: "first command failed" },
      { kind: "assistant", text: "Finished." },
    ]);
  });

  it.each([
    { operation: "compact" as const, message: /native session compaction/ },
    { resumeSessionId: "thread-1", fork: true, message: /native session forking/ },
  ])("rejects unsupported session operations before launching", async ({ message, ...input }) => {
    const createClient = vi.fn();
    await expect(runCodex(
      { ...request, ...input },
      { signal: new AbortController().signal, emit: () => undefined },
      new InterruptHandle(),
      createClient,
    )).rejects.toThrow(message);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("worker preflight timeout", () => {
  it("returns a timeout terminal even if model validation never settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-agent-preflight-timeout-"));
    try {
      const result = await runWorker(
        { prompt: "wait", pool: "custom-model", timeoutMs: 20 },
        {
          defaults: { ...FALLBACK_DEFAULTS, pool: "custom-model", timeoutMs: 20 },
          validate: () => new Promise<void>(() => undefined),
          provider: {
            id: "test",
            discover: async () => ({ models: [], ready: true, diagnostics: [] }),
            connection: async () => connection,
          },
          transcriptRoot: root,
        },
      );
      expect(result.status).toBe("incomplete");
      expect(result.error).toBe("timeout after 20ms");
      expect(result.session_id).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

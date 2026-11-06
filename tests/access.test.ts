import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type SDKMessage, type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { resolveAccessPolicy, accessPolicySchema } from "../src/access.js";
import { runClaude } from "../src/runtime/claude.js";
import { runCodex } from "../src/runtime/codex.js";
import { piToolsForAccess } from "../src/runtime/pi.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import { InterruptHandle } from "../src/interrupt.js";

const connection = { baseUrl: "http://127.0.0.1:4000", apiKey: "fixture-key", model: "fixture-model", authMode: "bearer" as const };

describe("access policy", () => {
  it("defaults omitted access to the existing workspace-write mode", () => {
    expect(resolveAccessPolicy("claude", undefined, "C:/repo")).toEqual({ mode: "workspace-write" });
  });

  it("normalizes a read-only report path against cwd", () => {
    const cwd = join(tmpdir(), "repo");
    expect(resolveAccessPolicy("pi", { mode: "read-only", report_path: "reports/final.md" }, cwd))
      .toEqual({ mode: "read-only", report_path: join(cwd, "reports", "final.md") });
    expect(accessPolicySchema.safeParse({ mode: "read-only", report_path: "  " }).success).toBe(false);
  });

  it("rejects a report path on workspace-write and unknown policy keys", () => {
    expect(accessPolicySchema.safeParse({ mode: "workspace-write", report_path: "out.md" }).success).toBe(false);
    expect(accessPolicySchema.safeParse({ mode: "read-only", shell: true }).success).toBe(false);
    expect(() => resolveAccessPolicy("claude", null, "C:/repo")).toThrow();
  });

  it("restricts Pi tools to read and preserves its existing write default", () => {
    expect(piToolsForAccess({ mode: "read-only" })).toEqual(["read"]);
    expect(piToolsForAccess(undefined)).toEqual(["read", "bash", "edit", "write"]);
  });

  it("builds Claude options with explicit read-only tools and denies all other permission requests", async () => {
    let observed: Options | undefined;
    async function* messages(): AsyncGenerator<SDKMessage> {
      yield {
        type: "result", subtype: "success", is_error: false, result: "inspected", num_turns: 1,
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: {}, service_tier: "standard" },
        modelUsage: {}, permission_denials: [], duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", uuid: "fixture", session_id: "session",
      } as unknown as SDKMessage;
    }
    const queryFn = vi.fn(({ options }: { prompt: string; options: Options }) => {
      observed = options;
      return messages();
    }) as typeof query;

    await runClaude({
      prompt: "inspect only", model: "fixture-model", cwd: process.cwd(), timeoutMs: 1000, connection,
      access: { mode: "read-only" }, defaults: { ...FALLBACK_DEFAULTS, inheritSettings: true },
      allowedTools: ["Bash"], queryFn, onMessage: () => undefined, onContinuation: () => undefined,
    }, new InterruptHandle());

    expect(observed).toMatchObject({
      tools: ["Read", "Glob", "Grep"], settingSources: [], permissionMode: "default", allowDangerouslySkipPermissions: false,
    });
    expect(observed?.tools).not.toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "Agent"]));
    expect(observed).not.toHaveProperty("agent");
    expect(observed).not.toHaveProperty("mcpServers");
    expect(observed?.settingSources).toEqual([]);
    const canUseTool = observed?.canUseTool;
    expect(canUseTool).toBeTypeOf("function");
    if (!canUseTool) throw new Error("Claude runtime did not install its permission gate");
    const permissionOptions = { signal: new AbortController().signal };
    await expect(canUseTool("Read", { file_path: "C:/repo/readme.md" }, permissionOptions)).resolves.toMatchObject({ behavior: "allow" });
    for (const tool of ["Bash", "Write", "Edit", "Agent", "mcp__sample__mutate"]) {
      await expect(canUseTool(tool, {}, permissionOptions)).resolves.toMatchObject({ behavior: "deny" });
    }
  });

  it("rejects a Claude agent in read-only mode before starting the SDK", async () => {
    await expect(runClaude({
      prompt: "inspect only", model: "fixture-model", cwd: process.cwd(), timeoutMs: 1000, connection,
      access: { mode: "read-only" }, agent: "custom-agent", defaults: FALLBACK_DEFAULTS,
      onMessage: () => undefined, onContinuation: () => undefined,
    }, new InterruptHandle())).rejects.toThrow(/does not allow agents/);
  });

  it("uses Codex native read-only sandbox mode and preserves workspace-write by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-agent-access-"));
    try {
      const sandboxModes: string[] = [];
      const configOverrides: string[][] = [];
      const runStreamed = vi.fn(async () => ({
        events: (async function* () {
          yield { type: "turn.completed" as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
        })(),
      }));
      const createClient = vi.fn((options: CodexOptions) => {
        configOverrides.push(options.configOverrides ?? []);
        return {
          startThread: vi.fn((threadOptions: ThreadOptions) => {
            sandboxModes.push(threadOptions.sandboxMode ?? "");
            return { id: "thread", runStreamed };
          }),
          resumeThread: vi.fn((_id: string, threadOptions: ThreadOptions) => {
            sandboxModes.push(threadOptions.sandboxMode ?? "");
            return { id: "thread", runStreamed };
          }),
        };
      });
      const base = { prompt: "inspect", model: "fixture-model", cwd: root, timeoutMs: 1000, connection };
      await runCodex({ ...base, access: { mode: "read-only" } }, { signal: new AbortController().signal, emit: () => undefined }, new InterruptHandle(), createClient);
      await runCodex(base, { signal: new AbortController().signal, emit: () => undefined }, new InterruptHandle(), createClient);
      expect(sandboxModes).toEqual(["read-only", "workspace-write"]);
      expect(configOverrides).toEqual([["mcp_servers={}"], []]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

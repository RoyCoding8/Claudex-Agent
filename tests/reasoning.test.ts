import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildThinkingConfig,
  parseThinkingSpec,
  isEffortLevel,
  isThinkingDisplay,
  EFFORT_LEVELS,
  THINKING_DISPLAYS,
} from "../src/runtime/claude-sdk.js";
import { runWorker, type WorkerInput } from "../src/worker.js";
import { FALLBACK_DEFAULTS, loadSettings } from "../src/settings.js";
import { summarizeMessage, summarizeThinking } from "../src/progress.js";
import { SessionStore } from "../src/session-store.js";
import { handleFetchJob, handleRun, ALL_FETCH_FIELDS, runInputSchema, replyInputSchema } from "../src/tools.js";
import { z } from "zod";
import type { JobMeta } from "../src/transcript.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cxagent-reasoning-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fakeDefaults = { ...FALLBACK_DEFAULTS, pool: "Worker lvl" };
const fakeValidate = vi.fn().mockResolvedValue(undefined);
const fakeProvider = {
  id: "test",
  discover: async () => ({ models: ["Worker lvl"], ready: true, diagnostics: [] }),
  connection: async (model: string) => ({ baseUrl: "http://127.0.0.1:4000", apiKey: "sk-cx-local", model }),
};

function thinkingStream(): SDKMessage[] {
  return [
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "weighing two options", signature: "sig-abc" },
          { type: "text", text: "picked the second" },
        ],
      },
      parent_tool_use_id: null, uuid: "u1", session_id: "s1",
    } as unknown as SDKMessage,
    {
      type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1,
      total_cost_usd: 0.001,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: {}, service_tier: "standard" },
      modelUsage: {}, permission_denials: [], duration_ms: 10, duration_api_ms: 10,
      stop_reason: "end_turn", uuid: "u2", session_id: "s1",
    } as unknown as SDKMessage,
  ];
}

function fakeQuery(messages: SDKMessage[]) {
  return vi.fn().mockImplementation(() => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    return gen();
  });
}

async function runWith(input: Partial<WorkerInput>, defaults = fakeDefaults) {
  const q = fakeQuery(thinkingStream());
  const result = await runWorker(
    { prompt: "x", queryFn: q, ...input },
    { defaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root },
  );
  return { q, result, options: q.mock.calls[0][0].options as Record<string, unknown> };
}

describe("buildThinkingConfig", () => {
  it("maps every spec onto the SDK union, defaulting display to summarized", () => {
    expect(buildThinkingConfig(undefined)).toBeUndefined();
    expect(buildThinkingConfig("disabled")).toEqual({ type: "disabled" });
    expect(buildThinkingConfig("adaptive")).toEqual({ type: "adaptive", display: "summarized" });
    expect(buildThinkingConfig(4096)).toEqual({ type: "enabled", budgetTokens: 4096, display: "summarized" });
  });

  it("honours an explicit display, including the empty-text 'omitted' mode", () => {
    expect(buildThinkingConfig("adaptive", "omitted")).toEqual({ type: "adaptive", display: "omitted" });
    expect(buildThinkingConfig(1000, "omitted")).toEqual({ type: "enabled", budgetTokens: 1000, display: "omitted" });
  });

  it("never puts display on the disabled variant", () => {
    expect(buildThinkingConfig("disabled", "summarized")).toEqual({ type: "disabled" });
  });
});

describe("parseThinkingSpec + guards", () => {
  it("accepts mode names, numbers and numeric strings", () => {
    expect(parseThinkingSpec("adaptive")).toBe("adaptive");
    expect(parseThinkingSpec("disabled")).toBe("disabled");
    expect(parseThinkingSpec(4096)).toBe(4096);
    expect(parseThinkingSpec("4096")).toBe(4096);
    expect(parseThinkingSpec(1024.7)).toBe(1024);
  });

  it("rejects anything that is not a positive budget", () => {
    for (const bad of [undefined, null, "", "nope", 0, -1, NaN, Infinity, {}]) {
      expect(parseThinkingSpec(bad)).toBeUndefined();
    }
  });

  it("guards the enum surfaces", () => {
    for (const e of EFFORT_LEVELS) expect(isEffortLevel(e)).toBe(true);
    for (const d of THINKING_DISPLAYS) expect(isThinkingDisplay(d)).toBe(true);
    expect(isEffortLevel("extreme")).toBe(false);
    expect(isThinkingDisplay("summary")).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
  });
});

describe("runWorker — reasoning options wiring", () => {
  it("sends NOTHING when nothing is configured, so an unconfigured job is byte-identical to before", async () => {
    const { options } = await runWith({});
    expect("thinking" in options).toBe(false);
    expect("effort" in options).toBe(false);
    expect("forwardSubagentText" in options).toBe(false);
  });

  it("places an explicit thinking config and effort on SDK Options", async () => {
    const { options } = await runWith({
      thinking: { type: "enabled", budgetTokens: 8000, display: "summarized" },
      effort: "high",
    });
    expect(options.thinking).toEqual({ type: "enabled", budgetTokens: 8000, display: "summarized" });
    expect(options.effort).toBe("high");
  });

  it("builds the config from settings defaults when the call omits it", async () => {
    const { options } = await runWith({}, {
      ...fakeDefaults, thinking: "adaptive", thinkingDisplay: "omitted", effort: "max",
    });
    expect(options.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(options.effort).toBe("max");
  });

  it("lets the call override the settings default", async () => {
    const { options } = await runWith(
      { thinking: { type: "disabled" }, effort: "low" },
      { ...fakeDefaults, thinking: "adaptive", effort: "max" },
    );
    expect(options.thinking).toEqual({ type: "disabled" });
    expect(options.effort).toBe("low");
  });

  it("forwards subagent text only when the setting asks for it", async () => {
    const off = await runWith({});
    expect("forwardSubagentText" in off.options).toBe(false);
    const on = await runWith({}, { ...fakeDefaults, forwardSubagentText: true });
    expect(on.options.forwardSubagentText).toBe(true);
  });

  it("records the reasoning config in the meta sidecar and the thinking text in the JSONL", async () => {
    const { result } = await runWith({ thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
    const { readFileSync } = await import("node:fs");
    const meta = JSON.parse(readFileSync(join(root, `${result.job_id}.meta.json`), "utf8")) as JobMeta;
    expect(meta.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(meta.effort).toBe("high");
    expect(JSON.stringify(meta)).not.toContain("weighing two options");

    const jsonl = readFileSync(join(root, `${result.job_id}.jsonl`), "utf8");
    expect(jsonl).toContain("weighing two options");
    expect(jsonl).toContain("sig-abc");
  });

  it("keeps reasoning out of the returned envelope", async () => {
    const { result } = await runWith({ thinking: { type: "adaptive", display: "summarized" } });
    expect(JSON.stringify(result)).not.toContain("weighing two options");
  });

  it("writes null config for a job that ran without reasoning", async () => {
    const { result } = await runWith({});
    const { readFileSync } = await import("node:fs");
    const meta = JSON.parse(readFileSync(join(root, `${result.job_id}.meta.json`), "utf8")) as JobMeta;
    expect(meta.thinking).toBeNull();
    expect(meta.effort).toBeNull();
  });
});

describe("summarizeThinking", () => {
  it("reports size, never words", () => {
    const s = summarizeThinking([{ type: "thinking", thinking: "abcde" }]);
    expect(s).toBe("thinking · 5 chars");
    expect(s).not.toContain("abcde");
  });

  it("sums across blocks and counts redacted ones separately", () => {
    expect(summarizeThinking([
      { type: "thinking", thinking: "ab" },
      { type: "redacted_thinking" },
      { type: "thinking", thinking: "cde" },
    ])).toBe("thinking · 5 chars · 1 redacted");
  });

  it("returns null when there is nothing to report", () => {
    expect(summarizeThinking(undefined)).toBeNull();
    expect(summarizeThinking([])).toBeNull();
    expect(summarizeThinking([{ type: "text", text: "hi" }])).toBeNull();
  });

  it("counts an empty-text thinking block — the 'display: omitted' shape", () => {
    expect(summarizeThinking([{ type: "thinking", thinking: "" }])).toBe("thinking · 0 chars");
  });
});

describe("summarizeMessage — thinking branch", () => {
  it("summarizes a thinking-only turn instead of collapsing it to 'assistant turn'", () => {
    expect(summarizeMessage({ type: "assistant", content: [{ type: "thinking", thinking: "abc" }] }, 0))
      .toEqual({ text: "thinking · 3 chars", turnInc: false });
  });

  it("prefixes text and tool_use turns without losing them", () => {
    expect(summarizeMessage({ type: "assistant", content: [{ type: "thinking", thinking: "abc" }, { type: "text", text: "hello" }] }, 0))
      .toEqual({ text: "thinking · 3 chars · assistant: hello", turnInc: false });
    expect(summarizeMessage({ type: "assistant", content: [{ type: "thinking", thinking: "abc" }, { type: "tool_use", name: "Read", input: { file_path: "D:/a/b.ts" } }] }, 2))
      .toEqual({ text: "turn 3 · thinking · 3 chars · Read b.ts", turnInc: true });
  });

  it("leaves messages without thinking exactly as they were", () => {
    expect(summarizeMessage({ type: "assistant", content: [{ type: "text", text: "hello" }] }, 0))
      .toEqual({ text: "assistant: hello", turnInc: false });
    expect(summarizeMessage({ type: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "D:/a/b.ts" } }] }, 2))
      .toEqual({ text: "turn 3 · Read b.ts", turnInc: true });
    expect(summarizeMessage({ type: "assistant", content: [] }, 0))
      .toEqual({ text: "assistant turn", turnInc: false });
  });
});

describe("SessionStore — reasoning plumbing", () => {
  function captureStore() {
    const seen: WorkerInput[] = [];
    const run = vi.fn().mockImplementation(async (input: WorkerInput) => {
      seen.push(input);
      return {
        status: "completed" as const, result: "ok", job_id: input.jobId ?? "j", pool_resolved: [],
        turns: 1, transcript_path: "", error: null, session_id: "s1", resumable: true, continuations: 0,
      };
    });
    return { seen, store: new SessionStore({ runWorker: run as never, transcriptRoot: root }) };
  }

  it("passes thinking and effort straight through to the worker", () => {
    const { seen, store } = captureStore();
    store.start({ prompt: "p", thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
    expect(seen[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(seen[0].effort).toBe("high");
  });

  it("omits the keys entirely when unset", () => {
    const { seen, store } = captureStore();
    store.start({ prompt: "p" });
    expect("thinking" in seen[0]).toBe(false);
    expect("effort" in seen[0]).toBe(false);
  });

  it("inherits the source job's reasoning config on reply, and lets the call override it", async () => {
    const { seen, store } = captureStore();
    writeFileSync(join(root, "src-job.meta.json"), JSON.stringify({
      job_id: "src-job", status: "incomplete", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
      started_at: "2026-08-27T00:00:00Z", ended_at: "2026-08-27T00:01:00Z", turns: 3, error: null,
      session_id: "s-src", thinking: { type: "adaptive", display: "summarized" }, effort: "high",
    } satisfies JobMeta));

    const first = store.reply("src-job", { prompt: "keep going" });
    if ("status" in first) throw new Error(first.status);
    await store.awaitTerminal(first.jobId);
    expect(seen[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(seen[0].effort).toBe("high");

    store.reply("src-job", { prompt: "quietly now", thinking: { type: "disabled" }, effort: "low" });
    expect(seen[1].thinking).toEqual({ type: "disabled" });
    expect(seen[1].effort).toBe("low");
  });

  it("inherits nothing when the source job had no reasoning config", () => {
    const { seen, store } = captureStore();
    writeFileSync(join(root, "plain.meta.json"), JSON.stringify({
      job_id: "plain", status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
      started_at: "2026-08-27T00:00:00Z", ended_at: null, turns: 1, error: null,
      session_id: "s-plain", thinking: null, effort: null,
    } satisfies JobMeta));
    store.reply("plain", { prompt: "again" });
    expect("thinking" in seen[0]).toBe(false);
    expect("effort" in seen[0]).toBe(false);
  });
});

describe("ring events — the thinking summary reaching cx_agent_check", () => {
  it("reports thinking size on the ring without carrying the text", async () => {
    const store = new SessionStore({
      defaults: fakeDefaults, validate: fakeValidate, provider: fakeProvider, transcriptRoot: root,
    });
    const { jobId } = store.start({
      prompt: "x",
      queryFn: fakeQuery(thinkingStream()) as never,
      thinking: { type: "adaptive", display: "summarized" },
    });
    // Read the ring while the live record is still attached — awaitTerminal detaches it.
    await new Promise((r) => setTimeout(r, 20));
    const summaries = store.poll(jobId).events.map((e) => e.summary);
    expect(summaries).toContain("thinking · 20 chars · picked the second");
    expect(summaries.join("|")).not.toContain("weighing two options");
    await store.awaitTerminal(jobId);
  });
});

describe("MCP args → worker options", () => {
  const extra = () => ({ sendNotification: async () => {}, signal: new AbortController().signal });

  function captureRun() {
    const seen: WorkerInput[] = [];
    const fake = vi.fn().mockImplementation(async (input: WorkerInput) => {
      seen.push(input);
      return {
        status: "completed" as const, result: "ok", job_id: input.jobId ?? "j", pool_resolved: [],
        turns: 1, transcript_path: "", error: null, session_id: "s1", resumable: true, continuations: 0,
      };
    });
    return { seen, deps: { store: new SessionStore({ runWorker: fake as never, transcriptRoot: root }) } };
  }

  it("builds a ThinkingConfig from the flat tool args", async () => {
    const { seen, deps } = captureRun();
    await handleRun({ prompt: "x", thinking: 4096, thinking_display: "omitted", effort: "xhigh" }, extra(), deps);
    expect(seen[0].thinking).toEqual({ type: "enabled", budgetTokens: 4096, display: "omitted" });
    expect(seen[0].effort).toBe("xhigh");
  });

  it("defaults display to summarized so thinking blocks are not silently empty", async () => {
    const { seen, deps } = captureRun();
    await handleRun({ prompt: "x", thinking: "adaptive" }, extra(), deps);
    expect(seen[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("ignores thinking_display without thinking, and sends nothing when nothing is asked for", async () => {
    const { seen, deps } = captureRun();
    await handleRun({ prompt: "x", thinking_display: "summarized" }, extra(), deps);
    expect("thinking" in seen[0]).toBe(false);
    expect("effort" in seen[0]).toBe(false);
  });

  it("accepts every documented value through the run schema and rejects the rest", () => {
    const schema = z.object(runInputSchema);
    for (const thinking of ["adaptive", "disabled", 4096]) {
      expect(schema.safeParse({ prompt: "x", thinking }).success).toBe(true);
    }
    for (const effort of EFFORT_LEVELS) expect(schema.safeParse({ prompt: "x", effort }).success).toBe(true);
    for (const display of THINKING_DISPLAYS) expect(schema.safeParse({ prompt: "x", thinking_display: display }).success).toBe(true);
    for (const bad of [{ thinking: "sometimes" }, { thinking: 0 }, { thinking: -1 }, { thinking: 1.5 }, { effort: "extreme" }, { thinking_display: "verbose" }]) {
      expect(schema.safeParse({ prompt: "x", ...bad }).success).toBe(false);
    }
  });

  it("exposes the same knobs on reply", () => {
    const schema = z.object(replyInputSchema);
    expect(schema.safeParse({ job_id: "j", prompt: "x", thinking: "adaptive", effort: "low" }).success).toBe(true);
    expect(schema.safeParse({ job_id: "j", prompt: "x", thinking: "sometimes" }).success).toBe(false);
  });
});

describe("cx_agent_fetch fields:[\"reasoning\"]", () => {
  function seed(jobId: string, blocks: unknown[], meta: Partial<JobMeta> = {}) {
    writeFileSync(join(root, `${jobId}.meta.json`), JSON.stringify({
      job_id: jobId, status: "completed", pool: "Worker lvl", pool_resolved: [], cwd: "D:/AI",
      started_at: "2026-08-27T00:00:00Z", ended_at: "2026-08-27T00:01:00Z", turns: 1, error: null,
      ...meta,
    }));
    const lines = blocks.map((content, i) => JSON.stringify({
      ts: "2026-08-27T00:00:0" + i + "Z", job_id: jobId, seq: i + 1, kind: "assistant",
      payload: { type: "assistant", message: { content } },
    }));
    writeFileSync(join(root, `${jobId}.jsonl`), lines.join("\n") + "\n");
  }

  function fetchReasoning(jobId: string) {
    return JSON.parse(handleFetchJob({ job_id: jobId, fields: ["reasoning"] }, { root }).content.text).reasoning;
  }

  it("returns the config, the counts and the joined text", () => {
    seed("r1", [
      [{ type: "thinking", thinking: "first thought", signature: "sig" }, { type: "text", text: "hi" }],
      [{ type: "thinking", thinking: "second thought", signature: "sig" }],
    ], { thinking: { type: "adaptive", display: "summarized" }, effort: "high" });

    const r = fetchReasoning("r1");
    expect(r.config).toEqual({ thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
    expect(r.blocks).toBe(2);
    expect(r.redacted).toBe(0);
    expect(r.chars).toBe("first thought".length + "second thought".length);
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("first thought");
    expect(r.text).toContain("second thought");
  });

  it("counts redacted blocks without inventing text for them", () => {
    seed("r2", [[{ type: "redacted_thinking", data: "opaque" }, { type: "thinking", thinking: "ok" }]]);
    const r = fetchReasoning("r2");
    expect(r.blocks).toBe(2);
    expect(r.redacted).toBe(1);
    expect(r.chars).toBe(2);
    expect(r.text).toBe("ok");
  });

  it("caps the text but reports the true total in chars", () => {
    const huge = "z".repeat(20_000);
    seed("r3", [[{ type: "thinking", thinking: huge }]]);
    const r = fetchReasoning("r3");
    expect(r.chars).toBe(20_000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(9_000);
    expect(r.text).toContain("truncated");
  });

  it("is empty — not an error — for a job that never produced reasoning", () => {
    seed("r4", [[{ type: "text", text: "no thinking here" }]]);
    expect(fetchReasoning("r4")).toEqual({
      config: { thinking: null, effort: null }, blocks: 0, redacted: 0, chars: 0, truncated: false, text: "",
    });
  });

  it("survives a missing or corrupt transcript", () => {
    writeFileSync(join(root, "r5.meta.json"), JSON.stringify({
      job_id: "r5", status: "completed", pool: "p", pool_resolved: [], cwd: "D:/AI",
      started_at: "2026-08-27T00:00:00Z", ended_at: null, turns: 0, error: null,
    }));
    expect(fetchReasoning("r5").blocks).toBe(0);
    writeFileSync(join(root, "r5.jsonl"), "not json\n{\"kind\":\"assistant\"}\n");
    expect(fetchReasoning("r5").blocks).toBe(0);
  });

  it("stays out of the default and the full-sidecar views", () => {
    seed("r6", [[{ type: "thinking", thinking: "secret reasoning" }]]);
    expect(ALL_FETCH_FIELDS).not.toContain("reasoning");
    const full = handleFetchJob({ job_id: "r6", fields: ALL_FETCH_FIELDS }, { root }).content.text;
    expect(full).not.toContain("secret reasoning");
    expect(handleFetchJob({ job_id: "r6" }, { root }).content.text).not.toContain("secret reasoning");
  });
});

describe("loadSettings — reasoning config", () => {
  const KEYS = ["CX_AGENT_THINKING", "CX_AGENT_THINKING_DISPLAY", "CX_AGENT_EFFORT", "CX_AGENT_FORWARD_SUBAGENT_TEXT", "CX_AGENT_CONFIG"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function writeConfig(agent_defaults: Record<string, unknown>): string {
    const p = join(root, "settings.json");
    writeFileSync(p, JSON.stringify({ agent_defaults }));
    return p;
  }

  it("defaults to nothing configured", () => {
    const s = loadSettings(join(root, "does-not-exist.json"));
    expect(s.thinking).toBeUndefined();
    expect(s.effort).toBeUndefined();
    expect(s.forwardSubagentText).toBe(false);
  });

  it("reads env even with no config file present", () => {
    process.env.CX_AGENT_THINKING = "adaptive";
    process.env.CX_AGENT_THINKING_DISPLAY = "omitted";
    process.env.CX_AGENT_EFFORT = "xhigh";
    process.env.CX_AGENT_FORWARD_SUBAGENT_TEXT = "1";
    const s = loadSettings(join(root, "does-not-exist.json"));
    expect(s.thinking).toBe("adaptive");
    expect(s.thinkingDisplay).toBe("omitted");
    expect(s.effort).toBe("xhigh");
    expect(s.forwardSubagentText).toBe(true);
  });

  it("reads snake_case and camelCase config keys", () => {
    expect(loadSettings(writeConfig({ thinking: 4096, thinking_display: "summarized", effort: "high", forward_subagent_text: true })))
      .toMatchObject({ thinking: 4096, thinkingDisplay: "summarized", effort: "high", forwardSubagentText: true });
    expect(loadSettings(writeConfig({ thinkingDisplay: "omitted", forwardSubagentText: true })))
      .toMatchObject({ thinkingDisplay: "omitted", forwardSubagentText: true });
  });

  it("lets env override the config file", () => {
    const p = writeConfig({ thinking: 4096, effort: "low" });
    process.env.CX_AGENT_THINKING = "disabled";
    process.env.CX_AGENT_EFFORT = "max";
    expect(loadSettings(p)).toMatchObject({ thinking: "disabled", effort: "max" });
  });

  it("drops junk instead of forwarding it to the SDK", () => {
    const s = loadSettings(writeConfig({ thinking: "sometimes", thinking_display: "verbose", effort: "extreme" }));
    expect(s.thinking).toBeUndefined();
    expect(s.thinkingDisplay).toBeUndefined();
    expect(s.effort).toBeUndefined();

    process.env.CX_AGENT_THINKING = "-5";
    process.env.CX_AGENT_EFFORT = "turbo";
    const e = loadSettings(join(root, "does-not-exist.json"));
    expect(e.thinking).toBeUndefined();
    expect(e.effort).toBeUndefined();
  });
});

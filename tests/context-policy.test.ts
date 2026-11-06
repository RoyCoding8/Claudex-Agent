import { describe, expect, it } from "vitest";
import { mergeContextPolicy, resolveContextPolicy } from "../src/runtime/context-policy.js";

describe("context policy", () => {
  it("keeps the Pi defaults and scales reserves for smaller windows", () => {
    expect(resolveContextPolicy("pi")).toEqual({ window_tokens: 128000, max_output_tokens: 8192,
      compaction: { enabled: true, trigger_tokens: 111616, keep_recent_tokens: 20000 } });
    expect(resolveContextPolicy("pi", { window_tokens: 8192 })).toEqual({ window_tokens: 8192, max_output_tokens: 2048,
      compaction: { enabled: true, trigger_tokens: 6144, keep_recent_tokens: 3072 } });
  });

  it("retains explicit false and merges partial reply overrides", () => {
    const inherited = resolveContextPolicy("pi", { window_tokens: 32768, max_output_tokens: 1024,
      compaction: { enabled: true, trigger_tokens: 24000, keep_recent_tokens: 8000 } });
    expect(resolveContextPolicy("pi", mergeContextPolicy(inherited, { compaction: { enabled: false } })))
      .toEqual({ ...inherited, compaction: { enabled: false, trigger_tokens: 24000, keep_recent_tokens: 8000 } });
  });

  it("rejects unsupported controls and impossible context budgets", () => {
    expect(() => resolveContextPolicy("claude", { compaction: { trigger_tokens: 32000 } })).toThrow(/claude does not expose/);
    expect(() => resolveContextPolicy("codex", { max_output_tokens: 1000 })).toThrow(/codex does not expose/);
    expect(() => resolveContextPolicy("pi", { window_tokens: 4096, max_output_tokens: 4096 })).toThrow(/Require/);
    expect(() => resolveContextPolicy("pi", { window_tokens: 8192, compaction: { trigger_tokens: 8000 } })).toThrow(/Require/);
    expect(() => resolveContextPolicy("pi", { compaction: { keep_recent_tokens: 120000 } })).toThrow(/Require/);
  });
});

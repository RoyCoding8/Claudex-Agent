import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { handleRun } from "../src/tools.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";

it("rejects unsupported controls before creating a job or calling its worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "cx-preflight-"));
  try {
    const run = vi.fn();
    const store = new SessionStore({ runWorker: run, transcriptRoot: root });
    const result = await handleRun({ engine: "pi", model: "custom", prompt: "inspect", background: true, max_turns: 2 }, {
      signal: new AbortController().signal, sendNotification: async () => {},
    }, { store });
    const value = JSON.parse(result.content.text);
    expect(value.job_id).toBeNull();
    expect(value.error).toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(value.error.message).toContain("timeout_ms");
    expect(store.size).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(store.prepare({ engine: "pi", model: "custom", prompt: "inspect", timeoutMs: 100 })).toMatchObject({ engine: "pi", timeoutMs: 100 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("also rejects unsupported configured controls and native operations before starting", () => {
  const run = vi.fn();
  const store = new SessionStore({ runWorker: run, defaults: { ...FALLBACK_DEFAULTS, effort: "high" } });
  expect(() => store.prepare({ engine: "pi", prompt: "x" })).toThrow(/configured Claude options: effort/);
  expect(() => store.start({ engine: "codex", prompt: "x", fork: true })).toThrow(/forks/);
  expect(() => store.start({ engine: "claude", prompt: "", operation: "compact" })).toThrow(/manual compaction/);
  expect(run).not.toHaveBeenCalled();
});

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  ProgressEmitter,
  summarizeMessage,
  describeToolTarget,
  HEARTBEAT_MS,
  type SdkMessageLike,
  type ProgressNotification,
  type ProgressSender,
} from "../src/progress.js";

function capturingSender(captures: ProgressNotification[]): ProgressSender {
  return (n) => captures.push(n);
}

describe("ProgressEmitter — monotonicity (the plan's regression lock)", () => {
  it("progress strictly increases across emit + heartbeat + emitEvent", () => {
    const caps: ProgressNotification[] = [];
    const e = new ProgressEmitter("tok-1", capturingSender(caps));
    e.emit("a");
    e.emit("b");
    e.emitEvent({ type: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } }] });
    e.emit("c");
    const progress = caps.map((n) => n.progress);
    expect(progress).toEqual([1, 2, 3, 4]);
        for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1]);
    }
  });

  it("never emits a non-increasing progress value (fuzz via random interleaving)", () => {
    const caps: ProgressNotification[] = [];
    const e = new ProgressEmitter(99, capturingSender(caps));
    const msgs: SdkMessageLike[] = [
      { type: "system", subtype: "init" },
      { type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      { type: "user" },
      { type: "assistant", content: [{ type: "text", text: "done" }] },
      { type: "result", subtype: "success" },
    ];
    for (const m of msgs) e.emitEvent(m);
    e.emit("heartbeat");
    e.emit("heartbeat");
    const p = caps.map((n) => n.progress);
    expect(p).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("counts turns — one per assistant tool_use block", () => {
    const e = new ProgressEmitter("t", capturingSender([]));
    e.emitEvent({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] });
    e.emitEvent({ type: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "c.ts" } }] });
    e.emitEvent({ type: "assistant", content: [{ type: "text", text: "thinking" }] });
    e.emitEvent({ type: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "d.ts" } }] });
    expect(e.turnCount).toBe(3);
  });
});

describe("summarizeMessage", () => {
  it("system init → 'session started'", () => {
    expect(summarizeMessage({ type: "system", subtype: "init" }, 0).text).toBe("session started");
  });
  it("system status compacting → 'compacting context'", () => {
    expect(summarizeMessage({ type: "system", subtype: "status", status: "compacting" }, 0).text).toBe("compacting context");
  });
  it("assistant tool_use → 'turn N · ToolName target' and increments turn", () => {
    const s = summarizeMessage(
      { type: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:\\proj\\src\\foo.ts" } }] },
      3,
    );
    expect(s.text).toBe("turn 4 · Edit foo.ts");
    expect(s.turnInc).toBe(true);
  });
  it("assistant text → 'assistant: ...' and does not increment turn", () => {
    const s = summarizeMessage({ type: "assistant", content: [{ type: "text", text: "hello world this is long" }] }, 1);
    expect(s.text).toBe("assistant: hello world this is long");
    expect(s.turnInc).toBe(false);
  });
  it("result success → 'completed'", () => {
    expect(summarizeMessage({ type: "result", subtype: "success" }, 1).text).toBe("completed");
  });
  it("result error → 'failed: ...'", () => {
    const s = summarizeMessage({ type: "result", subtype: "error_during_execution", errors: ["boom", "kaboom"] }, 1);
    expect(s.text).toBe("failed: boom; kaboom");
  });
  it("tool_use_summary → uses the SDK summary string", () => {
    expect(summarizeMessage({ type: "tool_use_summary", summary: "Edited 3 files" }, 1).text).toBe("Edited 3 files");
  });
});

describe("describeToolTarget", () => {
  it("shows basename of a posix path", () => {
    expect(describeToolTarget("Read", { file_path: "/x/y/z/foo.ts" })).toBe("foo.ts");
  });
  it("shows basename of a windows path", () => {
    expect(describeToolTarget("Edit", { file_path: "C:\\proj\\bar.ts" })).toBe("bar.ts");
  });
  it("shows first line of a bash command, truncated to 40", () => {
    const long = "#".repeat(80);
    const out = describeToolTarget("Bash", { command: long });
    expect(out.length).toBe(40);
  });
  it("returns '' for unrecognised input", () => {
    expect(describeToolTarget("Unknown", { weird: "x" })).toBe("");
    expect(describeToolTarget("Bash", null)).toBe("");
  });
});

describe("heartbeat", () => {
  it("HEARTBEAT_MS is 10s (≤ plan's 10s floor)", () => {
    expect(HEARTBEAT_MS).toBe(10_000);
  });
  it("heartbeat callback emits the last summary with 'still working · ...'", () => {
                    const caps: ProgressNotification[] = [];
    const e = new ProgressEmitter("h", capturingSender(caps));
    e.emit("turn 1 · Bash ls");
        e.emit(`still working · turn 1 · Bash ls`);
    expect(caps[1].message).toBe("still working · turn 1 · Bash ls");
    expect(caps[1].progress).toBeGreaterThan(caps[0].progress);
  });
  it("stopHeartbeat is idempotent", () => {
    const e = new ProgressEmitter("h2", capturingSender([]));
    expect(() => {
      e.stopHeartbeat();
      e.stopHeartbeat();
    }).not.toThrow();
  });

            it("heartbeat message does NOT compound across ticks (B-1)", () => {
    vi.useFakeTimers();
    try {
      const caps: ProgressNotification[] = [];
      const e = new ProgressEmitter("bk", capturingSender(caps));
                  e.emit("turn 3 · Edit foo.ts");
      e.startHeartbeat(10_000);
            for (let i = 0; i < 5; i++) vi.advanceTimersByTime(10_000);
      e.stopHeartbeat();

                  const beats = caps.slice(1);       expect(beats.length).toBe(5);
      for (const b of beats) {
        expect(b.message).toBe("still working · turn 3 · Edit foo.ts");
      }
                  const lens = beats.map((b) => b.message!.length);
      expect(new Set(lens).size).toBe(1);
            const p = caps.map((c) => c.progress);
      for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
    } finally {
      vi.useRealTimers();
    }
  });

      it("a post-heartbeat event updates lastSummary; interleaved heartbeats stay bounded (B-1)", () => {
    vi.useFakeTimers();
    try {
      const caps: ProgressNotification[] = [];
      const e = new ProgressEmitter("bi", capturingSender(caps));
      e.emit("turn 1");
      e.startHeartbeat(10_000);
      vi.advanceTimersByTime(10_000);       e.emitEvent({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] });       vi.advanceTimersByTime(10_000);       e.stopHeartbeat();
      const msgs = caps.map((c) => c.message);
            expect(msgs).toEqual(["turn 1", "still working · turn 1", "turn 1 · Bash ls", "still working · turn 1 · Bash ls"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

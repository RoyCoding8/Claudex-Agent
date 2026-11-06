import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import type { WorkerResult } from "../src/worker.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cxagent-protocol-"));
  process.env.CX_AGENT_DATA_DIR = root;
});
afterEach(() => {
  delete process.env.CX_AGENT_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function worker(): typeof import("../src/worker.js").runWorker {
  return vi.fn(async (input: { jobId?: string }) => ({
    status: "completed", result: "wire-ok", job_id: input.jobId ?? "job", pool_resolved: ["worker"], turns: 1,
    transcript_path: join(root, "job.jsonl"), error: null, session_id: "session", resumable: true, continuations: 0,
  } satisfies WorkerResult)) as unknown as typeof import("../src/worker.js").runWorker;
}

describe("MCP protocol", () => {
  it("runs a group and its dependent stage through MCP, without foreground host wakeups", async () => {
    const run = worker();
    const enqueue = vi.fn();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createServer({ runWorker: run, enqueueParentContinuation: enqueue });
    const client = new Client({ name: "cx-group-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (args: Record<string, unknown>) => {
      const response = await client.callTool({ name: "cx_agent_group", arguments: args });
      const block = response.content.find((item) => item.type === "text");
      if (block?.type !== "text") throw new Error("Missing group envelope");
      return { value: JSON.parse(block.text), isError: response.isError };
    };
    try {
      const plan = await call({ action: "create", name: "review", tasks: [
        { name: "a", prompt: "first", engine: "pi", access: { mode: "read-only" } },
        { name: "b", prompt: "second", engine: "pi", access: { mode: "read-only" } },
        { name: "synthesis", prompt: "combine", engine: "pi", depends_on: ["a", "b"], access: { mode: "read-only" } },
      ] });
      expect(plan.isError).not.toBe(true);
      let cursor = 0;
      let last = plan.value;
      for (let i = 0; i < 4 && last.counts.completed !== 3; i++) {
        const event = await call({ action: "wait_any", group_id: plan.value.group_id, after_cursor: cursor, timeout_ms: 1000 });
        last = event.value;
        cursor = last.next_cursor;
      }
      expect(last.counts).toEqual({ completed: 3, running: 0, queued: 0, failed: 0, blocked: 0 });
      expect(run.mock.calls[2][0].prompt).toContain("wire-ok");
      const replay = await call({ action: "wait_any", group_id: plan.value.group_id, after_cursor: 0, timeout_ms: 0 });
      expect(replay.value.events.map((event: { task: string }) => event.task)).toEqual(["a", "b", "synthesis"]);
      const invalid = await call({ action: "create", name: "bad", tasks: [{ name: "bad", prompt: "x", engine: "pi", max_turns: 1 }] });
      expect(invalid.isError).toBe(true);
      expect(invalid.value.error.code).toBe("UNSUPPORTED_OPERATION");
      expect(run).toHaveBeenCalledTimes(3);
      expect(enqueue).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("initializes, lists the public tools, and calls cx_agent_run over transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createServer({ runWorker: worker() });
    const client = new Client({ name: "cx-agent-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name).sort()).toEqual([
        "cx_agent_check", "cx_agent_compact", "cx_agent_fetch", "cx_agent_group", "cx_agent_interrupt", "cx_agent_list",
        "cx_agent_reply", "cx_agent_run", "cx_agent_session", "cx_agent_setup", "cx_agent_wait",
      ]);
      const response = await client.callTool({ name: "cx_agent_run", arguments: { prompt: "work", pool: "worker" } });
      const block = response.content.find((item) => item.type === "text");
      expect(block?.type === "text" ? JSON.parse(block.text) : null).toMatchObject({ result: "wire-ok" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

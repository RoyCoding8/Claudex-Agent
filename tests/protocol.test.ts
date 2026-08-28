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
  it("initializes, lists the public tools, and calls cx_agent_run over transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createServer({ runWorker: worker() });
    const client = new Client({ name: "cx-agent-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name).sort()).toEqual([
        "cx_agent_check", "cx_agent_fetch", "cx_agent_interrupt", "cx_agent_list",
        "cx_agent_reply", "cx_agent_run", "cx_agent_session", "cx_agent_setup",
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

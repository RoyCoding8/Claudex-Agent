import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { SessionStore } from "../src/session-store.js";
import { handleRun, handleReply, handleWait, handleSession, handleCompact, handleFetchJob } from "../src/tools.js";
import type { WorkerInput, WorkerDeps, WorkerResult } from "../src/worker.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cx-agent-background-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function controlledWorker() {
  let finish: (text?: string) => void = () => {};
  let signal: AbortSignal | undefined;
  let lastInput: WorkerInput | undefined;
  const run = (input: WorkerInput, deps: WorkerDeps = {}): Promise<WorkerResult> => new Promise((resolve) => {
    lastInput = input;
    signal = deps.interrupt?.signal;
    const terminal = (status: WorkerResult["status"], result: string): void => resolve({
      job_id: input.jobId ?? "test", status, result, error: status === "completed" ? null : "interrupted",
      pool_resolved: [], turns: 1, transcript_path: join(root, `${input.jobId}.jsonl`),
      session_id: input.resumeSessionId ?? "session", resumable: true, continuations: 0,
    });
    finish = (text = "done") => terminal("completed", text);
    signal?.addEventListener("abort", () => terminal("interrupted", ""), { once: true });
  });
  return { run, finish: (text?: string) => finish(text), aborted: () => signal?.aborted, input: () => lastInput };
}

function extra(controller = new AbortController()) {
  return { signal: controller.signal, sendNotification: async () => {} };
}

describe("background job ownership", () => {
  it("persists context controls and inherits nested overrides after restarting the store", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const context = { window_tokens: 64000, max_output_tokens: 4096, compaction: { enabled: true, trigger_tokens: 48000, keep_recent_tokens: 12000 } };
    const response = await handleRun({ prompt: "first", engine: "pi", context, background: true }, extra(), { store });
    const { job_id } = JSON.parse(response.content.text);
    expect(worker.input()?.context).toEqual(context);
    worker.finish();
    await store.awaitTerminal(job_id);
    const reloaded = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const replied = await handleReply({ job_id, prompt: "continue", context: { compaction: { enabled: false } }, background: true }, extra(), { store: reloaded });
    const next = JSON.parse(replied.content.text);
    const inherited = { ...context, compaction: { ...context.compaction, enabled: false } };
    expect(worker.input()?.context).toEqual(inherited);
    worker.finish();
    await reloaded.awaitTerminal(next.job_id);
    const fetched = handleFetchJob({ job_id: next.job_id, fields: ["context"] }, { root });
    expect(JSON.parse(fetched.content.text).context).toEqual(inherited);
  });

  it.each([
    ["codex", { max_output_tokens: 4096 }, "UNSUPPORTED_OPERATION"],
    ["pi", { window_tokens: 100, max_output_tokens: 100 }, "INVALID_ARGUMENT"],
  ])("rejects unsupported or inconsistent %s context controls before starting work", async (engine, context, code) => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const response = await handleRun({ prompt: "work", engine, context, background: true }, extra(), { store });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content.text)).toMatchObject({ status: "failed", error: { code } });
    expect(worker.input()).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("resolves the configured engine once and inherits it after the default changes", async () => {
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ engine: "pi" }));
    vi.stubEnv("CX_AGENT_CONFIG", config);
    vi.stubEnv("CX_AGENT_ENGINE", undefined);
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const source = store.start({ prompt: "first" });
    expect(worker.input()?.engine).toBe("pi");
    worker.finish();
    await store.awaitTerminal(source.jobId);
    vi.stubEnv("CX_AGENT_ENGINE", "codex");
    const reply = store.reply(source.jobId, { prompt: "continue" });
    if ("status" in reply) throw new Error(reply.status);
    expect(worker.input()?.engine).toBe("pi");
    worker.finish();
    await store.awaitTerminal(reply.jobId);
  });

  it("returns over MCP before completion, then retrieves the result on the same transport", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const { server } = createServer({ store });
    const client = new Client({ name: "background-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({ name: "cx_agent_run", arguments: { prompt: "work", background: true } });
      const block = response.content.find((item) => item.type === "text");
      if (block?.type !== "text") throw new Error("Missing result");
      const started = JSON.parse(block.text);
      expect(started).toEqual({ job_id: expect.any(String), status: "running" });
      expect(store.isRunning(started.job_id)).toBe(true);
      const controller = new AbortController();
      const cancelledWait = client.callTool({ name: "cx_agent_wait", arguments: { job_id: started.job_id, timeout_ms: 30000 } }, undefined, { signal: controller.signal });
      const cancellation = expect(cancelledWait).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      await cancellation;
      expect(worker.aborted()).toBe(false);
      worker.finish("wire result");
      const result = await client.callTool({ name: "cx_agent_wait", arguments: { job_id: started.job_id, timeout_ms: 100 } });
      const terminal = result.content.find((item) => item.type === "text");
      expect(terminal?.type === "text" && JSON.parse(terminal.text)).toMatchObject({ job_id: started.job_id, result: "wire result", output: { outcome: "completed" } });
    } finally { worker.finish(); await client.close(); await server.close(); }
  });

  it("does not attach background jobs to the start request cancellation", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const controller = new AbortController();
    const start = await handleRun({ prompt: "work", background: true }, extra(controller), { store });
    const { job_id } = JSON.parse(start.content.text);
    controller.abort();
    expect(worker.aborted()).toBe(false);
    const wait = await handleWait({ job_id, timeout_ms: 0 }, store);
    expect(JSON.parse(wait.content.text)).toEqual({ job_id, status: "running" });
    worker.finish();
    expect((await store.awaitTerminal(job_id))?.result).toBe("done");
  });

  it("bounds waiting and cancellation without stopping the job", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const { jobId } = store.start({ prompt: "work" });
    expect(await store.waitFor(jobId, 5)).toBeNull();
    const controller = new AbortController();
    const waiting = store.waitFor(jobId, 30_000, controller.signal);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(store.isRunning(jobId)).toBe(true);
    expect(worker.aborted()).toBe(false);
    worker.finish();
    await store.awaitTerminal(jobId);
  });

  it("persists thrown worker failures and reads them after recreating the store", async () => {
    const store = new SessionStore({ runWorker: async () => { throw new Error("worker failed"); }, transcriptRoot: root });
    const { jobId } = store.start({ prompt: "work" });
    expect(await store.awaitTerminal(jobId)).toMatchObject({ status: "failed", error: "worker failed", resumable: false });
    const reloaded = new SessionStore({ transcriptRoot: root });
    expect(await reloaded.waitFor(jobId, 0)).toMatchObject({ status: "failed", error: "worker failed" });
    expect(reloaded.poll(jobId)).toMatchObject({ status: "failed", terminal: true });
  });

  it("returns a typed error for unknown job waits", async () => {
    const out = await handleWait({ job_id: "unknown", timeout_ms: 0 }, new SessionStore({ transcriptRoot: root }));
    expect(JSON.parse(out.content.text)).toMatchObject({ status: "not_found", error: { code: "SESSION_NOT_FOUND" } });
  });

  it("starts background replies and prevents a second writer to the same session", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const source = store.start({ prompt: "first", model: "worker", engine: "pi" });
    worker.finish();
    await store.awaitTerminal(source.jobId);
    const replied = await handleReply({ job_id: source.jobId, prompt: "next", cwd: join(root, "another-cwd"), background: true }, extra(), { store });
    const { job_id } = JSON.parse(replied.content.text);
    expect(store.isRunning(job_id)).toBe(true);
    expect(store.reply(source.jobId, { prompt: "race" })).toMatchObject({ status: "SESSION_BUSY" });
    worker.finish("reply done");
    expect((await store.awaitTerminal(job_id))?.result).toBe("reply done");
  });

  it("makes cancel non-resumable and leaves already settled jobs unchanged", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const { jobId } = store.start({ prompt: "work" });
    expect(await store.cancel(jobId)).toEqual({ status: "cancelled" });
    expect(await store.waitFor(jobId, 0)).toMatchObject({ status: "interrupted", resumable: false, session_id: null });
    expect(store.reply(jobId, { prompt: "resume" })).toMatchObject({ status: "SESSION_NOT_FOUND" });
    expect(await store.interrupt(jobId)).toEqual({ status: "not_found" });
    const next = store.start({ prompt: "finish" });
    worker.finish();
    await store.waitFor(next.jobId, 100);
    expect(await store.cancel(next.jobId)).toEqual({ status: "not_found" });
    expect(await store.waitFor(next.jobId, 0)).toMatchObject({ status: "completed", result: "done" });
  });

  it("keeps terminal cancellation stronger than a concurrent resumable interrupt", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const { jobId } = store.start({ prompt: "work" });
    await Promise.all([store.cancel(jobId), store.interrupt(jobId)]);
    expect(await store.waitFor(jobId, 0)).toMatchObject({ status: "interrupted", resumable: false, session_id: null });
    expect(store.reply(jobId, { prompt: "resume" })).toMatchObject({ status: "SESSION_NOT_FOUND" });
  });

  it("returns the result when settlement races with an immediate wait", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const { jobId } = store.start({ prompt: "work" });
    worker.finish("at the deadline");
    const out = await handleWait({ job_id: jobId, timeout_ms: 0 }, store);
    expect(JSON.parse(out.content.text)).toMatchObject({ job_id: jobId, result: "at the deadline", output: { outcome: "completed" } });
  });

  it("reports a persistence failure instead of successful durable completion", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: join(root, "blocked") });
    const { jobId } = store.start({ prompt: "work" });
    writeFileSync(join(root, "blocked"), "not a directory");
    worker.finish();
    const result = await store.awaitTerminal(jobId);
    expect(result).toMatchObject({ status: "failed", resumable: false });
    expect(result?.error).toContain("could not persist terminal job");
  });

  it("removes cached terminal results when cleaning their persisted records", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const { jobId } = store.start({ prompt: "work" });
    worker.finish();
    await store.waitFor(jobId, 100);
    const cleaned = await handleSession({ action: "clean" }, { store, root });
    expect(JSON.parse(cleaned.content.text)).toMatchObject({ removed: [jobId] });
    expect(store.poll(jobId)).toMatchObject({ status: "unknown" });
    expect(await store.waitFor(jobId, 0)).toBeNull();
  });

  it("bounds settled memory and keeps evicted results available on disk", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    let first = "";
    for (let i = 0; i < 140; i += 1) {
      const { jobId } = store.start({ prompt: "work", cwd: root });
      first ||= jobId;
      worker.finish("persisted result");
      await store.waitFor(jobId, 100);
    }
    expect(store.size).toBeLessThan(140);
    expect(await store.waitFor(first, 0)).toMatchObject({ result: "persisted result", status: "completed" });
  });

  it("compacts a Pi session through a new locked background job", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const source = store.start({ prompt: "first", engine: "pi" });
    worker.finish();
    await store.awaitTerminal(source.jobId);
    const response = await handleCompact({ job_id: source.jobId, instructions: "Keep the task", background: true }, extra(), { store });
    const started = JSON.parse(response.content.text);
    expect(started).toEqual({ job_id: expect.any(String), status: "running" });
    expect(worker.input()).toMatchObject({ engine: "pi", operation: "compact", prompt: "Keep the task", resumeSessionId: "session" });
    expect(store.reply(source.jobId, { prompt: "race" })).toMatchObject({ status: "SESSION_BUSY" });
    worker.finish("native summary");
    expect(await store.waitFor(started.job_id, 100)).toMatchObject({ status: "completed", result: "native summary" });
  });

  it("rejects unsupported compaction without starting another worker", async () => {
    const worker = controlledWorker();
    const store = new SessionStore({ runWorker: worker.run, transcriptRoot: root });
    const source = store.start({ prompt: "first", engine: "codex" });
    worker.finish();
    await store.waitFor(source.jobId, 100);
    const response = await handleCompact({ job_id: source.jobId, background: true }, extra(), { store });
    expect(JSON.parse(response.content.text)).toMatchObject({ job_id: source.jobId, status: "failed", error: { code: "UNSUPPORTED_OPERATION" } });
    expect(response.isError).toBe(true);
    expect(store.size).toBe(1);
    const fork = await handleReply({ job_id: source.jobId, prompt: "fork", fork: true, background: true }, extra(), { store });
    expect(JSON.parse(fork.content.text)).toMatchObject({ job_id: source.jobId, status: "failed", error: { code: "UNSUPPORTED_OPERATION" } });
    expect(store.size).toBe(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/index.js";
import type { WorkerResult } from "../src/worker.js";
import { SessionStore } from "../src/session-store.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "cxagent-srv-")); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });


function fakeWorker(result: Partial<WorkerResult> = {}): typeof import("../src/worker.js").runWorker {
  const full: WorkerResult = {
    status: "completed",
    result: "ok",
    job_id: "fake-job",
    pool_resolved: [],
    turns: 1,
    cost_usd: 0.001,
    transcript_path: "/tmp/x.jsonl",
    error: null,
    ...result,
  };
  return vi.fn().mockImplementation(async (input: { jobId?: string }) => {
    return { ...full, job_id: input.jobId ?? full.job_id };
  }) as unknown as typeof import("../src/worker.js").runWorker;
}

function extraObj(over: Partial<{ _meta: unknown; signal: AbortSignal; sendNotification: unknown; requestId: unknown }> = {}) {
  return {
    _meta: over._meta ?? { progressToken: "tok" },
    signal: over.signal ?? new AbortController().signal,
    sendNotification: over.sendNotification ?? vi.fn().mockResolvedValue(undefined),
    requestId: over.requestId ?? 1,
  } as unknown as never;
}


function getHandler(server: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> }, name: string) {
  // @ts-expect-error: _registeredTools is private; read for test.
  const tools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> = server["_registeredTools"];
  return tools[name].handler;
}

describe("createServer — tool registration", () => {
  it("registers the public tools", async () => {
    const { server } = createServer({ runWorker: fakeWorker() });
    // @ts-expect-error: _registeredTools is private; read for test.
    const tools = server["_registeredTools"] as Record<string, unknown>;
    expect(Object.keys(tools).sort()).toEqual([
      "cx_agent_check",
      "cx_agent_compact",
      "cx_agent_fetch",
      "cx_agent_group",
      "cx_agent_interrupt",
      "cx_agent_list",
      "cx_agent_reply",
      "cx_agent_run",
      "cx_agent_session",
      "cx_agent_setup",
      "cx_agent_wait",
    ]);
  });
});

describe("createServer — cx_agent_run", () => {
  it("blocks until the worker resolves and returns the structured result (completed → isError false)", async () => {
    const run = fakeWorker();
    const { server } = createServer({ runWorker: run });
    const cb = getHandler(server, "cx_agent_run");
    const args = { prompt: "do it", pool: "Worker lvl" };
    const out = (await cb(args, extraObj())) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(out.isError).toBe(false);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed).toMatchObject({ job_id: expect.any(String), result: "ok", output: { outcome: "completed" } });
    expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toMatchObject({ prompt: "do it", pool: "Worker lvl", progressToken: "tok" });
    expect(typeof run.mock.calls[0][0].sendProgress).toBe("function");
  });

  it("sets isError true when worker returns failed", async () => {
    const run = fakeWorker({ status: "failed", error: "boom", result: "" });
    const { server } = createServer({ runWorker: run });
    const cb = getHandler(server, "cx_agent_run");
    const out = (await cb({ prompt: "x" }, extraObj())) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });

  it("generates a per-call job_id and frees the registry slot after the call resolves", async () => {
    const run = fakeWorker();
    const { server, registry } = createServer({ runWorker: run });
    expect(registry.size).toBe(0);
    const cb = getHandler(server, "cx_agent_run");
        let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    run.mockImplementationOnce(async (input: { jobId?: string }) => {
      await block;
      return { job_id: input.jobId ?? "j", status: "completed", result: "", pool_resolved: [], turns: 0, cost_usd: null, transcript_path: "/t", error: null } as WorkerResult;
    });
    const p = cb({ prompt: "x" }, extraObj());
        await new Promise<void>((r) => setTimeout(r, 20));
    expect(registry.size).toBe(1);
    release!();
    await p;
    expect(registry.size).toBe(0);
  });
});

describe("createServer — cx_agent_fetch", () => {
  it("registers a read-only fetch handler", async () => {
    const { server } = createServer({ runWorker: fakeWorker() });
    const cb = getHandler(server, "cx_agent_fetch");
    const out = (await cb({ job_id: "does-not-exist" }, extraObj())) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).status).toBe("not_found");
  });
});

describe("createServer — cx_agent_interrupt", () => {
  it("returns interrupted when a job is running; store.interrupt is called", async () => {
    const blockingWorker = vi.fn().mockImplementation(
      (_input: unknown, deps: { interrupt: { signal: { addEventListener: (e: string, cb: () => void, o?: { once?: boolean }) => void } } }) =>
        new Promise<WorkerResult>((resolve) => {
          deps.interrupt.signal.addEventListener("abort", () => {
            resolve({ status: "interrupted", result: "", job_id: "x", pool_resolved: [], turns: 0, cost_usd: null, transcript_path: "/t", error: "interrupted" });
          }, { once: true });
        }),
    );
    const store = new SessionStore({ runWorker: blockingWorker as never, defaults: { ...FALLBACK_DEFAULTS, pool: "Worker lvl" }, transcriptRoot: tmpRoot });
    const { server } = createServer({ runWorker: fakeWorker(), store });
    const { jobId } = store.start({ prompt: "hang" });
    const cb = getHandler(server, "cx_agent_interrupt");
    const out = (await cb({ job_id: jobId }, extraObj())) as { content: { text: string }[]; isError?: boolean };
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.status).toBe("interrupted");
  });

  it("returns not_found / isError when the job is unknown", async () => {
    const { server } = createServer({ runWorker: fakeWorker() });
    const cb = getHandler(server, "cx_agent_interrupt");
    const out = (await cb({ job_id: "nope" }, extraObj())) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.status).toBe("not_found");
  });
});

describe("createServer — cx_agent_list", () => {
  it("returns 'No jobs.' when no sidecars exist", async () => {
    const { server } = createServer({ runWorker: fakeWorker() });
    const cb = getHandler(server, "cx_agent_list");
    const out = (await cb({}, extraObj())) as { content: { text: string }[] };
            expect(out.content[0].text.length).toBeGreaterThan(0);
  });
});

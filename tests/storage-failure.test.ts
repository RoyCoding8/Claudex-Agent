import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { SessionStore } from "../src/session-store.js";
import { Transcript } from "../src/transcript.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import { handleSession } from "../src/tools.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-agent-storage-failure-"));
  vi.stubEnv("CX_AGENT_DEPTH", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("Session storage failure handling", () => {
  it.each(["resume", "new work"])("blocks %s after a terminal write failure and cache eviction", async (action) => {
    const writeMeta = Transcript.prototype.writeMeta;
    let terminalWrites = 0;
    vi.spyOn(Transcript.prototype, "writeMeta").mockImplementation(function (meta) {
      if (meta.status === "completed" && ++terminalWrites === 2) throw new Error("store write failed");
      return writeMeta.call(this, meta);
    });
    const store = new SessionStore({ transcriptRoot: root, runWorker: async (input) => {
      const jobId = input.jobId ?? "source";
      new Transcript(jobId, { root }).writeMeta({ job_id: jobId, status: "completed", engine: "pi", pool: "model", pool_resolved: [],
        cwd: root, started_at: "2026-11-05T00:00:00Z", ended_at: "2026-11-05T00:00:01Z", turns: 1, error: null,
        session_id: "native-session", resumable: true,
      });
      return { job_id: jobId, status: "completed", result: "done", error: null, pool_resolved: [], turns: 1,
        transcript_path: join(root, `${jobId}.jsonl`), session_id: "native-session", resumable: true, continuations: 0 };
    } });
    const source = store.start({ prompt: "work", engine: "pi" });
    expect(await store.waitFor(source.jobId, 100)).toMatchObject({ status: "failed", resumable: false });
    expect(store.readMeta(source.jobId)).toMatchObject({ status: "completed", resumable: true });
    await store.awaitTerminal(source.jobId);
    if (action === "resume") {
      expect(store.reply(source.jobId, { prompt: "continue" })).toMatchObject({ status: "SESSION_BUSY", reason: "storage_fault" });
    } else {
      expect(() => store.start({ prompt: "new work", engine: "pi" })).toThrow("could not persist terminal job");
    }
  });

  it("does not acknowledge durable cancellation when the final store write fails", async () => {
    let announceSession: () => void = () => {};
    const ready = new Promise<void>((resolve) => { announceSession = resolve; });
    const queryFn = (({ options }: { options?: Options }) => (async function* () {
      yield { type: "system", subtype: "init", session_id: "native-session" } as SDKMessage;
      const signal = options?.abortController?.signal;
      const stopped = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      announceSession();
      await stopped;
      throw new Error("SDK observed abort");
    })()) as unknown as typeof query;
    const store = new SessionStore({ transcriptRoot: root, defaults: { ...FALLBACK_DEFAULTS, pool: "test-model" },
      validate: async () => {}, provider: { id: "local-test-fixture", discover: async () => ({ ready: true, models: [], diagnostics: [] }),
        connection: async (model) => ({ model, baseUrl: "http://127.0.0.1:1", apiKey: "unused" }) },
    });
    const writeMeta = Transcript.prototype.writeMeta;
    vi.spyOn(Transcript.prototype, "writeMeta").mockImplementation(function (meta) {
      if (meta.status === "interrupted" && meta.resumable === false) throw new Error("final metadata write denied");
      return writeMeta.call(this, meta);
    });
    const source = store.start({ prompt: "wait", queryFn, engine: "claude" });
    await ready;
    const cancelled = await handleSession({ action: "cancel", job_id: source.jobId }, { store, root });
    expect(store.readMeta(source.jobId)).toMatchObject({ status: "interrupted", resumable: true });
    expect(cancelled.isError).toBe(true);
    expect(JSON.parse(cancelled.content.text)).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(store.getTerminal(source.jobId)).toMatchObject({ status: "failed", resumable: false, session_id: null });
    await store.awaitTerminal(source.jobId);
    expect(store.reply(source.jobId, { prompt: "resume" })).toMatchObject({ status: "SESSION_BUSY", reason: "storage_fault" });
  });

  it("rejects an orphaned running sidecar after recreating the store", async () => {
    new Transcript("orphaned-job", { root }).writeMeta({
      job_id: "orphaned-job", engine: "pi", status: "running", pool: "test-model", pool_resolved: [], cwd: root,
      started_at: "2026-11-05T00:00:00Z", ended_at: null, turns: 1, error: null,
      session_id: "orphaned-native-session", resumable: true,
    });
    const runWorker = vi.fn(async () => { throw new Error("must not start a worker"); });
    const store = new SessionStore({ transcriptRoot: root, runWorker });
    const reply = store.reply("orphaned-job", { prompt: "continue" });
    if (!("status" in reply)) await store.awaitTerminal(reply.jobId);
    expect(reply).toMatchObject({ status: "SESSION_BUSY", reason: "not_terminal" });
    expect(runWorker).not.toHaveBeenCalled();
  });
});

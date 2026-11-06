import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.js";
import { observeCompletions, completionDelivery } from "../src/completion.js";
import { collectOutput, reportDestination } from "../src/output.js";
import { FALLBACK_DEFAULTS } from "../src/settings.js";
import type { WorkerInput, WorkerResult } from "../src/worker.js";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "cx-completion-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function result(input: WorkerInput): WorkerResult {
  return { job_id: input.jobId!, status: "completed", result: '{"unresolved_questions":["Check streaming"]}', turns: 1, pool_resolved: ["m"],
    session_id: "s", resumable: true, error: null, continuations: 0, transcript_path: join(root, "jobs", `${input.jobId}.jsonl`) };
}

it("publishes the assigned new report before notifying the host and persists output across restart", async () => {
  const jobs = join(root, "jobs");
  const report = join(root, "report.md");
  const store = new SessionStore({ defaults: FALLBACK_DEFAULTS, transcriptRoot: jobs, runWorker: async (input) => result(input) });
  const calls: string[] = [];
  observeCompletions(store, (notice) => {
    expect(store.readMeta(notice.job_id)?.status).toBe("completed");
    expect(readFileSync(report, "utf8")).toContain("Check streaming");
    expect(notice).toMatchObject({ event_id: `${notice.job_id}:terminal`, needs_help: false, output: { outcome: "completed", unresolved_questions: ["Check streaming"] } });
    calls.push(notice.job_id);
  });
  const { jobId } = store.start({ prompt: "inspect", engine: "pi", cwd: root, background: true, access: { mode: "read-only", report_path: report } });
  const final = await store.awaitTerminal(jobId);
  expect(calls).toEqual([jobId]);
  expect(final?.output?.artifacts).toEqual([{ path: report, exists: true, bytes: 44, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  const restarted = new SessionStore({ transcriptRoot: jobs, runWorker: async (input) => {
    expect(input.access).toEqual({ mode: "read-only" });
    return result(input);
  } });
  expect(restarted.getTerminal(jobId)?.output).toEqual(final?.output);
  const resumed = restarted.reply(jobId, { prompt: "next", engine: "pi" });
  expect("jobId" in resumed).toBe(true);
  if ("jobId" in resumed) { expect((await restarted.awaitTerminal(resumed.jobId))?.status).toBe("completed"); }
}, 15000);

it("isolates a failing host adapter and explicitly advertises the wait-only default", async () => {
  const store = new SessionStore({ transcriptRoot: join(root, "jobs"), runWorker: async (input) => result(input) });
  const failed = vi.fn();
  observeCompletions(store, () => { throw new Error("host unavailable"); }, failed);
  const { jobId } = store.start({ prompt: "x", cwd: root, background: true });
  expect((await store.awaitTerminal(jobId))?.status).toBe("completed");
  expect(failed).toHaveBeenCalledOnce();
  expect(completionDelivery()).toMatchObject({ parent_resume: false, mode: "wait-only" });
  const foreground = store.start({ prompt: "foreground", cwd: root });
  await store.awaitTerminal(foreground.jobId);
  expect(failed).toHaveBeenCalledOnce();
});

it("rejects report collisions and redirected directories before calling the worker", () => {
  const run = vi.fn();
  const jobs = join(root, "jobs");
  const store = new SessionStore({ transcriptRoot: jobs, runWorker: run });
  writeFileSync(join(root, "owned.md"), "keep");
  expect(() => store.start({ prompt: "x", access: { mode: "read-only", report_path: join(root, "owned.md") } })).toThrow(/new file/);
  expect(() => reportDestination(join(jobs, "anything"), root, jobs)).toThrow(/job storage/);
  mkdirSync(join(root, "real"));
  mkdirSync(join(root, "real", "nested"));
  symlinkSync(join(root, "real"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  expect(reportDestination(join(root, "real", "nested", "out.md"), root, jobs)).toBe(join(root, "real", "nested", "out.md"));
  expect(() => reportDestination(join(root, "link", "out.md"), root, jobs)).toThrow(/symlinks|redirected/);
  expect(() => reportDestination(join(root, "link", "nested", "out.md"), root, jobs)).toThrow(/symlinks|redirected/);
  expect(run).not.toHaveBeenCalled();
  expect(existsSync(join(root, "link", "out.md"))).toBe(false);
});

it("keeps an external file intact when it appears after report preflight", async () => {
  const report = join(root, "report.md");
  let finish!: (value: WorkerResult) => void;
  let workerInput!: WorkerInput;
  const store = new SessionStore({ transcriptRoot: join(root, "jobs"), runWorker: async (input) => {
    workerInput = input;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const { jobId } = store.start({ prompt: "x", cwd: root, access: { mode: "read-only", report_path: report } });
  writeFileSync(report, "external");
  finish(result(workerInput));
  expect((await store.awaitTerminal(jobId))?.status).toBe("failed");
  expect(readFileSync(report, "utf8")).toBe("external");
});

it("uses null for unreported questions and hashes caller-selected artifacts", () => {
  const path = join(root, "artifact.txt");
  writeFileSync(path, "abc");
  const output = collectOutput({ source_revision: null, source_dirty: null }, "completed", "ordinary text", [path], root);
  expect(output.unresolved_questions).toBeNull();
  expect(output.artifacts[0]).toEqual({ path, exists: true, bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
});

it("rejects duplicate report ownership including Windows case aliases", async () => {
  const report = join(root, "Report.md");
  const alias = process.platform === "win32" ? join(root, "report.md") : report;
  const run = vi.fn(async (input: WorkerInput) => result(input));
  const store = new SessionStore({ transcriptRoot: join(root, "jobs"), runWorker: run });
  const first = store.start({ prompt: "first", cwd: root, access: { mode: "read-only", report_path: report } });
  expect(() => store.start({ prompt: "second", cwd: root, access: { mode: "read-only", report_path: alias } })).toThrow(/already assigned/);
  expect((await store.awaitTerminal(first.jobId))?.status).toBe("completed");
  expect(run).toHaveBeenCalledOnce();
});

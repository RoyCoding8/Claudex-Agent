import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupCoordinator } from "../src/group-coordinator.js";
import { SessionStore } from "../src/session-store.js";
import type { WorkerInput, WorkerResult } from "../src/worker.js";

let root: string;
let calls: Array<{ input: WorkerInput; resolve: (result: WorkerResult) => void }>;

function makeResult(input: WorkerInput, status: WorkerResult["status"], result: string, error: string | null = null): WorkerResult {
  return {
    status, result, error, job_id: input.jobId!, pool_resolved: ["test-model"], turns: 1,
    transcript_path: join(root, `${input.jobId}.jsonl`), session_id: null, resumable: false, continuations: 0,
  };
}

function createStore(options: { syncThrow?: string } = {}): SessionStore {
  return new SessionStore({
    transcriptRoot: root,
    runWorker: (input) => {
      if (options.syncThrow) throw new Error(options.syncThrow);
      return new Promise<WorkerResult>((resolve) => calls.push({ input, resolve }));
    },
  });
}

function input(prompt: string, access?: WorkerInput["access"], cwd = root) {
  return { prompt, engine: "claude" as const, model: "test-model", cwd, access };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function settle(index: number, status: WorkerResult["status"], result: string, error: string | null = null): void {
  const call = calls[index];
  if (!call) throw new Error(`No worker at index ${index}.`);
  call.resolve(makeResult(call.input, status, result, error));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-agent-groups-")));
  calls = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("GroupCoordinator", () => {
  it("preflights the whole DAG before launching any worker", () => {
    const store = createStore();
    const groups = new GroupCoordinator(store, { root });
    expect(() => groups.create({ name: "invalid", tasks: [
      { name: "valid", input: input("secret prompt") },
      { name: "bad", input: { ...input("bad engine"), engine: "unknown" as "claude" } },
    ] })).toThrow(/Unknown worker engine/);
    expect(calls).toHaveLength(0);
    expect(readdirSync(root).filter((name) => name.endsWith(".group.json"))).toHaveLength(0);

    expect(() => groups.create({ name: "cycle", tasks: [
      { name: "a", input: input("a"), depends_on: ["b"] },
      { name: "b", input: input("b"), depends_on: ["a"] },
    ] })).toThrow(/cycle/);
    expect(calls).toHaveLength(0);
    const reportStem = `cx-agent-report-${randomUUID()}`;
    const reportDir = realpathSync(tmpdir());
    const firstPath = join(reportDir, `${reportStem}.json`);
    const secondPath = process.platform === "win32" ? join(reportDir, `${reportStem.toUpperCase()}.JSON`) : firstPath;
    expect(() => groups.create({ name: "duplicate-report", max_parallel: 1, tasks: [
      { name: "active", input: input("one", { mode: "read-only", report_path: firstPath }, reportDir) },
      { name: "queued", input: input("two", { mode: "read-only", report_path: secondPath }, reportDir) },
    ] })).toThrow(/same report_path/);
    expect(calls).toHaveLength(0);
    groups.close();
  });

  it("runs independent tasks in parallel and starts synthesis after every dependency succeeds", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    const group = groups.create({ name: "review", max_parallel: 2, tasks: [
      { name: "methods", input: input("review methods") },
      { name: "claims", input: input("review claims") },
      { name: "synthesis", input: input("synthesize"), depends_on: ["methods", "claims"] },
    ] });
    expect(calls.map((call) => call.input.prompt)).toEqual(["review methods", "review claims"]);
    expect(group.counts).toMatchObject({ running: 2, queued: 1 });

    settle(0, "completed", "Methods found one limitation.");
    await flush();
    expect(calls).toHaveLength(2);
    settle(1, "completed", "Claims match the results.");
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.input.prompt).toContain("Methods found one limitation.");
    expect(calls[2]!.input.prompt).toContain("Claims match the results.");
    settle(2, "completed", "Combined finding.");
    await flush();
    expect(groups.snapshot(group.group_id)).toMatchObject({ status: "completed", counts: { completed: 3, running: 0, failed: 0, blocked: 0, queued: 0 } });
    groups.close();
  });

  it("caps dependency prompt context per task and in aggregate", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    groups.create({ name: "bounded", max_parallel: 2, tasks: [
      { name: "a", input: input("a") },
      { name: "b", input: input("b") },
      { name: "s", input: input("s"), depends_on: ["a", "b"] },
    ] });
    settle(0, "completed", "A".repeat(8_000));
    settle(1, "completed", "B".repeat(8_000));
    await flush();
    const prompt = calls[2]!.input.prompt;
    expect(prompt.length - "s".length).toBeLessThanOrEqual(DEPENDENCY_TOTAL_BOUND);
    expect(prompt.match(/A/g)?.length).toBeLessThanOrEqual(2_048);
    expect(prompt.match(/B/g)?.length).toBeLessThanOrEqual(2_048);
    groups.close();
  });

  it("blocks dependents on unsuccessful terminals while continuing independent work", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    const group = groups.create({ name: "partial", max_parallel: 1, tasks: [
      { name: "first", input: input("first") },
      { name: "dependent", input: input("dependent"), depends_on: ["first"] },
      { name: "independent", input: input("independent") },
    ] });
    settle(0, "incomplete", "partial", "budget stopped");
    await flush();
    expect(calls.map((call) => call.input.prompt)).toEqual(["first", "independent"]);
    const status = groups.snapshot(group.group_id)!;
    expect(status.tasks.dependent).toMatchObject({ status: "blocked", reason: /first/ });
    expect(status).toMatchObject({ status: "running", counts: { running: 1, blocked: 1, failed: 1 } });
    settle(1, "completed", "independent done");
    await flush();
    expect(groups.snapshot(group.group_id)?.status).toBe("failed");
    groups.close();
  });

  it("delivers terminal events by cursor and leaves tasks running on timeout or abort", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    const group = groups.create({ name: "cursor", tasks: [{ name: "one", input: input("one") }] });
    const waiting = groups.waitAny(group.group_id, 0, 5_000);
    settle(0, "completed", "done");
    const result = await waiting;
    expect(result?.events).toHaveLength(1);
    expect(result?.events[0]).toMatchObject({ task: "one", status: "completed", job_id: calls[0]!.input.jobId });
    expect(result?.next_cursor).toBe(1);
    expect((await groups.waitAny(group.group_id, 0, 0))?.events).toEqual(result?.events);
    expect((await groups.waitAny(group.group_id, 1, 0))?.events).toEqual([]);
    const alreadyDone = await Promise.race([
      groups.waitAny(group.group_id, 1, 30_000),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(alreadyDone).not.toBe("timeout");
    expect((await groups.waitAny(group.group_id, 10, 0))?.next_cursor).toBe(10);

    const other = groups.create({ name: "abort", tasks: [{ name: "waiting", input: input("waiting") }] });
    const controller = new AbortController();
    const aborted = groups.waitAny(other.group_id, 0, 5_000, controller.signal);
    controller.abort();
    expect((await aborted)?.tasks.waiting?.status).toBe("running");
    expect(groups.snapshot(other.group_id)?.tasks.waiting?.status).toBe("running");
    groups.close();
  });

  it("recovers terminal job metadata and blocks queued work without relaunching after restart", () => {
    const store = createStore({ syncThrow: "synchronous worker failure" });
    const first = new GroupCoordinator(store, { root });
    const group = first.create({ name: "restart", tasks: [
      { name: "failed-at-start", input: input("must not persist") },
      { name: "queued", input: input("also secret"), depends_on: ["failed-at-start"] },
    ] });
    first.close();
    const recovered = new GroupCoordinator(createStore(), { root });
    const next = recovered.snapshot(group.group_id)!;
    expect(next.tasks["failed-at-start"]?.status).toBe("failed");
    expect(next.tasks.queued).toMatchObject({ status: "blocked", reason: /server restarted/ });
    expect(calls).toHaveLength(0);
    const persisted = readFileSync(join(root, `${group.group_id}.group.json`), "utf8");
    expect(persisted).not.toContain("must not persist");
    expect(persisted).not.toContain("also secret");
    expect(next.cursor).toBe(2);
    recovered.close();
  });

  it("persists bounded terminal event records with atomic replacement", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    const group = groups.create({ name: "sidecar", tasks: [{ name: "report", input: input("private prompt") }] });
    settle(0, "completed", "x".repeat(20_000));
    await flush();
    const path = join(root, `${group.group_id}.group.json`);
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { events: Array<{ summary: string }>; cursor: number };
    expect(persisted.cursor).toBe(1);
    expect(persisted.events[0]!.summary.length).toBeLessThanOrEqual(256);
    expect(readFileSync(path, "utf8")).not.toContain("private prompt");
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
    groups.close();
  });

  it("drains more than one page of events without advancing past undelivered results", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    const group = groups.create({ name: "paged", max_parallel: 16,
      tasks: Array.from({ length: 17 }, (_, n) => ({ name: `task-${n}`, input: input(`task-${n}`) })) });
    for (let n = 0; n < 16; n++) settle(n, "completed", `result-${n}`);
    await flush();
    settle(16, "completed", "result-16");
    await flush();
    const first = await groups.waitAny(group.group_id, 0, 0);
    expect(first?.events).toHaveLength(16);
    expect(first?.next_cursor).toBe(16);
    const second = await groups.waitAny(group.group_id, first!.next_cursor, 0);
    expect(second?.events.map((event) => event.task)).toEqual(["task-16"]);
    expect(second?.next_cursor).toBe(17);
    expect((await groups.waitAny(group.group_id, 0, 0))?.events).toEqual(first?.events);
    groups.close();
  });

  it("ignores corrupted restart records without writing through their identifiers", () => {
    const first = new GroupCoordinator(createStore(), { root });
    const group = first.create({ name: "restart", tasks: [{ name: "one", input: input("private") }] });
    first.close();
    const path = join(root, `${group.group_id}.group.json`);
    const valid = JSON.parse(readFileSync(path, "utf8"));
    for (const corrupt of [
      { ...valid, group_id: "../escape" },
      { ...valid, cursor: 8 },
      { ...valid, tasks: [{ ...valid.tasks[0], depends_on: ["one"] }] },
      { ...valid, tasks: [{ ...valid.tasks[0], state: { ...valid.tasks[0].state, started_at: "bad date" } }] },
    ]) {
      writeFileSync(path, JSON.stringify(corrupt));
      const recovered = new GroupCoordinator(createStore(), { root });
      expect(recovered.snapshot(group.group_id)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(corrupt));
      recovered.close();
    }
    expect(calls).toHaveLength(1);
  });

  it("fails closed when a settlement cannot persist the group transition", async () => {
    const groups = new GroupCoordinator(createStore(), { root });
    const group = groups.create({ name: "storage-fault", tasks: [
      { name: "first", input: input("first") },
      { name: "dependent", input: input("dependent"), depends_on: ["first"] },
    ] });
    const sidecar = join(root, `${group.group_id}.group.json`);
    unlinkSync(sidecar);
    mkdirSync(sidecar);
    settle(0, "completed", "first complete");
    await flush();
    expect(calls).toHaveLength(1);
    expect(groups.snapshot(group.group_id)).toMatchObject({ status: "blocked", cursor: 0, persistence_error: expect.any(String), counts: { queued: 1, running: 1 } });
    expect((await groups.waitAny(group.group_id, 0, 30_000))?.events).toEqual([]);
    groups.close();
  });
});

const DEPENDENCY_TOTAL_BOUND = 8_192 + 64;

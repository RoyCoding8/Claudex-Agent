import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactText } from "./retention.js";
import type { SessionStore, SessionStoreInput } from "./session-store.js";
import type { WorkerResult } from "./worker.js";

const TASK_NAME_LIMIT = 64;
const TASK_COUNT_LIMIT = 64;
const PARALLEL_LIMIT = 16;
const EVENT_RESPONSE_LIMIT = 16;
const EVENT_SUMMARY_LIMIT = 256;
const DEPENDENCY_RESULT_LIMIT = 2_048;
const DEPENDENCY_CONTEXT_LIMIT = 8_192;
const MAX_WAIT_MS = 30_000;

export type GroupTaskStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export type GroupStatus = "completed" | "running" | "failed" | "blocked";

type TaskState =
  | { status: "queued"; queued_at: string; last_activity_at: string }
  | { status: "running"; job_id: string; queued_at: string; started_at: string; last_activity_at: string; current_step: string }
  | { status: "completed"; job_id: string; queued_at: string; started_at: string; ended_at: string; last_activity_at: string; summary: string }
  | { status: "failed"; job_id: string | null; queued_at: string; started_at: string | null; ended_at: string; last_activity_at: string; summary: string; reason: string }
  | { status: "blocked"; job_id: string | null; queued_at: string; ended_at: string; last_activity_at: string; summary: string; reason: string };

interface TaskRecord {
  name: string;
  depends_on: string[];
  state: TaskState;
}

export interface GroupEvent {
  cursor: number;
  task: string;
  job_id: string | null;
  status: "completed" | "failed" | "blocked";
  summary: string;
  source_revision?: string | null;
  source_dirty?: boolean | null;
  artifacts?: Array<{ path: string; exists: boolean; sha256?: string; bytes?: number }>;
  unresolved_questions?: string[] | null;
}

export interface GroupSnapshot {
  group_id: string;
  name: string;
  status: GroupStatus;
  cursor: number;
  persistence_error: string | null;
  counts: { completed: number; running: number; failed: number; blocked: number; queued: number };
  tasks: Record<string, {
    status: GroupTaskStatus;
    job_id: string | null;
    depends_on: string[];
    queued_at: string;
    started_at: string | null;
    last_activity_at: string;
    elapsed_ms: number;
    current_step: string;
    summary?: string;
    reason?: string;
  }>;
}

export interface GroupWaitResult extends GroupSnapshot {
  events: GroupEvent[];
  next_cursor: number;
}

export interface CreateGroupInput {
  name: string;
  tasks: Array<{ name: string; input: SessionStoreInput; depends_on?: string[] }>;
  max_parallel?: number;
}

interface StoredGroup {
  version: 1;
  group_id: string;
  name: string;
  cursor: number;
  tasks: TaskRecord[];
  events: GroupEvent[];
}

interface RuntimeGroup {
  stored: StoredGroup;
  lastCommitted: StoredGroup;
  inputs: Map<string, SessionStoreInput>;
  waiters: Set<Waiter>;
  maxParallel: number;
  persistenceError: string | null;
  dispatching: boolean;
}

interface Waiter {
  afterCursor: number;
  resolve: (result: GroupWaitResult) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

interface OutputMetadata {
  source_revision?: string | null;
  source_dirty?: boolean | null;
  artifacts?: Array<{ path: string; exists: boolean; sha256?: string; bytes?: number }>;
  unresolved_questions?: string[] | null;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= TASK_NAME_LIMIT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summaryOf(result: WorkerResult): string {
  const raw = result.status === "completed" ? result.result : result.error || result.result || result.status;
  return redactText(raw || result.status).replace(/\s+/g, " ").trim().slice(0, EVENT_SUMMARY_LIMIT);
}

function outputMetadata(raw: unknown): OutputMetadata | undefined {
  if (!isRecord(raw)) return undefined;
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts.slice(0, 33).flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || item.path.length > 8192 || typeof item.exists !== "boolean") return [];
    return [{ path: item.path, exists: item.exists,
      ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
      ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}),
    }];
  }) : undefined;
  return {
    source_revision: typeof raw.source_revision === "string" && /^[a-f0-9]{40,64}$/.test(raw.source_revision) ? raw.source_revision : null,
    source_dirty: typeof raw.source_dirty === "boolean" ? raw.source_dirty : null,
    artifacts: artifacts ?? [],
    unresolved_questions: Array.isArray(raw.unresolved_questions) && raw.unresolved_questions.length <= 32 && raw.unresolved_questions.every((q): q is string => typeof q === "string" && q.length <= 1024)
      ? raw.unresolved_questions : null,
  };
}

function validatePlan(input: CreateGroupInput): { tasks: CreateGroupInput["tasks"]; maxParallel: number } {
  if (!validName(input.name)) throw new Error("Group name must be a non-empty string of at most 64 characters.");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > TASK_COUNT_LIMIT) {
    throw new Error(`A group must contain between 1 and ${TASK_COUNT_LIMIT} tasks.`);
  }
  const maxParallel = input.max_parallel ?? 4;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > PARALLEL_LIMIT) {
    throw new Error(`max_parallel must be an integer from 1 to ${PARALLEL_LIMIT}.`);
  }
  const names = new Set<string>();
  for (const task of input.tasks) {
    if (!validName(task.name)) throw new Error("Task names must be non-empty strings of at most 64 characters.");
    if (names.has(task.name)) throw new Error(`Duplicate task name: ${task.name}`);
    names.add(task.name);
    if (!task.input || typeof task.input.prompt !== "string") throw new Error(`Task ${task.name} has no valid input.`);
  }
  const taskNames = new Set(input.tasks.map((task) => task.name));
  const indegree = new Map(input.tasks.map((task) => [task.name, 0]));
  const outgoing = new Map(input.tasks.map((task) => [task.name, [] as string[]]));
  for (const task of input.tasks) {
    const dependencies = task.depends_on ?? [];
    if (!Array.isArray(dependencies)) throw new Error(`Task ${task.name} dependencies must be an array.`);
    const unique = new Set<string>();
    for (const dependency of dependencies) {
      if (!taskNames.has(dependency)) throw new Error(`Task ${task.name} depends on unknown task ${dependency}.`);
      if (unique.has(dependency)) throw new Error(`Task ${task.name} repeats dependency ${dependency}.`);
      unique.add(dependency);
      indegree.set(task.name, indegree.get(task.name)! + 1);
      outgoing.get(dependency)!.push(task.name);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([name]) => name);
  let visited = 0;
  while (ready.length) {
    const name = ready.pop()!;
    visited += 1;
    for (const next of outgoing.get(name)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (visited !== input.tasks.length) throw new Error("Task dependencies contain a cycle.");
  return { tasks: input.tasks, maxParallel };
}

function assertUniqueReportPaths(inputs: ReadonlyMap<string, SessionStoreInput>): void {
  const assigned = new Map<string, string>();
  for (const [taskName, input] of inputs) {
    const policy = input.access;
    if (policy?.mode !== "read-only" || !policy.report_path) continue;
    const absolute = resolve(policy.report_path);
    const key = process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
    const previous = assigned.get(key);
    if (previous) throw new Error(`Tasks ${previous} and ${taskName} assign the same report_path: ${absolute}`);
    assigned.set(key, taskName);
  }
}

function isTaskState(value: unknown): value is TaskState {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  const instant = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const jobId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  if (!instant(value.queued_at) || !instant(value.last_activity_at)) return false;
  if ("started_at" in value && value.started_at !== null && !instant(value.started_at)) return false;
  if ("ended_at" in value && !instant(value.ended_at)) return false;
  if ("summary" in value && (typeof value.summary !== "string" || value.summary.length > EVENT_SUMMARY_LIMIT)) return false;
  if ("reason" in value && (typeof value.reason !== "string" || value.reason.length > EVENT_SUMMARY_LIMIT)) return false;
  switch (value.status) {
    case "queued": return true;
    case "running": return (value.job_id === "" || jobId(value.job_id)) && typeof value.started_at === "string" && typeof value.current_step === "string";
    case "completed": return jobId(value.job_id) && typeof value.started_at === "string" && typeof value.ended_at === "string" && typeof value.summary === "string";
    case "failed": return (value.job_id === null || jobId(value.job_id))
      && (value.started_at === null || typeof value.started_at === "string") && typeof value.ended_at === "string"
      && typeof value.summary === "string" && typeof value.reason === "string";
    case "blocked": return (value.job_id === null || jobId(value.job_id))
      && typeof value.ended_at === "string" && typeof value.summary === "string" && typeof value.reason === "string";
    default: return false;
  }
}

function parseStoredGroup(value: unknown): StoredGroup | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.group_id !== "string" || !/^g_[a-f0-9-]{36}$/.test(value.group_id) || !validName(value.name)
    || !Number.isSafeInteger(value.cursor) || Number(value.cursor) < 0
    || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > TASK_COUNT_LIMIT
    || !Array.isArray(value.events) || value.events.length > value.tasks.length || value.cursor !== value.events.length) return null;
  const tasks: TaskRecord[] = [];
  const names = new Set<string>();
  for (const item of value.tasks) {
    if (!isRecord(item) || !validName(item.name) || names.has(item.name) || !Array.isArray(item.depends_on)
      || !item.depends_on.every((name) => typeof name === "string") || !isTaskState(item.state)) return null;
    names.add(item.name);
    tasks.push({ name: item.name, depends_on: [...item.depends_on] as string[], state: item.state });
  }
  if (!tasks.every((task) => task.depends_on.every((name) => names.has(name)))) return null;
  try { validatePlan({ name: value.name, tasks: tasks.map((task) => ({ ...task, input: { prompt: "" } })) }); }
  catch { return null; }
  const events: GroupEvent[] = [];
  const seen = new Set<string>();
  for (const item of value.events) {
    if (!isRecord(item) || item.cursor !== events.length + 1 || !validName(item.task) || !names.has(item.task) || seen.has(item.task)
      || typeof item.summary !== "string" || item.summary.length > EVENT_SUMMARY_LIMIT
      || (item.job_id !== null && typeof item.job_id !== "string")
      || !["completed", "failed", "blocked"].includes(String(item.status))) return null;
    const state = tasks.find((task) => task.name === item.task)?.state;
    if (!state || state.status === "queued" || state.status === "running" || state.status !== item.status || state.job_id !== item.job_id) return null;
    seen.add(item.task);
    events.push({ cursor: events.length + 1, task: item.task, job_id: item.job_id as string | null,
      status: state.status, summary: item.summary, ...outputMetadata(item) });
  }
  if (tasks.filter((task) => task.state.status !== "queued" && task.state.status !== "running").length !== events.length) return null;
  return { version: 1, group_id: value.group_id, name: value.name, cursor: value.cursor as number, tasks, events };
}

export class GroupCoordinator {
  private readonly groups = new Map<string, RuntimeGroup>();
  private readonly jobs = new Map<string, { groupId: string; taskName: string }>();
  private readonly pending: Array<{ job_id: string; result: WorkerResult }> = [];
  private readonly unsubscribe: () => void;
  private draining = false;
  private closed = false;

  constructor(private readonly store: SessionStore, private readonly options: { root: string }) {
    mkdirSync(options.root, { recursive: true });
    this.unsubscribe = store.subscribe((event) => {
      if (this.closed) return;
      this.pending.push(event);
      this.scheduleDrain();
    });
    this.recover();
  }

  create(input: CreateGroupInput): GroupSnapshot {
    if (this.closed) throw new Error("Group coordinator is closed.");
    const plan = validatePlan(input);
    const prepared = new Map<string, SessionStoreInput>();
    for (const task of plan.tasks) prepared.set(task.name, this.store.prepare(task.input));
    assertUniqueReportPaths(prepared);

    const now = new Date().toISOString();
    const groupId = `g_${randomUUID()}`;
    const stored: StoredGroup = {
      version: 1,
      group_id: groupId,
      name: input.name,
      cursor: 0,
      tasks: plan.tasks.map((task) => ({
        name: task.name,
        depends_on: [...(task.depends_on ?? [])],
        state: { status: "queued", queued_at: now, last_activity_at: now },
      })),
      events: [],
    };
    const group: RuntimeGroup = {
      stored, lastCommitted: structuredClone(stored), inputs: prepared, waiters: new Set(), maxParallel: plan.maxParallel,
      persistenceError: null, dispatching: false,
    };
    this.save(group);
    group.lastCommitted = structuredClone(group.stored);
    this.groups.set(groupId, group);
    this.dispatch(group);
    return this.snapshot(groupId)!;
  }

  snapshot(groupId: string): GroupSnapshot | null {
    const group = this.groups.get(groupId);
    return group ? this.toSnapshot(group) : null;
  }

  async waitAny(groupId: string, afterCursor = 0, timeoutMs = 1_000, signal?: AbortSignal): Promise<GroupWaitResult | null> {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const cursor = Number.isSafeInteger(afterCursor) && afterCursor >= 0 ? afterCursor : 0;
    const timeout = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(timeoutMs) ? timeoutMs : 1_000));
    const current = this.waitResult(group, cursor);
    if (current.events.length || cursor > group.stored.cursor || timeout === 0 || signal?.aborted || this.isSettled(group)) return current;

    return await new Promise<GroupWaitResult>((resolve) => {
      const waiter: Waiter = { afterCursor: cursor, resolve, signal };
      group.waiters.add(waiter);
      waiter.onAbort = () => this.finishWaiter(group, waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiter.timer = setTimeout(() => this.finishWaiter(group, waiter), timeout);
      const rechecked = this.waitResult(group, cursor);
      if (rechecked.events.length || signal?.aborted || this.isSettled(group)) this.resolveWaiter(group, waiter, rechecked);
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.pending.length = 0;
    for (const group of this.groups.values()) {
      for (const waiter of [...group.waiters]) this.resolveWaiter(group, waiter, this.waitResult(group, waiter.afterCursor));
    }
  }

  private dispatch(group: RuntimeGroup): void {
    if (group.dispatching || group.persistenceError) return;
    group.dispatching = true;
    try {
      this.blockFailedDependents(group);
      while (!group.persistenceError && this.runningCount(group) < group.maxParallel) {
        const task = group.stored.tasks.find((candidate) => candidate.state.status === "queued"
          && candidate.depends_on.every((name) => this.task(group, name).state.status === "completed"));
        if (!task) break;
        const input = group.inputs.get(task.name);
        if (!input) {
          this.blockTask(group, task, "task input unavailable after restart");
          this.saveOrFault(group);
          continue;
        }
        const queuedAt = task.state.queued_at;
        const queuedState = task.state;
        const startedAt = new Date().toISOString();
        task.state = { status: "running", job_id: "", queued_at: queuedAt, started_at: startedAt, last_activity_at: startedAt, current_step: "starting" };
        if (!this.saveOrFault(group)) {
          task.state = queuedState;
          break;
        }
        let handle;
        try {
          const prompt = this.withDependencyResults(group, task, input.prompt);
          handle = this.store.start({ ...input, prompt });
          group.inputs.delete(task.name);
        } catch (error) {
          this.failUnstartedTask(group, task, error);
          group.inputs.delete(task.name);
          if (!this.saveOrFault(group)) break;
          continue;
        }
        task.state = { ...task.state, job_id: handle.jobId };
        this.jobs.set(handle.jobId, { groupId: group.stored.group_id, taskName: task.name });
        if (!this.saveOrFault(group)) {
          const current = group.stored.tasks.find((candidate) => candidate.name === task.name);
          if (current?.state.status === "running") current.state = { ...current.state, job_id: handle.jobId };
          void this.store.interrupt(handle.jobId, "group state persistence failed");
          break;
        }
      }
    } finally {
      group.dispatching = false;
    }
    this.notifyWaiters(group);
  }

  private scheduleDrain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    if (this.closed) return;
    try {
      while (this.pending.length > 0) {
        const settlement = this.pending.shift()!;
        const link = this.jobs.get(settlement.job_id);
        if (!link) continue;
        this.jobs.delete(settlement.job_id);
        const group = this.groups.get(link.groupId);
        const task = group?.stored.tasks.find((candidate) => candidate.name === link.taskName);
        if (!group || !task || task.state.status !== "running" || task.state.job_id !== settlement.job_id) continue;
        this.finishTask(group, task, settlement.result);
        if (!this.saveOrFault(group)) {
          this.notifyWaiters(group, true);
          continue;
        }
        this.dispatch(group);
      }
    } finally {
      this.draining = false;
      if (this.pending.length > 0) this.scheduleDrain();
    }
  }

  private finishTask(group: RuntimeGroup, task: TaskRecord, result: WorkerResult): void {
    const previous = task.state;
    if (previous.status !== "running") return;
    const now = new Date().toISOString();
    const success = result.status === "completed";
    const summary = summaryOf(result);
    task.state = success
      ? { status: "completed", job_id: result.job_id, queued_at: previous.queued_at, started_at: previous.started_at, ended_at: now, last_activity_at: now, summary }
      : { status: "failed", job_id: result.job_id, queued_at: previous.queued_at, started_at: previous.started_at, ended_at: now, last_activity_at: now, summary, reason: result.status };
    const metadata = outputMetadata(this.store.readMeta(result.job_id)?.output);
    this.appendEvent(group, { task: task.name, job_id: result.job_id, status: task.state.status, summary, ...metadata });
    this.blockFailedDependents(group);
  }

  private blockFailedDependents(group: RuntimeGroup): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of group.stored.tasks) {
        if (task.state.status !== "queued") continue;
        const blockers = task.depends_on.filter((name) => {
          const state = this.task(group, name).state.status;
          return state === "failed" || state === "blocked";
        });
        if (blockers.length) {
          this.blockTask(group, task, `dependency did not complete: ${blockers.join(", ")}`);
          changed = true;
        }
      }
    }
  }

  private blockTask(group: RuntimeGroup, task: TaskRecord, reason: string): void {
    group.inputs.delete(task.name);
    reason = reason.slice(0, EVENT_SUMMARY_LIMIT);
    const now = new Date().toISOString();
    task.state = { status: "blocked", job_id: null, queued_at: task.state.queued_at, ended_at: now, last_activity_at: now, summary: reason.slice(0, EVENT_SUMMARY_LIMIT), reason };
    this.appendEvent(group, { task: task.name, job_id: null, status: "blocked", summary: task.state.summary });
  }

  private failUnstartedTask(group: RuntimeGroup, task: TaskRecord, cause: unknown): void {
    const now = new Date().toISOString();
    const reason = redactText(cause instanceof Error ? cause.message : String(cause)).slice(0, EVENT_SUMMARY_LIMIT);
    task.state = { status: "failed", job_id: null, queued_at: task.state.queued_at, started_at: null, ended_at: now, last_activity_at: now, summary: reason, reason };
    this.appendEvent(group, { task: task.name, job_id: null, status: "failed", summary: reason });
    this.blockFailedDependents(group);
  }

  private withDependencyResults(group: RuntimeGroup, task: TaskRecord, prompt: string): string {
    let remaining = DEPENDENCY_CONTEXT_LIMIT;
    const sections: string[] = [];
    for (const name of task.depends_on) {
      const dependency = this.task(group, name);
      if (dependency.state.status !== "completed" || remaining <= 0) continue;
      const result = this.store.getTerminal(dependency.state.job_id);
      const body = redactText(result?.result ?? "").slice(0, Math.min(DEPENDENCY_RESULT_LIMIT, remaining));
      const section = `\n\n--- Dependency ${name} (completed) ---\n${body || dependency.state.summary}`;
      if (section.length > remaining) break;
      sections.push(section);
      remaining -= section.length;
    }
    return sections.length ? prompt + sections.join("") : prompt;
  }

  private appendEvent(group: RuntimeGroup, event: Omit<GroupEvent, "cursor">): void {
    const cursor = group.stored.cursor + 1;
    group.stored.cursor = cursor;
    group.stored.events.push({ cursor, ...event });
  }

  private runningCount(group: RuntimeGroup): number {
    return group.stored.tasks.filter((task) => task.state.status === "running").length;
  }

  private task(group: RuntimeGroup, name: string): TaskRecord {
    const task = group.stored.tasks.find((candidate) => candidate.name === name);
    if (!task) throw new Error(`Unknown task ${name}.`);
    return task;
  }

  private groupStatus(group: RuntimeGroup): GroupStatus {
    const states = group.stored.tasks.map((task) => task.state.status);
    if (group.persistenceError) return "blocked";
    if (states.every((status) => status === "completed")) return "completed";
    if (states.includes("running") || states.includes("queued")) return "running";
    if (states.includes("failed")) return "failed";
    return "blocked";
  }

  private isSettled(group: RuntimeGroup): boolean {
    return group.persistenceError !== null || group.stored.tasks.every((task) => task.state.status !== "queued" && task.state.status !== "running");
  }

  private toSnapshot(group: RuntimeGroup): GroupSnapshot {
    const counts = { completed: 0, running: 0, failed: 0, blocked: 0, queued: 0 };
    const tasks = Object.create(null) as GroupSnapshot["tasks"];
    const now = Date.now();
    for (const record of group.stored.tasks) {
      const state = record.state;
      counts[state.status] += 1;
      const live = state.status === "running" ? this.store.progress(state.job_id) : null;
      const startedAt = state.status === "running" ? state.started_at
        : state.status === "completed" || state.status === "failed" ? state.started_at : null;
      const endAt = state.status === "completed" || state.status === "failed" || state.status === "blocked" ? Date.parse(state.ended_at) : now;
      const startAt = startedAt ? Date.parse(startedAt) : Date.parse(state.queued_at);
      tasks[record.name] = {
        status: state.status,
        job_id: state.status === "running" || state.status === "completed" || (state.status === "failed" && state.job_id) ? state.job_id : null,
        depends_on: [...record.depends_on],
        queued_at: state.queued_at,
        started_at: startedAt,
        last_activity_at: live?.last_activity_at ?? state.last_activity_at,
        elapsed_ms: live?.elapsed_ms ?? Math.max(0, endAt - startAt),
        current_step: live?.current_step ?? (state.status === "queued" ? "queued" : state.status),
        ...((state.status === "completed" || state.status === "failed" || state.status === "blocked") ? { summary: state.summary } : {}),
        ...((state.status === "failed" || state.status === "blocked") ? { reason: state.reason } : {}),
      };
    }
    return {
      group_id: group.stored.group_id,
      name: group.stored.name,
      status: this.groupStatus(group),
      cursor: group.stored.cursor,
      persistence_error: group.persistenceError,
      counts,
      tasks,
    };
  }

  private waitResult(group: RuntimeGroup, afterCursor: number): GroupWaitResult {
    const events = group.stored.events.filter((event) => event.cursor > afterCursor).slice(0, EVENT_RESPONSE_LIMIT);
    return {
      ...this.toSnapshot(group),
      events,
      next_cursor: events.at(-1)?.cursor ?? afterCursor,
    };
  }

  private notifyWaiters(group: RuntimeGroup, force = false): void {
    for (const waiter of [...group.waiters]) {
      const result = this.waitResult(group, waiter.afterCursor);
      if (force || result.events.length > 0 || this.isSettled(group)) this.resolveWaiter(group, waiter, result);
    }
  }

  private finishWaiter(group: RuntimeGroup, waiter: Waiter): void {
    this.resolveWaiter(group, waiter, this.waitResult(group, waiter.afterCursor));
  }

  private resolveWaiter(group: RuntimeGroup, waiter: Waiter, result: GroupWaitResult): void {
    if (!group.waiters.delete(waiter)) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(result);
  }

  private saveOrFault(group: RuntimeGroup): boolean {
    try {
      this.save(group);
      group.lastCommitted = structuredClone(group.stored);
      return true;
    } catch (cause) {
      group.stored = structuredClone(group.lastCommitted);
      group.inputs.clear();
      group.persistenceError = redactText(cause instanceof Error ? cause.message : String(cause)).slice(0, EVENT_SUMMARY_LIMIT);
      return false;
    }
  }

  private save(group: RuntimeGroup): void {
    const dir = this.options.root;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${group.stored.group_id}.group.json`);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const persisted: StoredGroup = {
      version: 1,
      group_id: group.stored.group_id,
      name: group.stored.name,
      cursor: group.stored.cursor,
      tasks: group.stored.tasks,
      events: group.stored.events,
    };
    try {
      writeFileSync(temp, JSON.stringify(persisted), { encoding: "utf8", flag: "wx" });
      renameSync(temp, path);
    } catch (cause) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch { }
      throw cause;
    }
  }

  private recover(): void {
    for (const entry of readdirSync(this.options.root)) {
      if (!entry.startsWith("g_") || !entry.endsWith(".group.json")) continue;
      let parsed: StoredGroup | null = null;
      try { parsed = parseStoredGroup(JSON.parse(readFileSync(join(this.options.root, entry), "utf8")) as unknown); } catch { }
      if (!parsed || `${parsed.group_id}.group.json` !== entry) continue;
      const group: RuntimeGroup = { stored: parsed, lastCommitted: structuredClone(parsed), inputs: new Map(), waiters: new Set(), maxParallel: 4, persistenceError: null, dispatching: false };
      this.groups.set(parsed.group_id, group);
      let changed = false;
      for (const task of parsed.tasks) {
        if (task.state.status === "running") {
          const result = this.store.getTerminal(task.state.job_id);
          if (result) {
            this.finishTask(group, task, result);
            changed = true;
          } else {
            this.blockTask(group, task, "server restarted while task was executing");
            changed = true;
          }
        }
      }
      for (const task of parsed.tasks) {
        if (task.state.status === "queued") {
          this.blockTask(group, task, "server restarted before task launch");
          changed = true;
        }
      }
      if (changed) this.saveOrFault(group);
    }
  }
}

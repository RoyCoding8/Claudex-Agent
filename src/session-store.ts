// cx-agent SessionStore — seam behind lifecycle tools.

import { type WorkerResult, type WorkerInput, type WorkerDeps, runWorker } from "./worker.js";
import { newJobId, Transcript, type JobMeta, type JobStatus } from "./transcript.js";
import { InterruptHandle } from "./interrupt.js";
import { summarizeThinking, type ProgressSender } from "./progress.js";
import { existsSync, readFileSync } from "node:fs";
import { joinPath, joinFs, jobStoreDir } from "./paths.js";
import type { SDKMessage, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel } from "./runtime/claude-sdk.js";
import { redactText } from "./retention.js";
import { resolveEngine, type EngineName, type WorkerEvent } from "./runtime/engine.js";
import { resolveContextPolicy, mergeContextPolicy, type ContextPolicy } from "./runtime/context-policy.js";

const RING_HARD_CAP = 256;
const SETTLED_JOB_CAP = 128;

type JobState = { kind: "running" } | { kind: "settled"; result: WorkerResult; persisted: boolean };

export interface RingEvent {
  seq: number;
  ts: string;
  kind: string;
  summary: string;
}

interface LiveJob {
  jobId: string;
  interrupt: InterruptHandle;
  promise: Promise<WorkerResult>;
  events: RingEvent[];
  cursorSeq: number;
  state: JobState;
  stopMode: "interrupt" | "cancel" | null;
  sessionId: string | null;
  input: SessionStoreInput;
}

export interface SessionStoreInput {
  prompt: string;
  engine?: EngineName;
  context?: ContextPolicy;
  operation?: "prompt" | "compact";
  model?: string;
  pool?: string;
  cwd?: string;
  agent?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  autoContinue?: number;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  sendProgress?: ProgressSender;
  progressToken?: string | number;
  queryFn?: WorkerInput["queryFn"];
  resumeSessionId?: string;
  fork?: boolean;
  resumedFrom?: string;
}

export interface SessionStoreDeps {
  runWorker?: typeof runWorker;
  defaults?: WorkerDeps["defaults"];
  validate?: WorkerDeps["validate"];
  provider?: WorkerDeps["provider"];
  transcriptRoot?: string;
}

export interface StartHandle {
  jobId: string;
  interrupt: InterruptHandle;
}


export type ReplyRejection = "unknown_job" | "no_session" | "not_terminal" | "storage_fault";


function nonEmpty(v: string[] | undefined): string[] | undefined {
  return v && v.length > 0 ? v : undefined;
}

export interface PollResult {
  job_id: string;
  status: JobStatus | "unknown";
  events: RingEvent[];
  nextCursor: number;
  terminal: boolean;
}


function summarizeForRing(msg: SDKMessage): { kind: string; summary: string } {
  type Block = { type: string; text?: string; name?: string; input?: unknown; thinking?: string };
  const m = msg as unknown as {
    type: string; subtype?: string;
    message?: { content?: Block[] };
    content?: Block[];
    summary?: string;
  };
  const blocks = m.message?.content ?? m.content ?? [];
  switch (m.type) {
    case "system":
      return { kind: "system", summary: m.subtype === "init" ? "session started" : `system:${m.subtype ?? "?"}` };
    case "assistant": {
      const think = summarizeThinking(blocks);
      const prefix = think ? `${think} · ` : "";
      const tu = blocks.find((b) => b.type === "tool_use");
      if (tu) {
        const name = tu.name ?? "tool";
        const tgt = tu.input && typeof tu.input === "object"
          ? describeForRing(tu.input as Record<string, unknown>)
          : "";
        return { kind: "tool_use", summary: `${prefix}${name}${tgt ? " " + tgt : ""}` };
      }
      const text = blocks.find((b) => b.type === "text")?.text;
      if (text) return { kind: "assistant", summary: `${prefix}${text.slice(0, 60)}` };
      return { kind: "assistant", summary: think ?? "assistant turn" };
    }
    case "user":
      return { kind: "tool_result", summary: "tool result" };
    case "result":
      return { kind: "result", summary: m.subtype === "success" ? "completed" : `result:${m.subtype ?? "error"}` };
    case "tool_use_summary":
      return { kind: "tool_use", summary: m.summary ?? "tool summary" };
    default:
      return { kind: m.type, summary: m.type };
  }
}

function describeForRing(input: Record<string, unknown>): string {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = input[key];
    if (typeof v === "string") {
      const parts = v.replace(/\\/g, "/").split("/").filter(Boolean);
      return parts[parts.length - 1] ?? v;
    }
  }
  if (typeof input.command === "string") return input.command.split("\n")[0]?.trim().slice(0, 40) ?? "";
  return "";
}

/** Push event with tiered eviction on hard cap. */
function pushEvent(events: RingEvent[], ev: RingEvent): void {
  events.push(ev);
  if (events.length > RING_HARD_CAP) events.splice(0, Math.floor(events.length / 2));
}

export class SessionStore {
  private readonly live = new Map<string, LiveJob>();
  private persistenceFault: string | null = null;
  private readonly deps: SessionStoreDeps;

  constructor(deps: SessionStoreDeps = {}) {
    this.deps = deps;
  }

  get size(): number {
    return this.live.size;
  }

  private root(): string {
    return this.deps.transcriptRoot ?? jobStoreDir();
  }

  /** Register a job, spawn the worker as a detached promise, return the synchronous handle. */
  start(input: SessionStoreInput): StartHandle {
    if (this.persistenceFault) throw new Error(this.persistenceFault);
    const engine = resolveEngine(input.engine);
    input = { ...input, engine, context: resolveContextPolicy(engine, input.context), cwd: input.cwd ?? process.cwd() };
    const run = this.deps.runWorker ?? runWorker;
    const jobId = newJobId();
    const interrupt = new InterruptHandle();
    const events: RingEvent[] = [];
    let cursorSeq = 0;
    let sessionId: string | null = input.fork ? null : input.resumeSessionId ?? null;
    let resolveResult: (result: WorkerResult) => void = () => {};
    const promise = new Promise<WorkerResult>((resolve) => { resolveResult = resolve; });

    const live: LiveJob = {
      jobId, interrupt, promise,
      events, cursorSeq, state: { kind: "running" }, stopMode: null, sessionId, input,
    };

    const onMessage = (msg: SDKMessage): void => {
      if (sessionId == null) {
        const sid = (msg as unknown as { session_id?: string }).session_id;
        if (typeof sid === "string") { sessionId = sid; live.sessionId = sid; }
      }
      const { kind, summary } = summarizeForRing(msg);
      cursorSeq += 1;
      live.cursorSeq = cursorSeq;
      pushEvent(events, { seq: cursorSeq, ts: new Date().toISOString(), kind, summary });
    };

    const onEvent = (event: WorkerEvent): void => {
      const summary = event.kind === "session" ? "session started"
        : event.kind === "assistant" ? event.text : event.summary;
      if (event.kind === "session") live.sessionId = event.sessionId;
      cursorSeq += 1;
      live.cursorSeq = cursorSeq;
      pushEvent(events, { seq: cursorSeq, ts: new Date().toISOString(), kind: event.kind, summary: redactText(summary).slice(0, 160) });
    };

    const workerInput: WorkerInput = {
      prompt: input.prompt, operation: input.operation, engine: input.engine, pool: input.model ?? input.pool, cwd: input.cwd,
      context: input.context,
      agent: input.agent, allowedTools: input.allowedTools, disallowedTools: input.disallowedTools,
      maxTurns: input.maxTurns, timeoutMs: input.timeoutMs, jobId,
      maxBudgetUsd: input.maxBudgetUsd, autoContinue: input.autoContinue,
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      sendProgress: input.sendProgress, progressToken: input.progressToken, onMessage, onEvent,
      ...(input.queryFn ? { queryFn: input.queryFn } : {}),
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.fork ? { fork: true } : {}),
      ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
    };

    const workerDeps: WorkerDeps = {
      defaults: this.deps.defaults, validate: this.deps.validate,
      provider: this.deps.provider, transcriptRoot: this.deps.transcriptRoot, interrupt,
    };

    this.live.set(jobId, live);
    const settle = (result: WorkerResult): void => {
      let terminal = live.stopMode === "cancel"
        ? { ...result, status: "interrupted" as const, session_id: null, resumable: false, error: "cancelled" }
        : result;
      const previous = this.readMeta(jobId);
      let persisted = false;
      try {
        new Transcript(jobId, { root: this.root() }).writeMeta({
          job_id: jobId, engine: input.engine, context: input.context, pool: input.model ?? input.pool ?? this.deps.defaults?.pool ?? "",
          cwd: input.cwd ?? process.cwd(), started_at: new Date().toISOString(),
          ...previous, status: terminal.status, result: terminal.result, error: terminal.error,
          ended_at: new Date().toISOString(), turns: terminal.turns, pool_resolved: terminal.pool_resolved,
          session_id: terminal.session_id, resumable: terminal.resumable,
          continuations: terminal.continuations,
        });
        persisted = true;
      } catch (error) {
        terminal = { ...terminal, status: "failed", error: "could not persist terminal job: " + redactText(String(error)), resumable: false };
        this.persistenceFault ??= terminal.error;
      }
      live.sessionId = terminal.session_id;
      live.state = { kind: "settled", result: terminal, persisted };
      resolveResult(terminal);
      const settled = [...this.live.values()].filter((job) => job.state.kind === "settled");
      for (const job of settled.slice(0, Math.max(0, settled.length - SETTLED_JOB_CAP))) this.live.delete(job.jobId);
    };
    const fail = (error: unknown): void => settle({
      status: interrupt.isAborted ? "interrupted" : "failed", result: "", job_id: jobId,
      pool_resolved: [], turns: 0, transcript_path: joinPath(this.root(), `${jobId}.jsonl`),
      error: redactText(error instanceof Error ? error.message : String(error)), session_id: live.sessionId,
      resumable: live.sessionId !== null, continuations: 0,
    });
    try { void run(workerInput, workerDeps).then(settle, fail); } catch (error) { fail(error); }
    return { jobId, interrupt };
  }

  async awaitTerminal(jobId: string): Promise<WorkerResult | null> {
    const live = this.live.get(jobId);
    if (live) {
      try { return await live.promise; } finally { this.live.delete(jobId); }
    }
    return this.readTerminalFromDisk(jobId);
  }

  getTerminal(jobId: string): WorkerResult | null {
    const live = this.live.get(jobId);
    if (live) return live.state.kind === "settled" ? live.state.result : null;
    return this.readTerminalFromDisk(jobId);
  }

  async waitFor(jobId: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResult | null> {
    const live = this.live.get(jobId);
    if (!live) return this.readTerminalFromDisk(jobId);
    if (live.state.kind === "settled") return live.state.result;
    if (timeoutMs <= 0 || signal?.aborted) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.min(timeoutMs, 30_000));
      onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([live.promise, deadline]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private readTerminalFromDisk(jobId: string): WorkerResult | null {
    const meta = this.readMeta(jobId);
    if (!meta || meta.status === "running") return null;
    return {
      status: meta.status, result: meta.result ?? "", job_id: jobId,
      pool_resolved: meta.pool_resolved ?? [], turns: meta.turns ?? 0,
      transcript_path: joinPath(this.root(), `${jobId}.jsonl`),
      error: meta.error, session_id: meta.session_id ?? null,
      resumable: meta.resumable ?? meta.session_id != null,
      continuations: meta.continuations ?? 0,
    };
  }

  /** Ring-buffered events since cursor for a known job. NOT for waiting. */
  poll(jobId: string, sinceCursor = 0): PollResult {
    const live = this.live.get(jobId);
    if (live) {
      return {
        job_id: jobId,
        status: live.state.kind === "settled" ? live.state.result.status : "running",
        events: live.events.filter((e) => e.seq > sinceCursor),
        nextCursor: live.cursorSeq,
        terminal: live.state.kind === "settled",
      };
    }
    const meta = this.readMeta(jobId);
    if (!meta) return { job_id: jobId, status: "unknown", events: [], nextCursor: sinceCursor, terminal: true };
    return { job_id: jobId, status: meta.status, events: [], nextCursor: sinceCursor, terminal: meta.status !== "running" };
  }

  getSessionId(jobId: string): string | null {
    const live = this.live.get(jobId);
    if (live) return live.sessionId;
    return this.readMeta(jobId)?.session_id ?? null;
  }

  isRunning(jobId: string): boolean {
    const live = this.live.get(jobId);
    return live?.state.kind === "running";
  }

  forget(jobId: string): void {
    if (!this.isRunning(jobId)) this.live.delete(jobId);
  }

  /** Continue or fork any terminal job's SDK session. Rejects on busy or unknown.
   *
   *  The resumed turn INHERITS the source job's environment — cwd, model, agent and tool
   *  menu — because SDK session files are stored per-cwd (`~/.claude/projects/<slug(cwd)>/`).
   *  A resume that ran under a different cwd would simply not find the session. Explicit
   *  arguments still win over the inherited values.
   *
   *  Reasoning config (thinking / effort) is inherited for the same reason as the tool menu:
   *  a job started with thinking captured should not silently stop capturing it mid-session.
   *
   *  Budget (maxTurns / timeoutMs / maxBudgetUsd / autoContinue) is deliberately NOT
   *  inherited: budget belongs to the call, not the session, so a reply to a job that died
   *  on its budget starts with a fresh full allowance instead of the cap that killed it. */
  reply(
    jobId: string,
    input: Omit<SessionStoreInput, "prompt"> & { prompt: string; fork?: boolean },
  ): StartHandle | { status: "SESSION_BUSY" | "SESSION_NOT_FOUND" | "INVALID_ARGUMENT"; sessionId: string | null; reason?: ReplyRejection } {
    if (this.isRunning(jobId)) return { status: "SESSION_BUSY", sessionId: this.getSessionId(jobId) };
    const meta = this.readMeta(jobId);
    const sessionId = this.getSessionId(jobId);
    if (this.persistenceFault) return { status: "SESSION_BUSY", sessionId, reason: "storage_fault" };
    if (meta?.status === "running") return { status: "SESSION_BUSY", sessionId, reason: "not_terminal" };
    const sourceEngine = meta?.engine ?? this.live.get(jobId)?.input.engine ?? "claude";
    if (input.engine && input.engine !== sourceEngine) return { status: "INVALID_ARGUMENT", sessionId };
    if (!sessionId || meta?.resumable === false) {
      return {
        status: "SESSION_NOT_FOUND",
        sessionId: null,
        reason: meta ? "no_session" : "unknown_job",
      };
    }
    if ([...this.live.values()].some((job) => job.state.kind === "running" && job.input.engine === sourceEngine
      && (job.sessionId === sessionId || job.input.resumeSessionId === sessionId))) {
      return { status: "SESSION_BUSY", sessionId };
    }
    return this.start({
      prompt: input.prompt,
      engine: sourceEngine,
      context: mergeContextPolicy(meta?.context, input.context),
      operation: input.operation,
      model: input.model ?? input.pool ?? meta?.pool,
      cwd: input.cwd ?? meta?.cwd,
      agent: input.agent ?? meta?.agent ?? undefined,
      allowedTools: input.allowedTools ?? nonEmpty(meta?.allowed_tools),
      disallowedTools: input.disallowedTools ?? nonEmpty(meta?.disallowed_tools),
      maxTurns: input.maxTurns, timeoutMs: input.timeoutMs,
      maxBudgetUsd: input.maxBudgetUsd, autoContinue: input.autoContinue,
      thinking: input.thinking ?? meta?.thinking ?? undefined,
      effort: input.effort ?? meta?.effort ?? undefined,
      sendProgress: input.sendProgress, progressToken: input.progressToken,
      queryFn: input.queryFn, resumeSessionId: sessionId, fork: input.fork ?? false,
      resumedFrom: jobId,
    });
  }

  /** Resumable stop: abort + tree-kill + await terminal write. Job stays resumable via reply. */
  async interrupt(jobId: string, reason = "interrupted"): Promise<{ status: "interrupted" | "not_found" }> {
    const live = this.live.get(jobId);
    if (!live || live.state.kind === "settled") return { status: "not_found" };
    live.stopMode ??= "interrupt";
    await live.interrupt.cancel(reason);
    try { await live.promise; } catch { /* defensive */ }
    return { status: "interrupted" };
  }

  /** Terminal stop: abort + tree-kill + await terminal write, then detach. Not resumable. */
  async cancel(jobId: string, reason = "cancelled"): Promise<{ status: "cancelled" | "not_found" } | { status: "failed"; error: string }> {
    const live = this.live.get(jobId);
    if (!live || !this.isRunning(jobId)) return { status: "not_found" };
    live.stopMode = "cancel";
    await live.interrupt.cancel(reason);
    try { await live.promise; } catch { /* defensive */ }
    if (live.state.kind === "settled" && !live.state.persisted) {
      return { status: "failed", error: live.state.result.error ?? "could not persist cancellation" };
    }
    this.live.delete(jobId);
    return { status: "cancelled" };
  }

  readMeta(jobId: string): JobMeta | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return null;
    const metaPath = joinFs(this.root(), `${jobId}.meta.json`);
    if (!existsSync(metaPath)) return null;
    try { return JSON.parse(readFileSync(metaPath, "utf8")) as JobMeta; } catch { return null; }
  }
}

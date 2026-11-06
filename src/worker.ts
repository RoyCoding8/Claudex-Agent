import type { query, SDKMessage, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { loadSettings, CX_AGENT_VERSION, parseDepth, clampAutoContinue, FALLBACK_DEFAULTS, type AgentDefaults } from "./settings.js";
import { buildThinkingConfig, type EffortLevel } from "./runtime/claude-sdk.js";
import { resolveProvider, type ModelProvider, type Connection } from "./providers/registry.js";
import { Transcript, newJobId, type JobMeta, type JobStatus, type RecordKind } from "./transcript.js";
import { ProgressEmitter, type ProgressSender } from "./progress.js";
import { InterruptHandle } from "./interrupt.js";
import { retainJobs, redactText } from "./retention.js";
import { jobStoreDir } from "./paths.js";
import { ENGINE_CAPABILITIES, type EngineInput, type EngineName, type EngineResult, type WorkerEvent, assertEngineOptionsSupported, resolveEngine } from "./runtime/engine.js";
import { recordKind, runClaude, toLike } from "./runtime/claude.js";
import { resolveContextPolicy } from "./runtime/context-policy.js";
import type { AccessPolicy } from "./access.js";
import type { JobOutput } from "./output.js";
import { RequestError } from "./errors.js";

export interface WorkerInput {
  prompt: string;
  engine?: EngineName;
  operation?: "prompt" | "compact";
  pool?: string;
  cwd?: string;
  agent?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  
  maxBudgetUsd?: number;
  
  autoContinue?: number;

  /** Undefined = the key is never placed on SDK Options, preserving the model's own default. */
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  jobId?: string;
  queryFn?: typeof query;
  sendProgress?: ProgressSender;
  progressToken?: string | number;
  onMessage?: (msg: SDKMessage) => void;
  onEvent?: (event: WorkerEvent) => void;
  resumeSessionId?: string;
  fork?: boolean;
  context?: EngineInput["context"];
  access?: AccessPolicy;
  
  resumedFrom?: string;
}

export interface WorkerResult {
  status: Exclude<JobStatus, "running">;
  result: string;
  job_id: string;
  pool_resolved: string[];
  turns: number;
  transcript_path: string;
  error: string | null;
  session_id: string | null;
  
  resumable: boolean;
  
  continuations: number;
  output?: JobOutput;
}


export interface WorkerDeps {
  defaults?: AgentDefaults;
  validate?: (model: string) => Promise<void>;
  transcriptRoot?: string;
  interrupt?: InterruptHandle;
  provider?: ModelProvider;
}


export async function runWorker(
  input: WorkerInput,
  deps: WorkerDeps = {},
): Promise<WorkerResult> {
  const defaults = deps.defaults ?? loadSettings();
  const engine = resolveEngine(input.engine);
  const pool = input.pool ?? defaults.pool;
  const cwd = input.cwd ?? process.cwd();
  const maxTurns = input.maxTurns ?? defaults.maxTurns;
  const allowedTools = input.allowedTools ?? defaults.allowedTools;
  const timeoutMs = input.timeoutMs ?? defaults.timeoutMs;
  const maxBudgetUsd = input.maxBudgetUsd ?? defaults.maxBudgetUsd;
  const autoContinue = clampAutoContinue(input.autoContinue ?? defaults.autoContinue);
  const thinking = input.thinking ?? buildThinkingConfig(defaults.thinking, defaults.thinkingDisplay);
  const effort = input.effort ?? defaults.effort;

  const jobId = input.jobId ?? newJobId();
  const transcript = new Transcript(jobId, { root: deps.transcriptRoot ?? jobStoreDir() });
  try { retainJobs(transcript.dir); } catch {  }

  let context: EngineInput["context"];
  try {
    context = resolveContextPolicy(engine, input.context);
  } catch (e) {
    return await finishFailed(transcript, jobId, pool, cwd, new ProgressEmitter(jobId, input.sendProgress ?? noopSender), e, new Date().toISOString(), engine);
  }

  const incomingDepth = parseDepth(process.env.CX_AGENT_DEPTH);
  const maxDepth = defaults.maxDepth > 0 ? defaults.maxDepth : FALLBACK_DEFAULTS.maxDepth;
  if (incomingDepth >= maxDepth) {
    const err = `cx-agent recursion limit reached (depth ${incomingDepth} >= maxDepth ${maxDepth}); refusing to spawn a nested worker. ` +
      `Raise agent_defaults.maxDepth if this delegation chain is intentional.`;
    const failStart = new Date().toISOString();
    transcript.writeMeta({
      job_id: jobId, status: "failed", pool, pool_resolved: [], cwd,
      started_at: failStart, ended_at: failStart, turns: 0, error: err, result: "",
      cx_agent_version: CX_AGENT_VERSION,
      session_id: null,
      files_changed: [],
      engine,
    } satisfies JobMeta);
    transcript.append("error", { msg: "recursion guard refused", depth: incomingDepth, maxDepth, error: err }, failStart);
    return {
      status: "failed", result: "", job_id: jobId, pool_resolved: [], turns: 0,
      transcript_path: transcript.path, error: err, session_id: null,
      resumable: false, continuations: 0,
    };
  }

  if (!pool || pool.length === 0) {
    const err = "No model specified. Pass `model` (or legacy `pool`) on the tool call, set `CX_AGENT_MODEL`, or set `pool` under `agent_defaults` in the config file.";
    return await finishFailed(transcript, jobId, pool, cwd, new ProgressEmitter(jobId, input.sendProgress ?? noopSender), new Error(err), new Date().toISOString(), engine, context);
  }

  const progressToken = input.progressToken ?? jobId;
  const sender = input.sendProgress ?? noopSender;
  const progress = new ProgressEmitter(progressToken, sender);
  const interrupt = deps.interrupt ?? new InterruptHandle();

  const started_at = new Date().toISOString();
  // Invocation shape is persisted up front: cx_agent_reply reads it back to reproduce
  // this worker's environment, and SDK session lookup is cwd-scoped, so losing `cwd`
  // makes the session unresumable.
  const baseMeta: JobMeta = {
    job_id: jobId, status: "running", pool, pool_resolved: [], cwd,
    started_at, ended_at: null, turns: 0, error: null, result: null,
    cx_agent_version: CX_AGENT_VERSION, session_id: null,
    resumable: false, resumed_from: input.resumedFrom ?? null, continuations: 0,
    agent: input.agent ?? null,
    allowed_tools: input.allowedTools ?? [],
    disallowed_tools: input.disallowedTools ?? [],
    timeout_ms: timeoutMs,
    ...(engine === "claude" ? { max_turns: maxTurns, max_budget_usd: maxBudgetUsd } : {}),
    thinking: thinking ?? null, effort: effort ?? null, context,
    access: input.access,
    engine,
  };
  transcript.writeMeta(baseMeta);
  transcript.append("system", { msg: "job started", pool, cwd }, started_at);
  progress.startHeartbeat();

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => { void interrupt.cancel("timeout"); }, timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
  }

  if (input.operation === "compact" && !ENGINE_CAPABILITIES[engine].compact) {
    progress.stopHeartbeat();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    return await finishFailed(
      transcript, jobId, pool, cwd, progress,
      new Error(engine + " does not expose native session compaction."), started_at, engine, context,
    );
  }

  const engineInput: EngineInput = {
    prompt: input.prompt, operation: input.operation, model: pool, cwd,
    resumeSessionId: input.resumeSessionId, fork: input.fork,
    maxTurns: input.maxTurns, maxBudgetUsd: input.maxBudgetUsd, autoContinue: input.autoContinue,
    agent: input.agent, allowedTools: input.allowedTools, disallowedTools: input.disallowedTools,
    thinking: input.thinking, effort, timeoutMs, context, access: input.access,
  };
  if (engine !== "claude") {
    try {
      assertEngineOptionsSupported(engine, engineInput);
      assertEngineDefaultsSupported(engine, defaults);
    } catch (e) {
      progress.stopHeartbeat();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      return await finishFailed(transcript, jobId, pool, cwd, progress, e, started_at, engine, context);
    }
  }

  let conn: Connection;
  try {
    const provider = deps.provider ?? resolveProvider();
    const validate = deps.validate ?? ((model: string) => preflightModel(provider, model));
    await raceWithAbort(validate(pool), interrupt.signal);
    conn = await raceWithAbort(provider.connection(pool), interrupt.signal);
  } catch (e) {
    progress.stopHeartbeat();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (interrupt.isAborted) {
      return finish({
        transcript, jobId, pool, cwd, progress, interrupt,
        engineResult: { result: "", sessionId: null, turns: 0, status: "failed", error: interrupt.reason ?? "interrupted" },
        started_at, timeoutMs, sessionId: null, baseMeta,
      });
    }
    return await finishFailed(transcript, jobId, pool, cwd, progress, e, started_at, engine, context);
  }

  let sessionId: string | null = null;
  const emit = (event: WorkerEvent): void => {
    if (event.kind === "session") {
      sessionId = event.sessionId;
      transcript.writeMeta({ ...baseMeta, session_id: sessionId, resumable: true });
    }
    const kind: RecordKind = event.kind === "session" ? "system" : event.kind;
    transcript.append(kind, event);
    const summary = event.kind === "assistant" ? event.text : event.kind === "session" ? "session started" : event.summary;
    if (summary) progress.emit(summary);
    if (input.onEvent) {
      try { input.onEvent(event); } catch { }
    }
  };
  const onClaudeMessage = (msg: SDKMessage): void => {
    if (sessionId === null && "session_id" in msg && typeof msg.session_id === "string") {
      sessionId = msg.session_id;
      transcript.writeMeta({ ...baseMeta, session_id: sessionId, resumable: true });
    }
    transcript.append(recordKind(msg), msg);
    progress.emitEvent(toLike(msg));
    if (input.onMessage) {
      try { input.onMessage(msg); } catch { }
    }
  };

  let engineResult: EngineResult;
  try {
    switch (engine) {
      case "claude":
        engineResult = await runClaude({
          ...engineInput,
          connection: conn,
          defaults,
          maxTurns,
          maxBudgetUsd,
          autoContinue,
          allowedTools,
          queryFn: input.queryFn,
          thinking,
          effort,
          onMessage: onClaudeMessage,
          onContinuation: (round, maxRounds, reason, currentSessionId) => {
            transcript.append("system", {
              msg: "auto-continue", round, of: maxRounds, reason, session_id: currentSessionId,
            });
            progress.emit(`budget stop (${reason}) · auto-continue ${round}/${maxRounds}`);
          },
        }, interrupt);
        break;
      case "codex": {
        const { runCodex } = await import("./runtime/codex.js");
        engineResult = await runCodex({ ...engineInput, connection: conn }, { signal: interrupt.signal, emit }, interrupt);
        break;
      }
      case "pi": {
        const { runPi } = await import("./runtime/pi.js");
        engineResult = await runPi({ ...engineInput, connection: conn }, { signal: interrupt.signal, emit }, interrupt);
        break;
      }
      default: {
        const exhaustive: never = engine;
        throw new Error(`Unknown worker engine ${exhaustive}`);
      }
    }
  } catch (cause) {
    const message = redactText(cause instanceof Error ? cause.message : String(cause));
    transcript.append("error", { msg: "engine threw", error: message });
    engineResult = { result: "", sessionId, turns: 0, status: "failed", error: message };
  } finally {
    progress.stopHeartbeat();
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  return finish({
    transcript, jobId, pool, cwd, progress, interrupt, engineResult, started_at,
    timeoutMs, sessionId, baseMeta,
  });
}
async function preflightModel(provider: ModelProvider, model: string): Promise<void> {
  const catalog = await provider.discover(model);
  if (!catalog.ready) {
    throw new Error(`model gateway not ready${catalog.diagnostics.length > 0 ? `: ${catalog.diagnostics.join("; ")}` : ""}`);
  }
  if (catalog.models.length > 0 && !catalog.models.includes(model)) {
    throw new Error(`unknown model "${model}". Valid models: ${catalog.models.join(", ")}`);
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function noopSender(): void {}


interface FinishArgs {
  transcript: Transcript;
  jobId: string;
  pool: string;
  cwd: string;
  progress: ProgressEmitter;
  interrupt: InterruptHandle;
  engineResult: EngineResult;
  started_at: string;
  timeoutMs: number;
  sessionId: string | null;
  baseMeta: JobMeta;
}

function finish(a: FinishArgs): WorkerResult {
  const { transcript, jobId, pool, cwd, progress, interrupt, engineResult, started_at, timeoutMs, sessionId, baseMeta } = a;
  const status: Exclude<JobStatus, "running"> = interrupt.isAborted
    ? interrupt.reason === "timeout" ? "incomplete" : "interrupted"
    : engineResult.status;
  const error = interrupt.isAborted
    ? interrupt.reason === "timeout" ? `timeout after ${timeoutMs}ms` : interrupt.reason ?? "interrupted"
    : engineResult.error;
  const result = redactText(engineResult.result);
  const turns = Math.max(engineResult.turns, progress.turnCount);
  const finalSessionId = engineResult.sessionId ?? sessionId;
  const resumable = finalSessionId !== null;
  const usage = engineResult.usage;
  const continuations = engineResult.continuations ?? 0;
  const filesChanged = [...new Set(engineResult.filesChanged ?? [])].sort();
  const ended_at = new Date().toISOString();
  const meta: JobMeta = {
    ...baseMeta,
    job_id: jobId, status, pool, pool_resolved: [], cwd, started_at, ended_at,
    turns, error, result, cx_agent_version: CX_AGENT_VERSION,
    usage, session_id: finalSessionId, files_changed: filesChanged,
    resumable, continuations,
  };
  transcript.writeMeta(meta);
  transcript.append("result", { status, error, turns, usage, continuations, resumable }, ended_at);

  return {
    status, result, job_id: jobId, pool_resolved: [], turns,
    transcript_path: transcript.path, error, session_id: finalSessionId,
    resumable, continuations,
  };
}
async function finishFailed(
  transcript: Transcript, jobId: string, pool: string, cwd: string,
  progress: ProgressEmitter, e: unknown, started_at: string, engine?: EngineName,
  context?: EngineInput["context"],
): Promise<WorkerResult> {
  progress.stopHeartbeat();
  const error = redactText(e instanceof Error ? e.message : String(e));
  const ended_at = new Date().toISOString();
  const meta: JobMeta = {
    job_id: jobId, status: "failed", pool, pool_resolved: [], cwd,
    started_at, ended_at, turns: 0, error, result: "",
    cx_agent_version: CX_AGENT_VERSION, session_id: null, files_changed: [],
    resumable: false, continuations: 0,
    ...(engine ? { engine } : {}), context,
  };
  transcript.writeMeta(meta);
  transcript.append("error", { msg: "pre-flight failed", error }, ended_at);
  return {
    status: "failed", result: "", job_id: jobId, pool_resolved: [], turns: 0,
    transcript_path: transcript.path, error, session_id: null,
    resumable: false, continuations: 0,
  };
}

export function assertEngineDefaultsSupported(engine: Exclude<EngineName, "claude">, defaults: AgentDefaults): void {
  const unsupported: string[] = [];
  if (defaults.maxTurns !== FALLBACK_DEFAULTS.maxTurns) unsupported.push("max_turns");
  if (defaults.maxBudgetUsd !== FALLBACK_DEFAULTS.maxBudgetUsd) unsupported.push("max_budget_usd");
  if (defaults.autoContinue !== FALLBACK_DEFAULTS.autoContinue) unsupported.push("auto_continue");
  if (defaults.allowedTools.length > 0) unsupported.push("allowed_tools");
  if (defaults.thinking !== undefined) unsupported.push("thinking");
  if (engine === "pi" && defaults.effort !== undefined) unsupported.push("effort");
  if (unsupported.length > 0) {
    throw new RequestError("UNSUPPORTED_OPERATION", engine + " does not support these configured Claude options: " + unsupported.join(", ") + ". Use timeout_ms for a wall-clock limit or engine:claude for these controls.");
  }
}

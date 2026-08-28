// cx-agent worker — BLOCKS until SDK query() terminal.

import { spawn as spawnChild } from "node:child_process";
import { query, type Options, type SDKMessage, type SpawnOptions, type SpawnedProcess, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { loadSettings, CX_AGENT_VERSION, parseDepth, clampAutoContinue, WORKER_DISALLOWED_TOOLS, FALLBACK_DEFAULTS, type AgentDefaults } from "./settings.js";
import { buildWorkerEnv as runtimeBuildWorkerEnv, buildThinkingConfig, type EffortLevel } from "./runtime/claude-sdk.js";
import { resolveProvider, type ModelProvider, type Connection } from "./providers/registry.js";
import { Transcript, newJobId, type JobMeta, type JobStatus, type RecordKind } from "./transcript.js";
import { ProgressEmitter, type SdkMessageLike, type ProgressSender } from "./progress.js";
import { InterruptHandle } from "./interrupt.js";
import { retainJobs, redactText } from "./retention.js";
import { jobStoreDir } from "./paths.js";

export interface WorkerInput {
  prompt: string;
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
  resumeSessionId?: string;
  fork?: boolean;
  
  resumedFrom?: string;
}

export interface WorkerResult {
  status: JobStatus;
  result: string;
  job_id: string;
  pool_resolved: string[];
  turns: number;
  transcript_path: string;
  error: string | null;
  session_id: string | null;
  
  resumable: boolean;
  
  continuations: number;
}


export const CONTINUE_PROMPT =
  "You stopped because you ran out of turn/cost budget for that round, not because the task was finished. " +
  "Continue from exactly where you left off — do not restart, re-plan, or repeat work you already did. " +
  "If the task is in fact already complete, say so in one line and stop.";


function isBudgetStop(subtype: string | undefined): boolean {
  return subtype === "error_max_turns" || subtype === "error_max_budget_usd";
}


function toLike(msg: SDKMessage): SdkMessageLike {
  const m = msg as unknown as Record<string, unknown>;
  const content = (m.message as { content?: unknown } | undefined)?.content;
  return {
    type: String(m.type ?? ""),
    subtype: typeof m.subtype === "string" ? m.subtype : undefined,
    content: Array.isArray(content)
      ? content.map((b) => b as { type: string; text?: string; name?: string; input?: unknown; thinking?: string })
      : undefined,
    summary: typeof m.summary === "string" ? m.summary : undefined,
    status: m.status === null ? null : typeof m.status === "string" ? (m.status as string) : undefined,
    result: typeof m.result === "string" ? m.result : undefined,
    errors: Array.isArray(m.errors) ? (m.errors as string[]) : undefined,
  };
}


function recordKind(msg: SDKMessage): RecordKind {
  const t = (msg as unknown as { type: string }).type;
  switch (t) {
    case "assistant": return "assistant";
    case "user": return "user";
    case "result": return "result";
    case "system": return "system";
    case "tool_use_summary": return "tool_use";
    default: return "progress";
  }
}

export interface WorkerDeps {
  defaults?: AgentDefaults;
  validate?: (model: string) => Promise<void>;
  transcriptRoot?: string;
  interrupt?: InterruptHandle;
  provider?: ModelProvider;
}


export function makeSpawnWithPid(
  interrupt: InterruptHandle,
  debug?: boolean,
  spawnFn: typeof spawnChild = spawnChild,
) {
  return (spawnOpts: SpawnOptions): SpawnedProcess => {
    const stderrMode = debug || spawnOpts.env?.DEBUG_CLAUDE_AGENT_SDK ? "pipe" : "ignore";
    const child = spawnFn(spawnOpts.command, spawnOpts.args, {
      cwd: spawnOpts.cwd,
      stdio: ["pipe", "pipe", stderrMode],
      env: spawnOpts.env,
      signal: spawnOpts.signal,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    if (stderrMode === "pipe" && child.stderr) {
      child.stderr.on("data", (d) => process.stderr.write(String(d)));
    }
    if (!child.stdin || !child.stdout) {
      throw new Error("Claude SDK subprocess did not expose stdin/stdout pipes");
    }
    if (typeof child.pid === "number") interrupt.setPid(child.pid);
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: (sig) => child.kill(sig),
      on: child.on.bind(child) as SpawnedProcess["on"],
      once: child.once.bind(child) as SpawnedProcess["once"],
      off: child.off.bind(child) as SpawnedProcess["off"],
    };
  };
}


export async function runWorker(
  input: WorkerInput,
  deps: WorkerDeps = {},
): Promise<WorkerResult> {
  const defaults = deps.defaults ?? loadSettings();
  const pool = input.pool ?? defaults.pool;
  const cwd = input.cwd ?? process.cwd();
  const maxTurns = input.maxTurns ?? defaults.maxTurns;
  const allowedTools = input.allowedTools ?? defaults.allowedTools;
  const timeoutMs = input.timeoutMs ?? defaults.timeoutMs;
  const maxBudgetUsd = input.maxBudgetUsd ?? defaults.maxBudgetUsd;
  const autoContinue = clampAutoContinue(input.autoContinue ?? defaults.autoContinue);
  const thinking = input.thinking ?? buildThinkingConfig(defaults.thinking, defaults.thinkingDisplay);
  const effort = input.effort ?? defaults.effort;
  const queryFn = input.queryFn ?? query;

  const jobId = input.jobId ?? newJobId();
  const transcript = new Transcript(jobId, { root: deps.transcriptRoot ?? jobStoreDir() });
  try { retainJobs(transcript.dir); } catch {  }

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
    return await finishFailed(transcript, jobId, pool, cwd, new ProgressEmitter(jobId, input.sendProgress ?? noopSender), new Error(err), new Date().toISOString());
  }

  const progressToken = input.progressToken ?? jobId;
  const sender = input.sendProgress ?? noopSender;
  const progress = new ProgressEmitter(progressToken, sender);
  const interrupt = deps.interrupt ?? new InterruptHandle();
  progress.startHeartbeat();

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
    max_turns: maxTurns, timeout_ms: timeoutMs, max_budget_usd: maxBudgetUsd,
    thinking: thinking ?? null, effort: effort ?? null,
  };
  transcript.writeMeta(baseMeta);
  transcript.append("system", { msg: "job started", pool, cwd }, started_at);

  let conn: Connection;
  try {
    const provider = deps.provider ?? resolveProvider();
    const validate = deps.validate ?? ((model: string) => preflightModel(provider, model));
    await validate(pool);
    conn = await provider.connection(pool);
  } catch (e) {
    return await finishFailed(transcript, jobId, pool, cwd, progress, e, started_at);
  }
  const env = runtimeBuildWorkerEnv(conn, { gitBashPath: defaults.gitBashPath });
  const disallowedTools = [...WORKER_DISALLOWED_TOOLS, ...(input.disallowedTools ?? [])];

  const options: Options = {
    env, cwd, model: pool, disallowedTools, maxTurns,
    abortController: interrupt.abortController,
    settingSources: defaults.inheritSettings ? ["user", "project", "local"] : [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    spawnClaudeCodeProcess: makeSpawnWithPid(interrupt),
    canUseTool: async (_toolName: string, _input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
      if (opts.signal.aborted) return { behavior: "deny", message: "aborted", interrupt: true } as const;
      return { behavior: "deny", message: "permission requests are not interactive in cx-agent; refusing", interrupt: true } as const;
    },
  };
  if (allowedTools.length > 0) options.tools = allowedTools;
  if (input.agent) options.agent = input.agent;
  if (maxBudgetUsd > 0) options.maxBudgetUsd = maxBudgetUsd;
  // Only set when explicitly asked for: the pool may front a model or gateway that rejects
  // these keys outright, so an unconfigured job must send exactly what it sent before.
  if (thinking) options.thinking = thinking;
  if (effort) options.effort = effort;
  if (defaults.forwardSubagentText) options.forwardSubagentText = true;
  if (input.resumeSessionId) {
    options.resume = input.resumeSessionId;
    if (input.fork) options.forkSession = true;
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => { void interrupt.cancel("timeout"); }, timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
  }

  let resultMsg: SDKMessage | null = null;
  let lastError: string | null = null;
  let sessionId: string | null = null;
  const filesChanged = new Set<string>();
  let continuations = 0;
  let turnsAccum = 0;
  const usageAccum = emptyUsage();

  try {
    let roundPrompt = input.prompt;
    let roundOptions = options;
    // Each iteration is one SDK query. A query that ends on a budget stop (max_turns
    // or max_budget_usd) is resumed in-place for up to `autoContinue` rounds, so a
    // per-query cap no longer terminates the job — it only paces it.
    for (;;) {
      resultMsg = null;
      const q = queryFn({ prompt: roundPrompt, options: roundOptions });
      for await (const msg of q) {
        if (sessionId == null) {
          const sid = (msg as unknown as { session_id?: string }).session_id;
          if (typeof sid === "string") {
            sessionId = sid;
            transcript.writeMeta({ ...baseMeta, session_id: sid, resumable: true });
          }
        }
        if (interrupt.isAborted) {
          transcript.append("error", { msg: "interrupted", reason: "aborted" });
          lastError = "interrupted";
          break;
        }
        transcript.append(recordKind(msg), msg);
        progress.emitEvent(toLike(msg));
        collectFilesChanged(msg, filesChanged);
        if (input.onMessage) {
          try { input.onMessage(msg); } catch { /* observer must never abort the loop */ }
        }
        const t = (msg as unknown as { type: string; subtype?: string }).type;
        if (t === "result") { resultMsg = msg; break; }
      }

      const r = resultMsg as unknown as { subtype?: string; num_turns?: number } | null;
      turnsAccum += r?.num_turns ?? 0;
      addUsage(usageAccum, extractUsage(resultMsg));

      if (!isBudgetStop(r?.subtype) || continuations >= autoContinue || interrupt.isAborted || !sessionId) break;

      continuations += 1;
      transcript.append("system", {
        msg: "auto-continue", round: continuations, of: autoContinue, reason: r?.subtype, session_id: sessionId,
      });
      progress.emit(`budget stop (${r?.subtype ?? "?"}) · auto-continue ${continuations}/${autoContinue}`);
      roundPrompt = CONTINUE_PROMPT;
      // Continue the SAME session — never fork, or each round would lose the prior work.
      roundOptions = { ...options, resume: sessionId, forkSession: false };
    }
  } catch (e) {
    lastError = redactText(e instanceof Error ? e.message : String(e));
    transcript.append("error", { msg: "query threw", error: lastError });
  } finally {
    progress.stopHeartbeat();
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  return await finish({
    transcript, jobId, pool, cwd, progress, interrupt, resultMsg, lastError, started_at,
    timeoutMs, maxBudgetUsd, sessionId, filesChanged, continuations, turnsAccum,
    usageAccum, baseMeta,
  });
}

type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

function emptyUsage(): UsageTotals {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/** Accumulate one round's usage into the job total. Continuation rounds each report their own. */
function addUsage(into: UsageTotals, from: UsageTotals | null): void {
  if (!from) return;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_creation_input_tokens += from.cache_creation_input_tokens;
  into.cache_read_input_tokens += from.cache_read_input_tokens;
}

function hasUsage(u: UsageTotals): boolean {
  return u.input_tokens > 0 || u.output_tokens > 0 || u.cache_creation_input_tokens > 0 || u.cache_read_input_tokens > 0;
}

/** Default pre-flight: gateway reports ready and the model is in its catalog (when one is available). */
async function preflightModel(provider: ModelProvider, model: string): Promise<void> {
  const catalog = await provider.discover(model);
  if (!catalog.ready) {
    throw new Error(`model gateway not ready${catalog.diagnostics.length > 0 ? `: ${catalog.diagnostics.join("; ")}` : ""}`);
  }
  if (catalog.models.length > 0 && !catalog.models.includes(model)) {
    throw new Error(`unknown model "${model}". Valid models: ${catalog.models.join(", ")}`);
  }
}

function noopSender(): void {}


function collectFilesChanged(msg: SDKMessage, out: Set<string>): void {
  const m = msg as unknown as { type?: string; message?: { content?: unknown[] } };
  if (m.type !== "assistant" && m.type !== "tool_use_summary") return;
  const blocks = (m.message?.content ?? []) as Array<{ type?: string; input?: unknown }>;
  for (const b of blocks) {
    if (b.type !== "tool_use" || !b.input || typeof b.input !== "object") continue;
    const obj = b.input as Record<string, unknown>;
    for (const key of ["file_path", "path", "notebook_path"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) {
        const parts = v.replace(/\\/g, "/").split("/").filter(Boolean);
        out.add(parts[parts.length - 1] ?? v);
      }
    }
  }
}


function extractUsage(r: unknown): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
} | null {
  const u = (r as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
  };
}

interface FinishArgs {
  transcript: Transcript;
  jobId: string;
  pool: string;
  cwd: string;
  progress: ProgressEmitter;
  interrupt: InterruptHandle;
  resultMsg: SDKMessage | null;
  lastError: string | null;
  started_at: string;
  timeoutMs: number;
  maxBudgetUsd: number;
  sessionId: string | null;
  filesChanged: Set<string>;
  continuations: number;
  turnsAccum: number;
  usageAccum: UsageTotals;
  baseMeta: JobMeta;
}

async function finish(a: FinishArgs): Promise<WorkerResult> {
  const {
    transcript, jobId, pool, cwd, progress, interrupt, resultMsg, lastError,
    started_at, timeoutMs, maxBudgetUsd, sessionId, filesChanged, continuations,
    turnsAccum, usageAccum, baseMeta,
  } = a;
  const r = (resultMsg as unknown as {
    subtype?: string; result?: string; is_error?: boolean; num_turns?: number; errors?: string[]; usage?: Record<string, unknown>;
  } | null) ?? null;

  let status: JobStatus;
  let error: string | null;
  const resultText = redactText(r?.result ?? "");
    const turns = Math.max(turnsAccum, r?.num_turns ?? 0) || progress.turnCount;
  const usage = hasUsage(usageAccum) ? usageAccum : extractUsage(r);

  if (interrupt.isAborted && interrupt.reason === "timeout") {
            status = "incomplete";
    error = `timeout after ${timeoutMs}ms`;
  } else if (interrupt.isAborted) {
    status = "interrupted";
    error = interrupt.reason ?? lastError ?? "interrupted";
  } else if (r && r.subtype === "success" && !r.is_error) {
    status = "completed";
    error = null;
  } else if (r && r.subtype === "error_max_turns") {
    status = "incomplete";
    error = lastError ?? "reached max_turns";
  } else if (r && r.subtype === "error_max_budget_usd") {
    status = "incomplete";
    error = lastError ?? `reached max budget of ${maxBudgetUsd} USD`;
  } else {
    status = "failed";
    error = lastError ?? (r?.errors?.join("; ") ?? r?.subtype ?? "unknown error");
  }

  // Resumable means "a persisted SDK session exists to resume". A pre-flight failure
  // never reached the SDK, so it has no session and no resume path.
  const resumable = sessionId != null;

  const ended_at = new Date().toISOString();
  const meta: JobMeta = {
    ...baseMeta,
    job_id: jobId, status, pool, pool_resolved: [], cwd, started_at, ended_at,
    turns, error, result: resultText, cx_agent_version: CX_AGENT_VERSION,
    usage: usage ?? undefined, session_id: sessionId, files_changed: dedupeSorted(filesChanged),
    resumable, continuations,
  };
  transcript.writeMeta(meta);
  transcript.append("result", { status, error, turns, usage, continuations, resumable }, ended_at);

  return {
    status, result: resultText, job_id: jobId, pool_resolved: [], turns,
    transcript_path: transcript.path, error, session_id: sessionId,
    resumable, continuations,
  };
}

function dedupeSorted(set: Set<string>): string[] {
  return set.size === 0 ? [] : Array.from(set).sort();
}

async function finishFailed(
  transcript: Transcript, jobId: string, pool: string, cwd: string,
  progress: ProgressEmitter, e: unknown, started_at: string,
): Promise<WorkerResult> {
  progress.stopHeartbeat();
  const error = redactText(e instanceof Error ? e.message : String(e));
  const ended_at = new Date().toISOString();
  const meta: JobMeta = {
    job_id: jobId, status: "failed", pool, pool_resolved: [], cwd,
    started_at, ended_at, turns: 0, error, result: "",
    cx_agent_version: CX_AGENT_VERSION, session_id: null, files_changed: [],
    resumable: false, continuations: 0,
  };
  transcript.writeMeta(meta);
  transcript.append("error", { msg: "pre-flight failed", error }, ended_at);
  return {
    status: "failed", result: "", job_id: jobId, pool_resolved: [], turns: 0,
    transcript_path: transcript.path, error, session_id: null,
    resumable: false, continuations: 0,
  };
}

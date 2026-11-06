// cx-agent MCP tool schemas + handlers.

import { z } from "zod";
import { runWorker, type WorkerResult } from "./worker.js";
import { transcriptDir, loadSettings, MAX_AUTO_CONTINUE } from "./settings.js";
import { joinPath, joinFs } from "./paths.js";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { type JobMeta } from "./transcript.js";
import { InterruptHandle } from "./interrupt.js";
import { SessionStore, type PollResult, type SessionStoreInput, type StartHandle } from "./session-store.js";
import { type ProgressSender } from "./progress.js";
import { resolveProvider, type ModelProvider } from "./providers/registry.js";
import { inspectReadiness, type ReadinessResult } from "./readiness.js";
import { accessPolicySchema } from "./access.js";
import type { JobOutput } from "./output.js";
import { completionDelivery } from "./completion.js";
import { EFFORT_LEVELS, THINKING_DISPLAYS, buildThinkingConfig, isEffortLevel, isThinkingDisplay, parseThinkingSpec } from "./runtime/claude-sdk.js";
import { RequestError, structured, withStructured, codeForStatus, type StructuredError } from "./errors.js";
import { ENGINE_NAMES, ENGINE_CAPABILITIES, parseEngineName, resolveEngine, type EngineName } from "./runtime/engine.js";
import { contextPolicySchema, parseContextPolicy, resolveContextPolicy, type ContextPolicy } from "./runtime/context-policy.js";


export type SlimResult =
  | { job_id: string; result: string; output?: JobOutput }
  | {
      job_id: string;
      status: "failed" | "interrupted" | "incomplete";
      error: StructuredError;
      result?: string;
      truncated?: boolean;
      output?: JobOutput;
      resumable?: boolean;
      resume_with?: string;
    };

const SLIM_RESULT_EXCERPT = 2048;
const REASONING_EXCERPT = 8192;
const jobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Expected a job ID without path separators");

function boundExcerpt(text: string, limit = SLIM_RESULT_EXCERPT, hint = 'use cx_agent_fetch fields:["result"]'): { excerpt: string; truncated: boolean } {
  if (!text) return { excerpt: "", truncated: false };
  if (text.length <= limit) return { excerpt: text, truncated: false };
  const half = Math.floor(limit / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  return {
    excerpt: head + `\n…[truncated ${text.length - limit} bytes — ${hint}]\n` + tail,
    truncated: true,
  };
}

/** Build cx_agent_run's context-safe terminal envelope. Non-completed terminals get a bounded excerpt. */
export function toSlimResult(r: WorkerResult): SlimResult {
  if (r.status === "completed") return { job_id: r.job_id, result: r.result ?? "", ...(r.output ? { output: r.output } : {}) };
  if (r.status === "failed" || r.status === "interrupted" || r.status === "incomplete") {
    const code = codeForStatus(r.status, r.error) as StructuredError;
    // `resumable` is the field that turns a dead-end envelope into an actionable one:
    // a budget stop keeps its SDK session, so the work so far is not lost.
    const resume = r.resumable
      ? { resumable: true, resume_with: `cx_agent_reply(job_id:"${r.job_id}", prompt:"…")` }
      : { resumable: false };
    if (r.result && r.result.length > 0) {
      const { excerpt, truncated } = boundExcerpt(r.result);
      return { job_id: r.job_id, status: r.status, error: code, result: excerpt, truncated, ...resume, ...(r.output ? { output: r.output } : {}) };
    }
    return { job_id: r.job_id, status: r.status, error: code, ...resume, ...(r.output ? { output: r.output } : {}) };
  }
  return { job_id: r.job_id, status: "failed", error: structured("INTERNAL", "worker returned non-terminal status: running") };
}

export interface McpProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

/** Build a ProgressSender from MCP extra.sendNotification. */
export function makeMcpProgressSender(
  sendNotification: (n: unknown) => Promise<void>,
  progressToken: string | number | undefined,
): (n: { progressToken: string | number; progress: number; total?: number; message?: string }) => void {
  if (progressToken == null) {
    return () => {};
  }
  return (n) => {
    const notif: McpProgressNotification = {
      method: "notifications/progress",
      params: { progressToken: n.progressToken, progress: n.progress, total: n.total, message: n.message },
    };
    void sendNotification(notif).catch(() => {});
  };
}

// ---- Schemas ----

/** Reasoning knobs, shared by run and reply. Omitting them sends nothing to the SDK, so the
 *  model's own default stands — important because the pool may front a gateway that rejects them. */
const reasoningInputSchema = (omitted: string) => ({
  thinking: z.union([z.enum(["adaptive", "disabled"]), z.number().int().positive()]).optional()
    .describe(
      "Extended thinking for the worker. \"adaptive\" lets the model choose how much to think (recommended); " +
      "a positive integer sets an explicit thinking-token budget; \"disabled\" turns thinking off. " +
      `Omitted = ${omitted}. ` +
      "Reasoning text goes ONLY to the JSONL transcript — read it with cx_agent_fetch fields:[\"reasoning\"]. " +
      "It never rides back on the run envelope or on progress events.",
    ),
  thinking_display: z.enum(THINKING_DISPLAYS).optional()
    .describe(
      "\"summarized\" (the default whenever `thinking` is set) returns readable summarized reasoning. " +
      "\"omitted\" asks for thinking blocks with no text — the model still reasons, you just cannot read it. " +
      "Ignored unless `thinking` is set.",
    ),
  effort: z.enum(EFFORT_LEVELS).optional()
    .describe(`Reasoning effort: low | medium | high | xhigh | max. Independent of \`thinking\`. Omitted = ${omitted}.`),
});

export const runInputSchema = {
  prompt: z.string().min(1).describe("The task to delegate, verbatim."),
  engine: z.enum(ENGINE_NAMES).optional().describe("Worker SDK, independent of the main agent. claude, codex, or pi. Default CX_AGENT_ENGINE or claude."),
  context: contextPolicySchema.optional().describe("Per-session context and native automatic compaction controls. Supported fields vary by SDK; see cx_agent_setup capabilities.context. Inherited on reply. Does not increase the model endpoint's actual context limit."),
  background: z.boolean().optional().describe("Return a job_id immediately and keep working independently of this request. Recommended for clients that block turns during tool calls. Retrieve completion with cx_agent_wait. Default false for compatibility."),
  model: z.string().optional().describe("Model alias or concrete model id served by the configured gateway (default: from settings)."),
  pool: z.string().optional().describe("Deprecated alias for `model`. Use `model` instead."),
  cwd: z.string().optional().describe("Working directory for the worker."),
  access: accessPolicySchema.optional().describe("read-only restricts worker tools, with native sandboxing on Codex. An optional report_path grants the parent permission to create that new file from the final text. Claude/Pi tool restrictions are not an OS sandbox."),
  artifact_paths: z.array(z.string().min(1)).max(32).optional().describe("Caller-selected artifact paths to return with existence, size, and hashes up to 8 MiB. Relative to cwd. Does not grant worker write permission."),
  agent: z.string().optional().describe("Nested subagent name to invoke inside the worker."),
  allowed_tools: z.array(z.string()).optional()
    .describe("Restrict the worker's built-in Claude Code tool menu to exactly these names when non-empty (e.g. [\"Read\",\"Bash\"]). Empty/omitted = all tools available."),
  disallowed_tools: z.array(z.string()).optional()
    .describe("Extra tool names to deny the worker, on top of the built-in hazard denylist (which blocks interactive / side-effect / self-delegation tools)."),
  max_turns: z.number().int().positive().optional()
    .describe("Turn budget for one query round (SDK maxTurns). Hitting it ends the round as `incomplete`, not failed — the job stays resumable."),
  timeout_ms: z.number().int().positive().optional()
    .describe("Wall-clock cap (ms) across the whole job, including auto-continue rounds. Hitting it ends the job as `incomplete` (TIMEOUT) and it stays resumable."),
  max_budget_usd: z.number().positive().optional()
    .describe("Cost cap in USD for one query round (SDK maxBudgetUsd). Hitting it ends the round as `incomplete` (RESOURCE_EXHAUSTED) and it stays resumable."),
  auto_continue: z.number().int().min(0).max(MAX_AUTO_CONTINUE).optional()
    .describe(
      "How many times to automatically continue the SAME session when a round stops on max_turns / max_budget_usd instead of finishing. " +
      "Each round resumes where the worker left off, so a per-round cap paces the job instead of killing it. 0 disables it. Default comes from settings.",
    ),
  ...reasoningInputSchema("nothing is sent to the model, so its own default applies"),
};

export const listInputSchema = {};

export const interruptInputSchema = {
  job_id: jobIdSchema.describe("The job_id to interrupt (from a running cx_agent_run)."),
};

export const replyInputSchema = {
  job_id: jobIdSchema
    .describe("The job_id to continue or fork. Any TERMINAL job that holds a session works — completed, incomplete (max_turns / max_budget / timeout), or interrupted."),
  prompt: z.string().min(1).describe("The next user turn, verbatim."),
  background: runInputSchema.background,
  engine: runInputSchema.engine.describe("Must match the source job engine. Omitted inherits it. Cross-engine session resume is unsupported."),
  context: runInputSchema.context,
  access: runInputSchema.access,
  artifact_paths: runInputSchema.artifact_paths,
  model: z.string().optional().describe("Model alias or concrete model id. Default: INHERITED from the resumed job."),
  pool: z.string().optional().describe("Deprecated alias for `model`."),
  cwd: z.string().optional()
    .describe("Working directory for the worker. Default: INHERITED from the resumed job — SDK sessions are stored per-cwd, so overriding this with a different directory will not find the session."),
  agent: z.string().optional().describe("Nested subagent name to invoke inside the worker. Default: inherited from the resumed job."),
  allowed_tools: z.array(z.string()).optional()
    .describe("Restrict the worker's built-in tool menu to these names when non-empty. Default: inherited from the resumed job."),
  disallowed_tools: z.array(z.string()).optional()
    .describe("Extra tool names to deny the worker, on top of the hazard denylist. Default: inherited from the resumed job."),
  max_turns: z.number().int().positive().optional()
    .describe("Turn budget for this round. NOT inherited — defaults to the configured default, so a reply to a max_turns casualty gets a fresh full allowance."),
  timeout_ms: z.number().int().positive().optional().describe("Wall-clock cap (ms) for this round. NOT inherited."),
  max_budget_usd: z.number().positive().optional().describe("Cost cap in USD for this round. NOT inherited."),
  auto_continue: z.number().int().min(0).max(MAX_AUTO_CONTINUE).optional()
    .describe("Automatic continuation rounds on a budget stop for this reply. NOT inherited."),
  fork: z.boolean().optional().describe("Fork to a new session id instead of continuing the resumed one (leaves the original untouched)."),
  ...reasoningInputSchema("INHERITED from the resumed job, so a session that was capturing reasoning keeps capturing it"),
};

export const checkInputSchema = {
  job_id: jobIdSchema.describe("The job_id to inspect. Use cx_agent_wait to collect completion."),
  since_cursor: z.number().int().min(0).optional().describe("Return events with seq > this cursor (default 0)."),
};

export const waitInputSchema = {
  job_id: jobIdSchema.describe("The background job to wait for."),
  timeout_ms: z.number().int().min(0).max(30_000).optional()
    .describe("Wait at most this many milliseconds. Default 1000, maximum 30000. Zero checks immediately. A wait timeout or request cancellation leaves the worker running."),
};

export const compactInputSchema = {
  job_id: jobIdSchema.describe("A terminal resumable job whose engine supports native compaction."),
  instructions: z.string().optional().describe("Optional guidance for the SDK's native compaction."),
  background: runInputSchema.background,
  timeout_ms: runInputSchema.timeout_ms,
};

export const sessionInputSchema = {
  action: z.enum(["list", "get", "cancel", "clean"]).describe("list: one-line-per-job; get: full meta; cancel: terminal stop of a running job; clean: delete terminal job files."),
  job_id: jobIdSchema.optional().describe("Required for get/cancel."),
  statuses: z.array(z.enum(["completed", "failed", "interrupted", "incomplete"])).optional()
    .describe("clean: only remove jobs whose terminal status is in this list."),
  older_than_ms: z.number().int().min(0).optional().describe("clean: only remove jobs older than this many ms."),
  dry_run: z.boolean().optional().describe("clean: list what would be removed without deleting (default false)."),
};

export const setupInputSchema = {
  engine: runInputSchema.engine, model: runInputSchema.model,
  verify: z.boolean().optional().describe("Send a paid streaming protocol request for this exact model, capped at 512 output tokens and 15 seconds. Without this, ready is false and availability may be unknown. This does not verify SDK tools or resume."),
};

export const fetchInputSchema = {
  job_id: jobIdSchema.describe("The job_id to fetch details for."),
  fields: z
    .array(z.enum([
      "status", "result", "turns", "pool_resolved", "transcript_path", "error",
      "started_at", "ended_at", "cx_agent_version", "usage", "session_id", "files_changed",
      "resumable", "resumed_from", "continuations", "cwd", "agent", "budget", "reasoning", "engine", "context", "access", "output",
    ]))
    .optional()
    .describe(
      "Which fields to return. If omitted, returns only status + error. " +
      "Only the requested fields appear; this keeps the payload to exactly what you need. " +
      "When `result` is included and the job is terminal, the FULL untruncated result is returned from the meta sidecar. " +
      "If the result was never recorded, `result` is null (distinct from an empty result of \"\"); " +
      "if it is absent from the sidecar but present in the JSONL transcript, that value is used as a fallback. " +
      "`session_id` returns the SDK resume handle (for cx_agent_reply); `files_changed` returns the sorted union of file-like path basenames touched by the job's tool_use records. " +
      "`resumable` says whether cx_agent_reply can pick the job up; `resumed_from` names the job it was forked/continued from; " +
      "`continuations` counts the automatic continuation rounds it used; `budget` returns the max_turns / timeout_ms / max_budget_usd / auto-continue caps the job actually ran under. " +
      "`reasoning` reads the worker's thinking blocks out of the JSONL transcript and returns " +
      "{config:{thinking,effort}, blocks, redacted, chars, truncated, text} — `text` is byte-capped, `chars` is the true total. " +
      "It is empty unless the job ran with `thinking` set (and with thinking_display \"summarized\", the default). " +
      "This is the one deliberately large field: request it only when you actually want to read the worker's reasoning.",
    ),
};

// ---- Handlers (callable directly for tests) ----

export interface ToolHandlerExtra {
  progressToken?: string | number;
  sendNotification: (n: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface RunHandlerDeps {
  runWorker?: typeof runWorker;
  defaults?: import("./worker.js").WorkerDeps["defaults"];
  registry?: InterruptRegistry;
  transcriptRoot?: string;
  /** The live-job registry the lifecycle tools read. Constructed on demand when absent. */
  store?: SessionStore;
}

/** Register an already-started job for cancellation: registry entry + MCP signal wiring. */
function trackInterruptableJob(
  registry: InterruptRegistry | undefined,
  signal: AbortSignal,
  jobId: string,
  interrupt: InterruptHandle,
): { cleanup: () => void } {
  registry?.set(jobId, interrupt);
  const onAbort = () => void interrupt.cancel("client cancellation");
  if (signal.aborted) void interrupt.cancel("client cancellation");
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    cleanup: () => {
      signal.removeEventListener("abort", onAbort);
      registry?.delete(jobId);
    },
  };
}

/** Common tool-args → SessionStoreInput mapping for run and reply. */
export function toStoreInput(args: Record<string, unknown>): Omit<SessionStoreInput, "prompt"> {
  return {
    engine: parseEngineName(args.engine),
    background: args.background === true,
    context: parseContextPolicy(args.context),
    access: args.access === undefined ? undefined : accessPolicySchema.parse(args.access),
    artifactPaths: Array.isArray(args.artifact_paths) ? args.artifact_paths as string[] : undefined,
    operation: args.operation === "compact" ? "compact" : undefined,
    model: typeof args.model === "string" ? args.model : typeof args.pool === "string" ? args.pool : undefined,
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    agent: typeof args.agent === "string" ? args.agent : undefined,
    allowedTools: Array.isArray(args.allowed_tools) ? args.allowed_tools.filter((x): x is string => typeof x === "string") : undefined,
    disallowedTools: Array.isArray(args.disallowed_tools) ? args.disallowed_tools.filter((x): x is string => typeof x === "string") : undefined,
    maxTurns: typeof args.max_turns === "number" ? args.max_turns : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    maxBudgetUsd: typeof args.max_budget_usd === "number" ? args.max_budget_usd : undefined,
    autoContinue: typeof args.auto_continue === "number" ? args.auto_continue : undefined,
    thinking: buildThinkingConfig(
      parseThinkingSpec(args.thinking),
      isThinkingDisplay(args.thinking_display) ? args.thinking_display : undefined,
    ),
    effort: isEffortLevel(args.effort) ? args.effort : undefined,
  };
}

/** Announce the job_id on the progress channel before the job blocks, so the caller can
 *  interrupt or inspect it mid-flight instead of learning its id only at the terminal. */
function announceJobId(sendProgress: ProgressSender, progressToken: string | number | undefined, jobId: string): void {
  if (progressToken == null) return;
  sendProgress({ progressToken, progress: 0, message: `job ${jobId} started` });
}

async function finishStartedJob(
  started: StartHandle,
  store: SessionStore,
  background: boolean,
  extra: ToolHandlerExtra,
  registry?: InterruptRegistry,
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  if (background) return { content: { type: "text", text: JSON.stringify({ job_id: started.jobId, status: "running" }) } };
  const tracked = trackInterruptableJob(registry, extra.signal, started.jobId, started.interrupt);
  announceJobId(makeMcpProgressSender(extra.sendNotification, extra.progressToken), extra.progressToken, started.jobId);
  try {
    const result = await store.awaitTerminal(started.jobId);
    if (!result) return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: started.jobId, status: "failed" }, "INTERNAL", "the job produced no terminal record")) }, isError: true };
    return { content: { type: "text", text: JSON.stringify(toSlimResult(result)) }, isError: result.status !== "completed" };
  } finally { tracked.cleanup(); }
}

export async function handleWait(
  args: { job_id: string; timeout_ms?: number },
  store: SessionStore,
  signal?: AbortSignal,
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const waited = await store.waitFor(args.job_id, args.timeout_ms ?? 1000, signal);
  const result = waited ?? store.getTerminal(args.job_id);
  if (result) return { content: { type: "text", text: JSON.stringify(toSlimResult(result)) }, isError: result.status !== "completed" };
  const status = store.poll(args.job_id).status;
  if (status === "unknown") return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: args.job_id, status: "not_found" }, "SESSION_NOT_FOUND", "no job with that id")) }, isError: true };
  return { content: { type: "text", text: JSON.stringify({ job_id: args.job_id, status }) } };
}

export async function handleRun(
  args: Record<string, unknown>,
  extra: ToolHandlerExtra,
  deps: RunHandlerDeps = {},
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const sendProgress = args.background === true ? undefined : makeMcpProgressSender(extra.sendNotification, extra.progressToken);
  // Run goes through the SessionStore so the job is visible to cx_agent_check,
  // cx_agent_interrupt and cx_agent_session while it is still running.
  const store = deps.store ?? new SessionStore({
    runWorker: deps.runWorker ?? runWorker,
    defaults: deps.defaults,
    transcriptRoot: deps.transcriptRoot,
  });
  let started: StartHandle;
  try {
    started = store.start({
      prompt: String(args.prompt ?? ""),
      ...toStoreInput(args),
      sendProgress,
      progressToken: extra.progressToken,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: { type: "text", text: JSON.stringify({ job_id: null, status: "failed", error: structured(e instanceof RequestError ? e.code : e instanceof z.ZodError ? "INVALID_ARGUMENT" : "INTERNAL", msg) }) },
      isError: true,
    };
  }
  try {
    return await finishStartedJob(started, store, args.background === true, extra, deps.registry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: { type: "text", text: JSON.stringify({ job_id: started.jobId, status: "failed", error: structured("INTERNAL", msg) }) },
      isError: true,
    };
  }
}

function isJobMeta(value: unknown): value is JobMeta {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.job_id === "string"
    && typeof v.status === "string"
    && typeof v.pool === "string"
    && (typeof v.started_at === "string" || v.started_at == null);
}

export function handleList(
  opts: { root?: string } = {},
): { content: { type: "text"; text: string } } {
  const root = opts.root ?? transcriptDir();
  const jobs: JobMeta[] = [];
  if (existsSync(root)) {
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(joinFs(root, f), "utf8"));
        if (isJobMeta(parsed)) jobs.push(parsed);
      } catch { /* skip malformed sidecar */ }
    }
  }
  jobs.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  const lines = jobs.map((j) => {
    const jobId = (j.job_id ?? "").padEnd(18);
    const status = (j.status ?? "").padEnd(11);
    const started = (j.started_at ?? "?").padEnd(20);
    const pool = (j.pool ?? "").padEnd(13);
    const resumable = ((j.resumable ?? j.session_id != null) ? "yes" : "-").padEnd(6);
    const error = j.error ?? "";
    return `${jobId} ${status} ${started} ${pool} ${resumable} ${error}`.trimEnd();
  });
  const text = jobs.length === 0
    ? "No jobs."
    : ["job_id             status      started              pool          resume error", ...lines].join("\n");
  return { content: { type: "text", text } };
}

/** job_id → AbortHandle, populated by run via the interrupt registry. */
export type InterruptRegistry = Map<string, { cancel: (reason?: string) => Promise<void> }>;

export async function handleInterrupt(
  args: { job_id: string },
  _extra: ToolHandlerExtra,
  store: SessionStore,
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const res = await store.interrupt(args.job_id, "interrupted via cx_agent_interrupt");
  if (res.status === "not_found") {
    return {
      content: { type: "text", text: JSON.stringify({ job_id: args.job_id, status: "not_found", error: structured("SESSION_NOT_FOUND", "no running job with that id") }) },
      isError: true,
    };
  }
  return {
    content: { type: "text", text: JSON.stringify({ job_id: args.job_id, status: "interrupted", error: structured("INTERRUPTED", "the job was interrupted; resumable via cx_agent_reply") }) },
  };
}

/** All detail fields cx_agent_fetch can return. cost_usd intentionally absent. */
export type FetchField =
  | "status" | "result" | "turns" | "pool_resolved"
  | "transcript_path" | "error" | "started_at" | "ended_at" | "cx_agent_version" | "usage" | "session_id" | "files_changed"
  | "resumable" | "resumed_from" | "continuations" | "cwd" | "agent" | "budget" | "reasoning" | "engine" | "context" | "access" | "output";

/** Every field handleSession(get) returns — the full sidecar view.
 *  `reasoning` is excluded on purpose: it reads the JSONL and can be large, so it stays opt-in. */
export const ALL_FETCH_FIELDS: FetchField[] = [
  "status", "result", "turns", "pool_resolved", "transcript_path", "error",
  "started_at", "ended_at", "cx_agent_version", "usage", "session_id", "files_changed",
  "resumable", "resumed_from", "continuations", "cwd", "agent", "budget", "engine", "context", "access", "output",
];

/** Default fields returned when `fields` is omitted. */
export const DEFAULT_FETCH_FIELDS: FetchField[] = ["status", "error"];

/** Read a job's detail from its .meta.json sidecar. Read-only, never blocks. */
export function handleFetchJob(
  args: { job_id: string; fields?: FetchField[] },
  opts: { root?: string } = {},
): { content: { type: "text"; text: string }; isError?: boolean } {
  const root = opts.root ?? transcriptDir();
  const metaPath = joinFs(root, `${args.job_id}.meta.json`);
  if (!existsSync(metaPath)) {
    return {
      content: { type: "text", text: JSON.stringify({ status: "not_found", job_id: args.job_id, error: structured("SESSION_NOT_FOUND", "no job with that id") }) },
      isError: true,
    };
  }
  let meta: JobMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as JobMeta;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: { type: "text", text: JSON.stringify({ status: "not_found", job_id: args.job_id, error: structured("INTERNAL", `unreadable meta: ${msg}`) }) },
      isError: true,
    };
  }
  const fields = args.fields && args.fields.length > 0 ? args.fields : DEFAULT_FETCH_FIELDS;
  const out: Record<string, unknown> = { job_id: args.job_id };
  for (const f of fields) {
    switch (f) {
      case "engine": out.engine = meta.engine ?? "claude"; break;
      case "context": out.context = meta.context ?? null; break;
      case "access": out.access = meta.access ?? null; break;
      case "output": out.output = meta.output ?? null; break;
      case "status": out.status = meta.status; break;
      case "result": {
        if (meta.result === undefined || meta.result === null) {
          const fallback = readResultFromTranscript(joinFs(root, `${args.job_id}.jsonl`));
          out.result = fallback === undefined ? null : fallback;
        } else {
          out.result = meta.result;
        }
        break;
      }
      case "turns": out.turns = meta.turns; break;
      case "pool_resolved": out.pool_resolved = meta.pool_resolved; break;
      case "transcript_path": out.transcript_path = joinPath(root, `${args.job_id}.jsonl`); break;
      case "error": out.error = meta.error; break;
      case "started_at": out.started_at = meta.started_at; break;
      case "ended_at": out.ended_at = meta.ended_at; break;
      case "cx_agent_version": out.cx_agent_version = meta.cx_agent_version; break;
      case "usage": out.usage = meta.usage ?? null; break;
      case "session_id": out.session_id = meta.session_id ?? null; break;
      case "files_changed": out.files_changed = meta.files_changed ?? []; break;
      // Sidecars written before resumability was tracked have no `resumable` key;
      // holding a session_id is the same thing, so fall back to that.
      case "resumable": out.resumable = meta.resumable ?? meta.session_id != null; break;
      case "resumed_from": out.resumed_from = meta.resumed_from ?? null; break;
      case "continuations": out.continuations = meta.continuations ?? 0; break;
      case "cwd": out.cwd = meta.cwd ?? null; break;
      case "agent": out.agent = meta.agent ?? null; break;
      case "budget": out.budget = {
        max_turns: meta.max_turns ?? null,
        timeout_ms: meta.timeout_ms ?? null,
        max_budget_usd: meta.max_budget_usd ?? null,
        continuations_used: meta.continuations ?? 0,
      }; break;
      case "reasoning": out.reasoning = {
        config: { thinking: meta.thinking ?? null, effort: meta.effort ?? null },
        ...readReasoningFromTranscript(joinFs(root, `${args.job_id}.jsonl`)),
      }; break;
    }
  }
  return { content: { type: "text", text: JSON.stringify(out) } };
}

/** Scan JSONL transcript for the terminal `result` record. Best-effort, never throws. */
function readResultFromTranscript(jsonlPath: string): string | undefined {
  try {
    if (!existsSync(jsonlPath)) return undefined;
    const raw = readFileSync(jsonlPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let lastResult: string | undefined;
    for (const l of lines) {
      let rec: unknown;
      try {
        rec = JSON.parse(l);
      } catch {
        continue;
      }
      const r = rec as { kind?: string; payload?: { result?: unknown } } | null;
      if (r && r.kind === "result" && r.payload && typeof r.payload.result === "string") {
        lastResult = r.payload.result;
      }
    }
    return lastResult;
  } catch {
    return undefined;
  }
}

/** Scan the JSONL for the worker's thinking blocks. Best-effort, never throws.
 *  Reasoning is only ever stored here — the meta sidecar is parsed for every job by
 *  cx_agent_list, so it must stay small. The returned text is byte-capped for the same reason. */
function readReasoningFromTranscript(
  jsonlPath: string,
): { blocks: number; redacted: number; chars: number; truncated: boolean; text: string } {
  const empty = { blocks: 0, redacted: 0, chars: 0, truncated: false, text: "" };
  try {
    if (!existsSync(jsonlPath)) return empty;
    const parts: string[] = [];
    let blocks = 0;
    let redacted = 0;
    let chars = 0;
    for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = (rec as { payload?: { message?: { content?: unknown }; content?: unknown } } | null)?.payload;
      const content = payload?.message?.content ?? payload?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as Array<{ type?: string; thinking?: unknown }>) {
        if (b?.type === "redacted_thinking") { blocks += 1; redacted += 1; continue; }
        if (b?.type !== "thinking") continue;
        blocks += 1;
        if (typeof b.thinking === "string" && b.thinking.length > 0) {
          chars += b.thinking.length;
          parts.push(b.thinking);
        }
      }
    }
    const bound = boundExcerpt(parts.join("\n\n---\n\n"), REASONING_EXCERPT, `read the JSONL at ${jsonlPath} directly`);
    return { blocks, redacted, chars, truncated: bound.truncated, text: bound.excerpt };
  } catch {
    return empty;
  }
}

// --- reply / check / session / setup ---

export interface ReplyHandlerDeps {
  store: SessionStore;
  runWorker?: typeof runWorker;
  defaults?: import("./worker.js").WorkerDeps["defaults"];
  transcriptRoot?: string;
  registry?: InterruptRegistry;
}

export async function handleReply(
  args: Record<string, unknown>,
  extra: ToolHandlerExtra,
  deps: ReplyHandlerDeps,
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const jobId = String(args.job_id ?? "");
  if (!jobId) {
    return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: null, status: "failed" }, "INVALID_ARGUMENT", "job_id is required")) }, isError: true };
  }
  const prompt = String(args.prompt ?? "");
  if (!prompt && args.operation !== "compact") {
    return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed" }, "INVALID_ARGUMENT", "prompt is required")) }, isError: true };
  }
  const sourceEngine = deps.store.readMeta(jobId)?.engine ?? "claude";
  if (args.fork === true && !ENGINE_CAPABILITIES[sourceEngine].fork) return {
    content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed" }, "UNSUPPORTED_OPERATION", `${sourceEngine} does not expose native session forking through this SDK adapter`)) }, isError: true,
  };
  const sendProgress = args.background === true ? undefined : makeMcpProgressSender(extra.sendNotification, extra.progressToken);
  let started: ReturnType<SessionStore["reply"]>;
  try {
    started = deps.store.reply(jobId, {
      prompt,
      ...toStoreInput(args),
      sendProgress,
      progressToken: extra.progressToken,
      fork: typeof args.fork === "boolean" ? args.fork : false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed" }, e instanceof RequestError ? e.code : e instanceof z.ZodError ? "INVALID_ARGUMENT" : "INTERNAL", message)) }, isError: true };
  }
  if ("status" in started) {
    if (started.status === "INVALID_ARGUMENT") return {
      content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed" }, "INVALID_ARGUMENT", "a session can only be resumed by its original worker engine")) }, isError: true,
    };
    if (started.status === "SESSION_BUSY") {
      return {
        content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed", session_id: started.sessionId }, "SESSION_BUSY", started.reason === "storage_fault"
          ? "the job store could not commit terminal metadata; new work and resumes are blocked until storage is repaired and uncertain records are reconciled"
          : started.reason === "not_terminal"
          ? "the job has no confirmed terminal result; automatic recovery of a running record after restart is unavailable"
          : "the job or another continuation of its session is still running")) },
        isError: true,
      };
    }
    const message = started.reason === "no_session"
      ? "that job exists but never recorded an SDK session (it failed pre-flight), so there is nothing to resume"
      : "no job with that id — check cx_agent_list, or the job store may have been cleaned";
    return {
      content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed", session_id: null }, "SESSION_NOT_FOUND", message)) },
      isError: true,
    };
  }
  try {
    return await finishStartedJob(started, deps.store, args.background === true, extra, deps.registry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: { type: "text", text: JSON.stringify({ job_id: started.jobId, status: "failed", error: structured("INTERNAL", msg) }) },
      isError: true,
    };
  }
}

export async function handleCompact(
  args: { job_id: string; instructions?: string; background?: boolean; timeout_ms?: number },
  extra: ToolHandlerExtra,
  deps: ReplyHandlerDeps,
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const meta = deps.store.readMeta(args.job_id);
  if (!meta) return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: args.job_id, status: "failed" }, "SESSION_NOT_FOUND", "no job with that id")) }, isError: true };
  const engine = meta.engine ?? "claude";
  if (!ENGINE_CAPABILITIES[engine].compact) return {
    content: { type: "text", text: JSON.stringify(withStructured({ job_id: args.job_id, status: "failed" }, "UNSUPPORTED_OPERATION", `${engine} does not expose native compaction through this SDK adapter`)) }, isError: true,
  };
  return handleReply({ ...args, prompt: args.instructions ?? "", operation: "compact" }, extra, deps);
}

export function handleCheck(
  args: { job_id: string; since_cursor?: number },
  store: SessionStore,
): { content: { type: "text"; text: string }; isError?: boolean } {
  const res: PollResult = store.poll(String(args.job_id ?? ""), typeof args.since_cursor === "number" ? args.since_cursor : 0);
  return { content: { type: "text", text: JSON.stringify({ ...res, progress: store.progress(res.job_id) }) } };
}

export interface SessionHandlerDeps {
  store: SessionStore;
  root?: string;
}

/** Manager over job records: list / get / cancel (terminal) / clean (delete terminal sidecars). */
export async function handleSession(
  args: { action: "list" | "get" | "cancel" | "clean"; job_id?: string; statuses?: string[]; older_than_ms?: number; dry_run?: boolean },
  deps: SessionHandlerDeps,
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const root = deps.root ?? transcriptDir();
  switch (args.action) {
    case "list":
      return handleList({ root });
    case "get": {
      const jobId = String(args.job_id ?? "");
      if (!jobId) return { content: { type: "text", text: JSON.stringify(withStructured({}, "INVALID_ARGUMENT", "job_id is required for get")) }, isError: true };
      return handleFetchJob({ job_id: jobId, fields: ALL_FETCH_FIELDS }, { root });
    }
    case "cancel": {
      const jobId = String(args.job_id ?? "");
      if (!jobId) return { content: { type: "text", text: JSON.stringify(withStructured({}, "INVALID_ARGUMENT", "job_id is required for cancel")) }, isError: true };
      const res = await deps.store.cancel(jobId, "cancelled via cx_agent_session");
      if (res.status === "not_found") return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "not_found" }, "SESSION_NOT_FOUND", "no live job with that id")) }, isError: true };
      if (res.status === "failed") return { content: { type: "text", text: JSON.stringify(withStructured({ job_id: jobId, status: "failed" }, "INTERNAL", res.error)) }, isError: true };
      return { content: { type: "text", text: JSON.stringify({ job_id: jobId, status: "cancelled", error: structured("CANCELLED", "terminal cancel; the job is not resumable") }) } };
    }
    case "clean": {
      const statuses = new Set((args.statuses ?? []).filter(Boolean));
      const olderThanMs = typeof args.older_than_ms === "number" ? args.older_than_ms : NaN;
      const dryRun = args.dry_run === true;
      const removed: string[] = [];
      const seen: string[] = [];
      if (existsSync(root)) {
        for (const f of readdirSync(root)) {
          if (!f.endsWith(".meta.json")) continue;
          const jobId = f.slice(0, -".meta.json".length);
          let meta: JobMeta | null = null;
          try { meta = JSON.parse(readFileSync(joinFs(root, f), "utf8")) as JobMeta; } catch { continue; }
          if (meta.status === "running") continue;
          if (deps.store.isRunning(jobId)) continue;
          if (statuses.size > 0 && !statuses.has(meta.status)) continue;
          if (!Number.isNaN(olderThanMs)) {
            const ended = meta.ended_at ? Date.parse(meta.ended_at) : NaN;
            if (!Number.isFinite(ended) || Date.now() - ended < olderThanMs) continue;
          }
          seen.push(jobId);
          if (dryRun) continue;
          removeJobFiles(root, jobId);
          deps.store.forget(jobId);
          removed.push(jobId);
        }
      }
      return { content: { type: "text", text: JSON.stringify({ dry_run: dryRun, matched: seen.length, removed: dryRun ? [] : removed, ids: dryRun ? seen : undefined }) } };
    }
    default:
      return { content: { type: "text", text: JSON.stringify(withStructured({}, "INVALID_ARGUMENT", `unknown action: ${String(args.action)}`)) }, isError: true };
  }
}

function removeJobFiles(root: string, jobId: string): void {
  for (const ext of [".meta.json", ".jsonl"]) {
    const p = joinFs(root, `${jobId}${ext}`);
    try { rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
}

export interface SetupResult extends ReadinessResult {
  completion_delivery?: ReturnType<typeof completionDelivery>;
  engine?: EngineName;
  capabilities?: (typeof ENGINE_CAPABILITIES)[EngineName];
  context?: ContextPolicy | null;
}

export async function handleSetup(
  poolName?: string,
  opts: { provider?: ModelProvider; engine?: string; verify?: boolean; fetchImpl?: typeof fetch; hostAdapter?: boolean } = {},
): Promise<{ content: { type: "text"; text: string }; isError?: boolean }> {
  const settings = loadSettings();
  const model = poolName ?? settings.pool;
  let engine: EngineName | undefined;
  try {
    engine = resolveEngine(opts.engine);
    const provider = opts.provider ?? resolveProvider();
    const readiness = await inspectReadiness({ provider, model, engine, verify: opts.verify, fetchImpl: opts.fetchImpl });
    const payload: SetupResult = { ...readiness, engine, capabilities: ENGINE_CAPABILITIES[engine], context: resolveContextPolicy(engine) ?? null, completion_delivery: completionDelivery(opts.hostAdapter) };
    const isError = readiness.configuration !== "configured" || !model || readiness.availability.status === "unavailable" || (opts.verify === true && !readiness.ready);
    return { content: { type: "text", text: JSON.stringify(payload) }, isError };
  } catch {
    const payload: SetupResult = {
      ready: false, phase: "configuration", configuration: "invalid", model: model ?? null, models: [],
      availability: { status: "unknown", source: "unknown" }, protocol: { status: "skipped", api: "unknown" },
      diagnostics: ["Could not inspect readiness. Check the engine, gateway configuration, and model discovery."],
      completion_delivery: completionDelivery(opts.hostAdapter),
      ...(engine ? { engine, capabilities: ENGINE_CAPABILITIES[engine] } : {}),
    };
    return { content: { type: "text", text: JSON.stringify(payload) }, isError: true };
  }
}

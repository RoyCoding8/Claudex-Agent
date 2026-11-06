#!/usr/bin/env node
// cx-agent — stdio MCP server entry.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  handleRun, handleList, handleFetchJob, handleInterrupt,
  handleReply, handleCheck, handleSession, handleSetup, handleWait, handleCompact,
  runInputSchema, fetchInputSchema, interruptInputSchema,
  replyInputSchema, checkInputSchema, sessionInputSchema, setupInputSchema, waitInputSchema, compactInputSchema,
  type InterruptRegistry, type ReplyHandlerDeps,
} from "./tools.js";
import { runWorker } from "./worker.js";
import { loadSettings, transcriptDir, migrateDataOnce, CX_AGENT_VERSION } from "./settings.js";
import { SessionStore } from "./session-store.js";

export interface ServerOptions {
  name?: string;
  version?: string;
  runWorker?: typeof runWorker;
  store?: SessionStore;
}

export function createServer(opts: ServerOptions = {}): {
  server: McpServer;
  registry: InterruptRegistry;
  store: SessionStore;
  connect: () => Promise<void>;
} {
  const defaults = loadSettings();
  try { migrateDataOnce(); } catch {  }
  const registry: InterruptRegistry = new Map();
  const run = opts.runWorker ?? runWorker;
  const transcriptRoot = transcriptDir();
  const store = opts.store ?? new SessionStore({ runWorker: run, defaults, transcriptRoot });

  const server = new McpServer(
    { name: opts.name ?? "cx-agent", version: opts.version ?? CX_AGENT_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "cx_agent_run",
    {
      description:
        "Delegate a task to a worker. Use background:true to return {job_id,status:running} immediately, " +
        "then cx_agent_wait for bounded completion checks while other work continues. Without background:true the call " +
        "blocks until terminal; client backgrounding and notifications depend on the client. The worker is " +
        "isolated from this conversation. Completed jobs return ONLY {job_id, result}; non-completed jobs return " +
        "{job_id, status, error, resumable} where error is a typed {code, message}. A job that runs out of budget " +
        "(max_turns, max_budget_usd or timeout_ms) ends as status `incomplete` with resumable:true — the work so far is " +
        "kept and cx_agent_reply(job_id, prompt) continues it in the same session. Budget stops are also retried " +
        "automatically up to `auto_continue` times before the job returns. Pass `thinking` (and optionally `effort`) to " +
        "capture the worker's reasoning — it is written to the JSONL transcript only and read back with " +
        "cx_agent_fetch fields:[\"reasoning\"], never on this envelope. All metadata and transcript details stay on " +
        "disk; use cx_agent_fetch only when a specific additional field is actually needed.",
      inputSchema: runInputSchema,
    },
    async (args, extra) => {
      const progressToken = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const out = await handleRun(
        args as Record<string, unknown>,
        { progressToken, sendNotification: extra.sendNotification as (n: unknown) => Promise<void>, signal: extra.signal },
        { runWorker: run, defaults, registry, transcriptRoot, store },
      );
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_wait",
    {
      description: "Retrieve a background job result, waiting at most timeout_ms (default 1000, maximum 30000). Returns {job_id,status:running} when still working, or the terminal run envelope. Wait timeout and request cancellation do not cancel the worker. Jobs require this server process to remain alive.",
      inputSchema: waitInputSchema,
    },
    async (args, extra) => {
      const out = await handleWait(args, store, extra.signal);
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_compact",
    {
      description: "Compact a terminal job's native session using its SDK. Currently supported by Pi. Accepts optional instructions, timeout_ms and background:true. Creates a new job on the same session and uses the same session lock as reply. Unsupported engines return UNSUPPORTED_OPERATION.",
      inputSchema: compactInputSchema,
    },
    async (args, extra) => {
      const progressToken = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const out = await handleCompact(args, { progressToken, sendNotification: extra.sendNotification as (n: unknown) => Promise<void>, signal: extra.signal }, { store, registry });
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_list",
    {
      description:
        "List recent cx-agent jobs from their .meta.json sidecars. This is an operator convenience for " +
        "INSPECTION ONLY — it does NOT wait, does NOT return the result of a running job, and is NOT a polling tool. " +
        "Use cx_agent_wait to collect a background job result. Returns one line per job.",
      inputSchema: {},
    },
    async () => {
      const out = handleList({ root: transcriptDir() });
      return { content: [{ type: "text" as const, text: out.content.text }] };
    },
  );

  server.registerTool(
    "cx_agent_fetch",
    {
      description:
        "Fetch selected persisted fields for a cx-agent job from its read-only meta sidecar. This never waits or polls. " +
        "Use it only when you need a specific omitted detail after cx_agent_run: e.g. fields:[\"result\"] for the full " +
        "result, fields:[\"files_changed\"] for the paths the job touched, or fields:[\"session_id\",\"turns\"]. " +
        "fields:[\"reasoning\"] additionally reads the job's thinking blocks out of the JSONL transcript — the one " +
        "deliberately large field, and empty unless the job ran with `thinking` set. " +
        "If fields is omitted it returns only status + error.",
      inputSchema: fetchInputSchema,
    },
    async (args) => {
      const out = handleFetchJob({ job_id: args.job_id, fields: args.fields });
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_reply",
    {
      description:
        "Continue or fork ANY terminal cx-agent job that holds a session — completed, incomplete (max_turns / " +
        "max_budget_usd / timeout) or interrupted — by resuming its SDK session with a new prompt. This is the recovery " +
        "path for a job killed by its budget: the worker picks up where it stopped rather than restarting. Use background:true " +
        "to return immediately, then cx_agent_wait for the result. Otherwise blocks until terminal. The reply gets a " +
        "NEW job_id continuing the SAME session. cwd, model, agent, tool menu and reasoning config (thinking/effort) are " +
        "INHERITED from the source job (SDK sessions are stored per-cwd, so a resume elsewhere would not find them); " +
        "budget is NOT inherited, so the reply starts with a fresh full allowance. " +
        "fork:true branches to a NEW session id (original untouched). Rejects " +
        "with SESSION_BUSY while the job or another continuation of its session is still running and SESSION_NOT_FOUND if the job is unknown or never " +
        "recorded a session.",
      inputSchema: replyInputSchema,
    },
    async (args, extra) => {
      const progressToken = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const out = await handleReply(
        args as Record<string, unknown>,
        { progressToken, sendNotification: extra.sendNotification as (n: unknown) => Promise<void>, signal: extra.signal },
        { store, registry } as ReplyHandlerDeps,
      );
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_check",
    {
      description:
        "Inspect ring-buffered events for a KNOWN job_id since a cursor — { status, events[], nextCursor, terminal }. " +
        "Use cx_agent_wait to collect completion. A settled job whose " +
        "live record detached returns its terminal status with events:[]. Use it for resumed/external jobs the main " +
        "agent already has an id for; never poll with it.",
      inputSchema: checkInputSchema,
    },
    async (args) => {
      const out = handleCheck({ job_id: args.job_id, since_cursor: args.since_cursor }, store);
      return { content: [{ type: "text" as const, text: out.content.text }] };
    },
  );

  server.registerTool(
    "cx_agent_session",
    {
      description:
        "Manage cx-agent job records. action:list returns one-line-per-job; get returns a full meta for a job_id; " +
        "cancel is a TERMINAL stop of a live job (not resumable — prefer cx_agent_interrupt for resumable stop); clean " +
        "deletes terminal job files subject to statuses/older_than_ms filters (dry_run previews without deleting).",
      inputSchema: sessionInputSchema,
    },
    async (args) => {
      const out = await handleSession(
        { action: args.action, job_id: args.job_id, statuses: args.statuses, older_than_ms: args.older_than_ms, dry_run: args.dry_run },
        { store, root: transcriptDir() },
      );
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_setup",
    {
      description:
        "Check endpoint readiness before delegating. Returns { ready, engine, capabilities, model, models, diagnostics }. " +
        "Reports the selected SDK adapter capabilities and checks gateway configuration. Optional engine and model override defaults. " +
        "Configured endpoints and models still require a live run to validate protocol compatibility.",
      inputSchema: setupInputSchema,
    },
    async (args) => {
      const out = await handleSetup(args.model, { engine: args.engine });
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  server.registerTool(
    "cx_agent_interrupt",
    {
      description:
        "Interrupt a running cx-agent job by job_id. Kills the worker process tree and settles the job " +
        "as status=interrupted. The job stays RESUMABLE via cx_agent_reply when a native session was recorded (its session_id is " +
        "retained). For a terminal, non-resumable stop use cx_agent_session cancel. Returns status interrupted or " +
        "not_found (SESSION_NOT_FOUND typed error). The job_id of an in-flight job is announced on the progress " +
        "channel as \"job <id> started\" as soon as it launches.",
      inputSchema: interruptInputSchema,
    },
    async (args, _extra) => {
      const out = await handleInterrupt({ job_id: args.job_id }, {} as never, store);
      return { content: [{ type: "text" as const, text: out.content.text }], isError: out.isError };
    },
  );

  return {
    server, registry, store,
    connect: async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}

async function main(): Promise<void> {
  console.error(`[cx-agent] starting v${CX_AGENT_VERSION}`);
  const { connect } = createServer();
  await connect();
}

function normalizeEntryPath(p: string): string {
  const resolved = resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
const isMain =
  process.argv[1] !== undefined &&
  normalizeEntryPath(fileURLToPath(import.meta.url)) === normalizeEntryPath(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error("[cx-agent] fatal:", e);
    process.exit(1);
  });
}

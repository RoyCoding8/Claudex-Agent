import { spawn as spawnChild } from "node:child_process";
import { query, type Options, type SDKMessage, type SpawnOptions, type SpawnedProcess, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefaults } from "../settings.js";
import { WORKER_DISALLOWED_TOOLS } from "../settings.js";
import { buildWorkerEnv, type EffortLevel } from "./claude-sdk.js";
import type { Connection } from "../providers/types.js";
import { InterruptHandle } from "../interrupt.js";
import type { EngineInput, EngineResult, TokenUsage } from "./engine.js";
import type { SdkMessageLike } from "../progress.js";
import { READ_ONLY_TOOLS } from "../access.js";

export const CONTINUE_PROMPT =
  "You stopped because you ran out of turn/cost budget for that round, not because the task was finished. " +
  "Continue from exactly where you left off — do not restart, re-plan, or repeat work you already did. " +
  "If the task is in fact already complete, say so in one line and stop.";

export interface ClaudeRunInput extends EngineInput {
  connection: Connection;
  defaults: AgentDefaults;
  queryFn?: typeof query;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  onMessage(message: SDKMessage): void;
  onContinuation(round: number, maxRounds: number, reason: string, sessionId: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toLike(msg: SDKMessage): SdkMessageLike {
  const raw: unknown = msg;
  if (!isRecord(raw)) return { type: msg.type };
  const message = isRecord(raw.message) ? raw.message : undefined;
  const blocks = message?.content ?? raw.content;
  const content = Array.isArray(blocks)
    ? blocks.flatMap((value): NonNullable<SdkMessageLike["content"]> => {
      if (!isRecord(value) || typeof value.type !== "string") return [];
      return [{
        type: value.type,
        ...(typeof value.text === "string" ? { text: value.text } : {}),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...("input" in value ? { input: value.input } : {}),
        ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
      }];
    })
    : undefined;
  return {
    type: typeof raw.type === "string" ? raw.type : msg.type,
    ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
    ...(content ? { content } : {}),
    ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
    ...(raw.status === null || typeof raw.status === "string" ? { status: raw.status } : {}),
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
    ...(Array.isArray(raw.errors) && raw.errors.every((error) => typeof error === "string") ? { errors: raw.errors } : {}),
  };
}

function recordKind(msg: SDKMessage): "assistant" | "user" | "result" | "system" | "tool_use" | "progress" {
  switch (msg.type) {
    case "assistant": return "assistant";
    case "user": return "user";
    case "result": return "result";
    case "system": return "system";
    case "tool_use_summary": return "tool_use";
    default: return "progress";
  }
}

function isBudgetStop(subtype: string | undefined): boolean {
  return subtype === "error_max_turns" || subtype === "error_max_budget_usd";
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
    if (stderrMode === "pipe" && child.stderr) child.stderr.on("data", (data) => process.stderr.write(String(data)));
    if (!child.stdin || !child.stdout) throw new Error("Claude SDK subprocess did not expose stdin/stdout pipes");
    if (typeof child.pid === "number") interrupt.setPid(child.pid);
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: (signal) => child.kill(signal),
      on: child.on.bind(child) as SpawnedProcess["on"],
      once: child.once.bind(child) as SpawnedProcess["once"],
      off: child.off.bind(child) as SpawnedProcess["off"],
    };
  };
}

export async function runClaude(
  input: ClaudeRunInput,
  interrupt: InterruptHandle,
): Promise<EngineResult> {
  const readOnly = input.access?.mode === "read-only";
  if (readOnly && input.agent) throw new Error("Claude read-only access does not allow agents.");
  const queryFn = input.queryFn ?? query;
  const autoContinue = input.autoContinue ?? input.defaults.autoContinue;
  const env = buildWorkerEnv(input.connection, { gitBashPath: input.defaults.gitBashPath });
  if (input.context?.window_tokens !== undefined) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(input.context.window_tokens);
  if (input.context?.max_output_tokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(input.context.max_output_tokens);
  if (input.context?.compaction?.enabled !== undefined) env.DISABLE_AUTO_COMPACT = input.context.compaction.enabled ? "0" : "1";
  const options: Options = {
    env,
    cwd: input.cwd,
    model: input.model,
    disallowedTools: [...WORKER_DISALLOWED_TOOLS, ...(input.disallowedTools ?? [])],
    maxTurns: input.maxTurns ?? input.defaults.maxTurns,
    abortController: interrupt.abortController,
    settingSources: readOnly ? [] : input.defaults.inheritSettings ? ["user", "project", "local"] : [],
    permissionMode: readOnly ? "default" : "bypassPermissions",
    allowDangerouslySkipPermissions: !readOnly,
    persistSession: true,
    spawnClaudeCodeProcess: makeSpawnWithPid(interrupt),
    canUseTool: async (toolName, toolInput, options) => {
      if (options.signal.aborted) return { behavior: "deny", message: "aborted", interrupt: true };
      if (readOnly && READ_ONLY_TOOLS.some((tool) => tool === toolName)) return { behavior: "allow", updatedInput: toolInput };
      return { behavior: "deny", message: "permission requests are not interactive in cx-agent; refusing", interrupt: true };
    },
  };
  if (readOnly) options.tools = [...READ_ONLY_TOOLS];
  else if (input.allowedTools?.length) options.tools = input.allowedTools;
  if (!readOnly && input.agent) options.agent = input.agent;
  if ((input.maxBudgetUsd ?? input.defaults.maxBudgetUsd) > 0) options.maxBudgetUsd = input.maxBudgetUsd ?? input.defaults.maxBudgetUsd;
  if (input.thinking) options.thinking = input.thinking;
  if (input.effort) options.effort = input.effort;
  if (input.defaults.forwardSubagentText) options.forwardSubagentText = true;
  if (input.resumeSessionId) {
    options.resume = input.resumeSessionId;
    if (input.fork) options.forkSession = true;
  }

  let resultMessage: Extract<SDKMessage, { type: "result" }> | undefined;
  let sessionId: string | null = null;
  const filesChanged = new Set<string>();
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let turns = 0;
  let continuations = 0;
  let error: string | null = null;
  try {
    let prompt = input.prompt;
    let roundOptions = options;
    for (;;) {
      resultMessage = undefined;
      for await (const msg of queryFn({ prompt, options: roundOptions })) {
        if (!sessionId && "session_id" in msg && typeof msg.session_id === "string") sessionId = msg.session_id;
        if (interrupt.isAborted) {
          error = "interrupted";
          break;
        }
        input.onMessage(msg);
        collectFilesChanged(msg, filesChanged);
        if (msg.type === "result") {
          resultMessage = msg;
          break;
        }
      }

      turns += resultMessage?.num_turns ?? 0;
      addUsage(usage, resultMessage?.usage);
      const subtype = resultMessage?.subtype;
      if (!isBudgetStop(subtype) || continuations >= autoContinue || interrupt.isAborted || !sessionId) break;

      continuations += 1;
      input.onContinuation(continuations, autoContinue, subtype ?? "budget stop", sessionId);
      prompt = CONTINUE_PROMPT;
      roundOptions = { ...options, resume: sessionId, forkSession: false };
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const resultText = resultMessage && "result" in resultMessage && typeof resultMessage.result === "string"
    ? resultMessage.result
    : "";
  const errorText = error ?? (resultMessage?.subtype === "error_max_turns"
    ? "reached max_turns"
    : resultMessage?.subtype === "error_max_budget_usd"
      ? `reached max budget of ${input.maxBudgetUsd ?? input.defaults.maxBudgetUsd} USD`
      : (resultMessage && "errors" in resultMessage ? resultMessage.errors?.join("; ") : undefined) ?? resultMessage?.subtype ?? "unknown error");
  const completed = resultMessage?.subtype === "success" && !resultMessage.is_error && error === null;
  const usageResult = hasUsage(usage) ? usage : undefined;

  return {
    result: resultText,
    sessionId,
    turns,
    ...(completed
      ? { status: "completed" as const, error: null }
      : { status: isBudgetStop(resultMessage?.subtype) ? "incomplete" as const : "failed" as const, error: errorText }),
    ...(usageResult ? { usage: usageResult } : {}),
    filesChanged: [...filesChanged].sort(),
    continuations,
  };
}

function addUsage(into: TokenUsage, from: TokenUsage | undefined): void {
  if (!from) return;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_creation_input_tokens += from.cache_creation_input_tokens;
  into.cache_read_input_tokens += from.cache_read_input_tokens;
}

function hasUsage(usage: TokenUsage): boolean {
  return usage.input_tokens > 0 || usage.output_tokens > 0
    || usage.cache_creation_input_tokens > 0 || usage.cache_read_input_tokens > 0;
}

function collectFilesChanged(message: SDKMessage, files: Set<string>): void {
  const raw: unknown = message;
  if (!isRecord(raw) || (raw.type !== "assistant" && raw.type !== "tool_use_summary")) return;
  const body = isRecord(raw.message) ? raw.message : undefined;
  const blocks = body?.content;
  if (!Array.isArray(blocks)) return;
  for (const value of blocks) {
    if (!isRecord(value) || value.type !== "tool_use" || !isRecord(value.input)) continue;
    for (const key of ["file_path", "path", "notebook_path"]) {
      const path = value.input[key];
      if (typeof path !== "string" || path.length === 0) continue;
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
      files.add(parts.at(-1) ?? path);
    }
  }
}

export { recordKind, toLike };

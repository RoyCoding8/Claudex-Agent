import { configValue } from "../config.js";
import { CONTEXT_CONTROLS } from "./context-policy.js";
import { RequestError } from "../errors.js";

export const ENGINE_NAMES = ["claude", "codex", "pi"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export const ENGINE_CAPABILITIES = {
  claude: { resume: true, fork: true, compact: false, auto_compact: true, context: CONTEXT_CONTROLS.claude, read_only: "tool-allowlist" },
  codex: { resume: true, fork: false, compact: false, auto_compact: true, context: CONTEXT_CONTROLS.codex, read_only: "native-sandbox" },
  pi: { resume: true, fork: true, compact: true, auto_compact: true, context: CONTEXT_CONTROLS.pi, read_only: "tool-allowlist" },
} as const;

export type WorkerEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_use"; name: string; summary: string }
  | { kind: "tool_result"; summary: string }
  | { kind: "system" | "progress"; summary: string };

export interface EngineInput {
  prompt: string;
  operation?: "prompt" | "compact";
  model: string;
  cwd: string;
  resumeSessionId?: string;
  fork?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  autoContinue?: number;
  agent?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  thinking?: unknown;
  effort?: string;
  timeoutMs: number;
  connection?: import("../providers/types.js").Connection;
  context?: import("./context-policy.js").ContextPolicy;
  access?: import("../access.js").AccessPolicy;
}

export interface EngineRunContext {
  signal: AbortSignal;
  emit(event: WorkerEvent): void;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type EngineResult = {
  result: string;
  sessionId: string | null;
  turns: number;
  usage?: TokenUsage;
  filesChanged?: string[];
  continuations?: number;
} & (
  | { status: "completed"; error: null }
  | { status: "failed" | "incomplete"; error: string }
);

const RUNTIME_ENV_KEYS = [
  "PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS",
] as const;

export function buildRuntimeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function parseEngineName(value: unknown): EngineName | undefined {
  return typeof value === "string" ? ENGINE_NAMES.find((name) => name === value) : undefined;
}

export function resolveEngine(input: unknown, environment = process.env, configured: unknown = configValue("CX_AGENT_ENGINE")): EngineName {
  const value = input ?? environment.CX_AGENT_ENGINE ?? configured ?? "claude";
  const engine = parseEngineName(value);
  if (!engine) throw new Error("Unknown worker engine \"" + String(value) + "\". Expected " + ENGINE_NAMES.join(", ") + ".");
  return engine;
}

export function assertEngineOptionsSupported(engine: Exclude<EngineName, "claude">, input: Pick<EngineInput,
  "agent" | "maxTurns" | "maxBudgetUsd" | "autoContinue" | "allowedTools" | "disallowedTools" | "thinking" | "effort"
>): void {
  const unsupported: string[] = [];
  if (input.agent) unsupported.push("agent");
  if (input.maxTurns != null) unsupported.push("max_turns");
  if (input.maxBudgetUsd != null) unsupported.push("max_budget_usd");
  if (input.autoContinue != null) unsupported.push("auto_continue");
  if (input.allowedTools?.length) unsupported.push("allowed_tools");
  if (input.disallowedTools?.length) unsupported.push("disallowed_tools");
  if (input.thinking != null) unsupported.push("thinking");
  if (engine === "pi" && input.effort != null) unsupported.push("effort");
  if (unsupported.length > 0) {
    throw new RequestError("UNSUPPORTED_OPERATION", engine + " does not support these Claude-specific options: " + unsupported.join(", ")
      + ". Use timeout_ms for a wall-clock limit; use claude for turn/cost budgets and tool menus."
      + (engine === "pi" && input.effort != null ? " Omit effort for Pi." : ""));
  }
}

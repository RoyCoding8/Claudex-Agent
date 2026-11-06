/** Claude Agent SDK runtime — maps a provider-neutral Connection to the Anthropic-shaped worker env. */

import type { ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Connection } from "../providers/types.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const THINKING_DISPLAYS = ["summarized", "omitted"] as const;
export type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

/** Flat wire form of ThinkingConfig: a mode name, or a positive budgetTokens count. */
export type ThinkingSpec = "adaptive" | "disabled" | number;

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export function isThinkingDisplay(v: unknown): v is ThinkingDisplay {
  return typeof v === "string" && (THINKING_DISPLAYS as readonly string[]).includes(v);
}

export function parseThinkingSpec(v: unknown): ThinkingSpec | undefined {
  if (v === "adaptive" || v === "disabled") return v;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Map the flat spec onto the SDK's ThinkingConfig union.
 *
 *  `display` defaults to "summarized" for the on-modes: the API default is "omitted" on
 *  Opus 4.7+, which streams thinking blocks with empty text — asking cx-agent for thinking
 *  and silently getting nothing back is the one outcome nobody wants. */
export function buildThinkingConfig(
  spec: ThinkingSpec | undefined,
  display?: ThinkingDisplay,
): ThinkingConfig | undefined {
  if (spec === undefined) return undefined;
  if (spec === "disabled") return { type: "disabled" };
  const shown = display ?? "summarized";
  return spec === "adaptive"
    ? { type: "adaptive", display: shown }
    : { type: "enabled", budgetTokens: spec, display: shown };
}

export interface PoolEnvTemplate {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
  ANTHROPIC_SMALL_FAST_MODEL: string;
  CLAUDE_CODE_SUBAGENT_MODEL: string;
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: string;
  CLAUDE_CODE_GIT_BASH_PATH: string;
  CX_AGENT_DEPTH: string;
}

const FALLBACK_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";

export function parseDepth(v: string | undefined): number {
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function buildPoolEnv(
  conn: Connection,
  opts: { gitBashPath?: string; depth?: number } = {},
): PoolEnvTemplate {
  const isWin = process.platform === "win32";
  const gitBashPath = isWin
    ? (opts.gitBashPath ?? process.env.CX_AGENT_SHELL_PATH ?? process.env.CLAUDE_CODE_GIT_BASH_PATH ?? FALLBACK_GIT_BASH_PATH)
    : "";
  const incomingDepth = parseDepth(process.env.CX_AGENT_DEPTH);
  const depth = opts.depth ?? incomingDepth + 1;
  const apiKeyAuth = conn.authMode === "api-key";
  return {
    ANTHROPIC_BASE_URL: conn.baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKeyAuth ? "" : conn.apiKey,
    ANTHROPIC_API_KEY: apiKeyAuth ? conn.apiKey : "",
    ANTHROPIC_MODEL: conn.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: conn.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: conn.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: conn.model,
    ANTHROPIC_SMALL_FAST_MODEL: conn.model,
    CLAUDE_CODE_SUBAGENT_MODEL: conn.model,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_GIT_BASH_PATH: gitBashPath,
    CX_AGENT_DEPTH: String(depth),
  };
}

const RUNTIME_PASSTHROUGH_KEYS = [
  "PATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
] as const;

export function buildWorkerEnv(
  conn: Connection,
  opts: { gitBashPath?: string; depth?: number } = {},
): Record<string, string> {
  const poolEnv = buildPoolEnv(conn, opts);
  const runtime: Record<string, string> = {};
  for (const k of RUNTIME_PASSTHROUGH_KEYS) {
    const v = process.env[k];
    if (v) runtime[k] = v;
  }
  const extra = conn.extraEnv ?? {};
  return { ...runtime, ...extra, ...poolEnv };
}

const SELF_TOOLS = [
  "cx_agent_run", "cx_agent_reply", "cx_agent_check", "cx_agent_fetch",
  "cx_agent_interrupt", "cx_agent_session", "cx_agent_setup", "cx_agent_list",
  "cx_agent_wait",
  "cx_agent_compact",
] as const;

export const WORKER_DISALLOWED_TOOLS: string[] = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "PushNotification",
  ...SELF_TOOLS.flatMap((name) => [name, `mcp__cx-agent__${name}`]),
];

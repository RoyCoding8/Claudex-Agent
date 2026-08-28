// cx-agent settings — defaults + config loading.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUnder, joinPath, jobStoreDir, migrateLegacyJobStore, dataDir, resolveFs } from "./paths.js";
import {
  parseDepth,
  WORKER_DISALLOWED_TOOLS,
  isEffortLevel,
  isThinkingDisplay,
  parseThinkingSpec,
  type EffortLevel,
  type ThinkingDisplay,
  type ThinkingSpec,
} from "./runtime/claude-sdk.js";
import { resolveEnv, loadConfigFile, type CanonicalKey } from "./config.js";

export { parseDepth, WORKER_DISALLOWED_TOOLS };

export const packageRoot: string = (() => {
  const here = typeof __dirname !== "undefined"
    ? __dirname
    : (import.meta.url ? dirname(fileURLToPath(import.meta.url)) : process.cwd());
  let dir = here;
  for (let i = 0; i < 6 && dir && dir !== dirname(dir); i++) {
    if (existsSync(joinPath(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return here;
})();

export const CX_AGENT_VERSION: string = (() => {
  try {
    const raw = readFileSync(joinPath(packageRoot, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export interface AgentDefaults {
  pool: string;
  maxTurns: number;
  allowedTools: string[];
  timeoutMs: number;
  gitBashPath: string;
  maxDepth: number;
  inheritSettings: boolean;
  
  maxBudgetUsd: number;

  autoContinue: number;

  /** Left undefined = never sent to the SDK, so worker behaviour is unchanged. */
  thinking?: ThinkingSpec;
  thinkingDisplay?: ThinkingDisplay;
  effort?: EffortLevel;
  /** Subagent output — reasoning included — reaches the parent stream only with this on. */
  forwardSubagentText: boolean;
}


export const MAX_AUTO_CONTINUE = 10;

export const FALLBACK_DEFAULTS: AgentDefaults = {
  pool: "",
  maxTurns: 200,
  allowedTools: [],
  timeoutMs: 14_400_000,
  gitBashPath: "",
  maxDepth: 2,
  inheritSettings: false,
  maxBudgetUsd: 0,
  autoContinue: 2,
  forwardSubagentText: false,
};


export function clampAutoContinue(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_AUTO_CONTINUE);
}


export function resolveModel(opts: { configPool?: string } = {}): string {
  const fromEnv = resolveEnv("CX_AGENT_MODEL");
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromConfig = opts.configPool ?? loadConfigFile()?.agent_defaults?.pool;
  if (typeof fromConfig === "string" && fromConfig.length > 0) return fromConfig;
  return "";
}


function envFlag(key: CanonicalKey): boolean {
  const v = resolveEnv(key)?.toLowerCase();
  return v === "1" || v === "true";
}

function reasoningFromEnv() {
  const display = resolveEnv("CX_AGENT_THINKING_DISPLAY");
  const effort = resolveEnv("CX_AGENT_EFFORT");
  return {
    thinking: parseThinkingSpec(resolveEnv("CX_AGENT_THINKING")),
    thinkingDisplay: isThinkingDisplay(display) ? display : undefined,
    effort: isEffortLevel(effort) ? effort : undefined,
  };
}

function envOnlyDefaults(): AgentDefaults {
  return {
    ...FALLBACK_DEFAULTS,
    pool: resolveModel(),
    inheritSettings: envFlag("CX_AGENT_INHERIT_SETTINGS"),
    forwardSubagentText: envFlag("CX_AGENT_FORWARD_SUBAGENT_TEXT"),
    ...reasoningFromEnv(),
  };
}

export function loadSettings(path: string = resolveEnv("CX_AGENT_CONFIG") ?? resolveFs(dataDir(), "settings.json")): AgentDefaults {
  const fwdPath = path.replace(/\\/g, "/");
  if (!existsSync(fwdPath)) return envOnlyDefaults();
  try {
    const raw = readFileSync(fwdPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<{ agent_defaults?: Record<string, unknown> }>;
    const a = parsed.agent_defaults ?? {};
    const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const asStrArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
    const configPool = asStr(a.pool);
    const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
    // Env overrides config-file values (env → config → built-in fallback), matching how
    // `pool`/`model` already resolve. These keys let an operator tune the worker budget
    // without editing a JSON config file.
    const envNum = (key: "CX_AGENT_MAX_TURNS" | "CX_AGENT_TIMEOUT_MS" | "CX_AGENT_MAX_BUDGET_USD" | "CX_AGENT_AUTO_CONTINUE"): number | undefined => {
      const e = resolveEnv(key);
      if (e === undefined) return undefined;
      const n = Number(e);
      return Number.isFinite(n) ? n : undefined;
    };
    const envReasoning = reasoningFromEnv();
    const fileDisplay = a.thinkingDisplay ?? a.thinking_display;
    const fileEffort = a.effort;
    return {
      pool: resolveModel({ configPool }),
      maxTurns: envNum("CX_AGENT_MAX_TURNS") ?? asNum(a.maxTurns) ?? asNum(a.max_turns) ?? FALLBACK_DEFAULTS.maxTurns,
      allowedTools: asStrArr(a.allowedTools) ?? asStrArr(a.allowed_tools) ?? FALLBACK_DEFAULTS.allowedTools,
      timeoutMs: envNum("CX_AGENT_TIMEOUT_MS") ?? asNum(a.timeoutMs) ?? asNum(a.timeout_ms) ?? FALLBACK_DEFAULTS.timeoutMs,
      gitBashPath: asStr(a.gitBashPath) ?? asStr(a.git_bash_path) ?? FALLBACK_DEFAULTS.gitBashPath,
      maxDepth: asNum(a.maxDepth) ?? asNum(a.max_depth) ?? FALLBACK_DEFAULTS.maxDepth,
      inheritSettings: asBool(a.inheritSettings) ?? asBool(a.inherit_settings) ?? envFlag("CX_AGENT_INHERIT_SETTINGS"),
      maxBudgetUsd: envNum("CX_AGENT_MAX_BUDGET_USD") ?? asNum(a.maxBudgetUsd) ?? asNum(a.max_budget_usd) ?? FALLBACK_DEFAULTS.maxBudgetUsd,
      autoContinue: clampAutoContinue(envNum("CX_AGENT_AUTO_CONTINUE") ?? asNum(a.autoContinue) ?? asNum(a.auto_continue) ?? FALLBACK_DEFAULTS.autoContinue),
      thinking: envReasoning.thinking ?? parseThinkingSpec(a.thinking),
      thinkingDisplay: envReasoning.thinkingDisplay ?? (isThinkingDisplay(fileDisplay) ? fileDisplay : undefined),
      effort: envReasoning.effort ?? (isEffortLevel(fileEffort) ? fileEffort : undefined),
      forwardSubagentText:
        asBool(a.forwardSubagentText) ?? asBool(a.forward_subagent_text) ?? envFlag("CX_AGENT_FORWARD_SUBAGENT_TEXT"),
    };
  } catch {
    return envOnlyDefaults();
  }
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (/TOKEN|KEY|SECRET|AUTH/i.test(k)) {
      out[k] = v ? "(set, redacted)" : "(empty)";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function transcriptDir(): string {
  return jobStoreDir();
}

export function legacyDataDir(): string {
  return resolveUnder(packageRoot, "data", "agents");
}

export function migrateDataOnce(opts: { force?: boolean; sentinelDir?: string; now?: number } = {}): string[] | null {
  return migrateLegacyJobStore(resolveUnder(packageRoot, "data"), opts);
}


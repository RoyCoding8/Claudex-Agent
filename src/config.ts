// cx-agent config — env key resolution + legacy aliases.

import { existsSync, readFileSync } from "node:fs";

const LEGACY_ALIASES = {
  CX_AGENT_PROVIDER: [],
  CX_AGENT_BASE_URL: [],
  CX_AGENT_API_KEY: [],
  CX_AGENT_AUTH_MODE: [],
  CX_AGENT_MODEL: [],
  CX_AGENT_MODELS: [],
  CX_AGENT_DISCOVERY: [],
  CX_AGENT_DISCOVERY_TTL_MS: [],
  CX_AGENT_CONFIG: ["CX_AGENT_SETTINGS"],
  CX_AGENT_DATA_DIR: [],
  CX_AGENT_SHELL_PATH: ["CLAUDE_CODE_GIT_BASH_PATH"],
  CX_AGENT_MAX_DEPTH: [],
  CX_AGENT_DEPTH: [],
  CX_AGENT_INHERIT_SETTINGS: [],
  CX_AGENT_MAX_TURNS: [],
  CX_AGENT_TIMEOUT_MS: [],
  CX_AGENT_MAX_BUDGET_USD: [],
  CX_AGENT_AUTO_CONTINUE: [],
  CX_AGENT_THINKING: [],
  CX_AGENT_THINKING_DISPLAY: [],
  CX_AGENT_EFFORT: [],
  CX_AGENT_FORWARD_SUBAGENT_TEXT: [],
};

export type CanonicalKey = keyof typeof LEGACY_ALIASES;


export function resolveEnv(key: CanonicalKey): string | undefined {
  const v = process.env[key];
  if (v !== undefined && v.length > 0) return v;
  for (const alias of LEGACY_ALIASES[key]) {
    const av = process.env[alias];
    if (av !== undefined && av.length > 0) return av;
  }
  return undefined;
}

interface ConfigFile {
  agent_defaults?: Record<string, unknown>;
  [k: string]: unknown;
}


export function loadConfigFile(): ConfigFile | null {
  const path = resolveEnv("CX_AGENT_CONFIG");
  if (!path) return null;
  const fwd = path.replace(/\\/g, "/");
  if (!existsSync(fwd)) return null;
  try { return JSON.parse(readFileSync(fwd, "utf8")) as ConfigFile; } catch { return null; }
}


export function configValue(key: CanonicalKey, fallback?: string): string | undefined {
  const env = resolveEnv(key);
  if (env !== undefined) return env;
  const file = loadConfigFile();
  if (file) {
    const snake = key.replace(/CX_AGENT_/g, "").toLowerCase();
    const fromFile = file[key] ?? file.agent_defaults?.[key as string] ?? file[snake] ?? file.agent_defaults?.[snake];
    if (typeof fromFile === "string") return fromFile;
  }
  return fallback;
}

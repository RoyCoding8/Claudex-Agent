import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resolveEnv, configValue, loadConfigFile } from "../src/config.js";

const STUB = [
  "CX_AGENT_PROVIDER", "CX_AGENT_BASE_URL", "CX_AGENT_API_KEY", "CX_AGENT_MODEL",
  "CX_AGENT_MODELS", "CX_AGENT_DISCOVERY", "CX_AGENT_DISCOVERY_TTL_MS", "CX_AGENT_CONFIG",
  "CX_AGENT_DATA_DIR", "CX_AGENT_SHELL_PATH", "CX_AGENT_MAX_DEPTH", "CX_AGENT_DEPTH",
  "CX_AGENT_INHERIT_SETTINGS",
  "CLAUDE_CODE_GIT_BASH_PATH", "CX_AGENT_SETTINGS",
];
const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of STUB) { snapshot[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of STUB) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k]!;
  }
});

describe("resolveEnv — canonical + legacy aliases", () => {
  it("returns the canonical CX_AGENT_* value when set", () => {
    process.env.CX_AGENT_BASE_URL = "http://canonical:4000";
    expect(resolveEnv("CX_AGENT_BASE_URL")).toBe("http://canonical:4000");
  });
  it("falls back to the legacy alias CX_AGENT_SETTINGS when canonical is unset", () => {
    process.env.CX_AGENT_SETTINGS = "/legacy/settings.json";
    expect(resolveEnv("CX_AGENT_CONFIG")).toBe("/legacy/settings.json");
  });
  it("canonical wins over legacy when both are set", () => {
    process.env.CX_AGENT_CONFIG = "/canonical.json";
    process.env.CX_AGENT_SETTINGS = "/legacy.json";
    expect(resolveEnv("CX_AGENT_CONFIG")).toBe("/canonical.json");
  });
  it("returns undefined when neither canonical nor alias is set", () => {
    expect(resolveEnv("CX_AGENT_BASE_URL")).toBeUndefined();
  });
  it("ignores empty-string values (treats as unset)", () => {
    process.env.CX_AGENT_SHELL_PATH = "";
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "/usr/bin/bash";
    expect(resolveEnv("CX_AGENT_SHELL_PATH")).toBe("/usr/bin/bash");
  });
  it("CX_AGENT_SHELL_PATH aliases CLAUDE_CODE_GIT_BASH_PATH", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "/usr/bin/bash";
    expect(resolveEnv("CX_AGENT_SHELL_PATH")).toBe("/usr/bin/bash");
  });
  it("CX_AGENT_CONFIG aliases CX_AGENT_SETTINGS", () => {
    process.env.CX_AGENT_SETTINGS = "/path/to/settings.json";
    expect(resolveEnv("CX_AGENT_CONFIG")).toBe("/path/to/settings.json");
  });
});

describe("configValue — env → file → fallback", () => {
  it("returns env value when set", () => {
    process.env.CX_AGENT_MODEL = "gpt-4o";
    expect(configValue("CX_AGENT_MODEL")).toBe("gpt-4o");
  });
  it("returns fallback when nothing is set", () => {
    expect(configValue("CX_AGENT_MODEL", "Fallback lvl")).toBe("Fallback lvl");
  });
  it("returns undefined when nothing is set and no fallback", () => {
    expect(configValue("CX_AGENT_MODEL")).toBeUndefined();
  });
});

describe("loadConfigFile", () => {
  it("returns null when CX_AGENT_CONFIG is unset", () => {
    expect(loadConfigFile()).toBeNull();
  });
  it("returns null when the path does not exist", () => {
    process.env.CX_AGENT_CONFIG = "/nonexistent/path/config.json";
    expect(loadConfigFile()).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSettings, resolveModel, redactEnv, clampAutoContinue, FALLBACK_DEFAULTS, MAX_AUTO_CONTINUE, WORKER_DISALLOWED_TOOLS } from "../src/settings.js";
import { buildPoolEnv, buildWorkerEnv } from "../src/runtime/claude-sdk.js";
import type { Connection } from "../src/providers/types.js";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4000",
  apiKey: "sk-router-token",
  model: "Worker",
};

const API_KEY_CONN: Connection = {
  baseUrl: "https://gateway.example.com",
  apiKey: "anthropic-key",
  authMode: "api-key",
  model: "Worker",
};

const AMBIENT = {
  ANTHROPIC_AUTH_TOKEN: "ambient-oauth-should-not-leak",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  ANTHROPIC_API_KEY: "ambient-api-key",
  ANTHROPIC_MODEL: "claude-ambient",
};

describe("buildPoolEnv", () => {
  it("pins every model tier to the connection model", () => {
    const e = buildPoolEnv(CONN);
    expect(e.ANTHROPIC_MODEL).toBe("Worker");
    expect(e.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("Worker");
    expect(e.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("Worker");
    expect(e.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("Worker");
    expect(e.ANTHROPIC_SMALL_FAST_MODEL).toBe("Worker");
    expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBe("Worker");
  });

  it("derives base URL + auth token from the connection, blanks the API key", () => {
    const e = buildPoolEnv(CONN);
    expect(e.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(e.ANTHROPIC_AUTH_TOKEN).toBe("sk-router-token");
    expect(e.ANTHROPIC_API_KEY).toBe("");
    expect(e.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
  });

  it("maps api-key mode to the SDK API-key variable only", () => {
    const e = buildPoolEnv(API_KEY_CONN);
    expect(e.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(e.ANTHROPIC_API_KEY).toBe("anthropic-key");
  });
});

describe("FALLBACK_DEFAULTS — no model default (B-10)", () => {
  it("ships with no baked-in model default (env/config supplies it)", () => {
    expect(FALLBACK_DEFAULTS.pool).toBe("");
  });
});

describe("WORKER_DISALLOWED_TOOLS — self-delegation names (B-06)", () => {
  it("lists both bare and mcp__cx-agent__-prefixed self-delegation names", () => {
    for (const bare of [
      "cx_agent_run", "cx_agent_reply", "cx_agent_check", "cx_agent_fetch",
      "cx_agent_interrupt", "cx_agent_session", "cx_agent_setup", "cx_agent_list",
    ]) {
      expect(WORKER_DISALLOWED_TOOLS).toContain(bare);
      expect(WORKER_DISALLOWED_TOOLS).toContain(`mcp__cx-agent__${bare}`);
    }
  });
});

describe("buildWorkerEnv", () => {
  beforeEach(() => {
    // Inject ambient Anthropic values that we must prove do NOT win.
    for (const [k, v] of Object.entries(AMBIENT)) process.env[k] = v as string;
  });
  afterEach(() => {
    for (const k of Object.keys(AMBIENT)) delete process.env[k as keyof typeof AMBIENT];
  });

  it("does NOT inherit ambient ANTHROPIC_* — the hard-constraint seam", () => {
    const env = buildWorkerEnv(CONN);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-router-token");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_MODEL).toBe("Worker");
    // None of the ambient OAuth values must survive.
    expect(env.ANTHROPIC_AUTH_TOKEN).not.toBe(AMBIENT.ANTHROPIC_AUTH_TOKEN);
    expect(env.ANTHROPIC_BASE_URL).not.toBe(AMBIENT.ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_API_KEY).not.toBe(AMBIENT.ANTHROPIC_API_KEY);
    expect(env.ANTHROPIC_MODEL).not.toBe(AMBIENT.ANTHROPIC_MODEL);
  });

  it("carries the minimal runtime essentials from process.env", () => {
    const env = buildWorkerEnv(CONN);
    // PATH is read from process.env for runtime, but ANTHROPIC_* are not.
    expect(typeof env.PATH).toBe("string");
  });

  it("connection env OVERRIDES ambient ANTHROPIC_* even when ambient is set", () => {
    const env = buildWorkerEnv(CONN);
    expect(env.ANTHROPIC_MODEL).toBe("Worker");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
  });

  it("does not let provider extras replace the selected endpoint or credentials", () => {
    const env = buildWorkerEnv({
      ...API_KEY_CONN,
      extraEnv: { ANTHROPIC_BASE_URL: "https://wrong.example", ANTHROPIC_API_KEY: "wrong", ANTHROPIC_MODEL: "wrong" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe(API_KEY_CONN.baseUrl);
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY_CONN.apiKey);
    expect(env.ANTHROPIC_MODEL).toBe(API_KEY_CONN.model);
  });
});

describe("redactEnv", () => {
  it("masks TOKEN/KEY/SECRET/AUTH values", () => {
    const r = redactEnv({
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      PATH: "/usr/bin",
    });
    expect(r.ANTHROPIC_AUTH_TOKEN).toBe("(set, redacted)");
    expect(r.ANTHROPIC_API_KEY).toBe("(empty)");
    expect(r.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(r.PATH).toBe("/usr/bin");
  });
});

describe("resolveModel — default model is env/config-only, never a code literal", () => {
  const envKeys = ["CX_AGENT_MODEL", "CX_AGENT_CONFIG", "CX_AGENT_SETTINGS"];
  let dir: string;
  beforeEach(() => {
    dir = mkdtemp();
    for (const k of envKeys) delete process.env[k];
  });
  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string when nothing is configured (no code default)", () => {
    expect(resolveModel()).toBe("");
  });

  it("prefers CX_AGENT_MODEL over the config file pool", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ agent_defaults: { pool: "ConfigPool" } }));
    process.env.CX_AGENT_CONFIG = join(dir, "settings.json");
    process.env.CX_AGENT_MODEL = "EnvModel";
    expect(resolveModel()).toBe("EnvModel");
  });

  it("falls back to the config-file agent_defaults.pool when no env model", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ agent_defaults: { pool: "ConfigPool" } }));
    process.env.CX_AGENT_CONFIG = join(dir, "settings.json");
    expect(resolveModel()).toBe("ConfigPool");
  });

  function mkdtemp(): string {
    return mkdtempSync(join(tmpdir(), "cxagent-model-"));
  }
});

describe("loadSettings", () => {
  it("returns fallback defaults (empty pool) when settings.json missing", () => {
    const s = loadSettings("C:/nonexistent/path/settings.json");
    expect(s.pool).toBe("");
    expect(s.timeoutMs).toBe(FALLBACK_DEFAULTS.timeoutMs);
  });

  it("returns fallback defaults on malformed JSON", () => {
    const s = loadSettings("C:/Windows/System32/drivers/etc/hosts"); // exists, not JSON
    expect(s.pool).toBe("");
  });

  it("lets CX_AGENT_MODEL override a config-file pool", () => {
    const dir = mkdtempSync(join(tmpdir(), "cxagent-precedence-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ agent_defaults: { pool: "ConfigPool" } }));
    process.env.CX_AGENT_MODEL = "EnvModel";
    try { expect(loadSettings(path).pool).toBe("EnvModel"); }
    finally { delete process.env.CX_AGENT_MODEL; rmSync(dir, { recursive: true, force: true }); }
  });
});

// The old 50-turn default was the "small budget" that killed real jobs mid-task, and
// there was no cost cap or recovery knob at all. These are the defaults the worker
// actually runs under, so they are worth pinning.
describe("budget defaults", () => {
  it("gives a worker enough turns to finish a real task", () => {
    expect(FALLBACK_DEFAULTS.maxTurns).toBe(200);
  });

  it("ships with no cost cap — 0 means the SDK knob is not set at all", () => {
    expect(FALLBACK_DEFAULTS.maxBudgetUsd).toBe(0);
  });

  it("auto-continues a budget stop a couple of times by default", () => {
    expect(FALLBACK_DEFAULTS.autoContinue).toBe(2);
  });

  it("reads maxBudgetUsd / autoContinue from settings in both spellings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cxagent-budget-"));
    try {
      const camel = join(dir, "camel.json");
      writeFileSync(camel, JSON.stringify({ agent_defaults: { maxBudgetUsd: 3.5, autoContinue: 4 } }));
      expect(loadSettings(camel).maxBudgetUsd).toBe(3.5);
      expect(loadSettings(camel).autoContinue).toBe(4);

      const snake = join(dir, "snake.json");
      writeFileSync(snake, JSON.stringify({ agent_defaults: { max_budget_usd: 2, auto_continue: 1 } }));
      expect(loadSettings(snake).maxBudgetUsd).toBe(2);
      expect(loadSettings(snake).autoContinue).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The budget keys are settable straight from the environment (the .env path),
  // with env winning over the config file. This is how an operator tunes the
  // worker without editing JSON.
  it("reads the budget knobs from env and lets env win over the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cxagent-budget-env-"));
    try {
      const p = join(dir, "s.json");
      writeFileSync(p, JSON.stringify({ agent_defaults: { maxTurns: 5, timeoutMs: 100, maxBudgetUsd: 9, autoContinue: 9 } }));

      const prev = {
        CX_AGENT_MAX_TURNS: process.env.CX_AGENT_MAX_TURNS,
        CX_AGENT_TIMEOUT_MS: process.env.CX_AGENT_TIMEOUT_MS,
        CX_AGENT_MAX_BUDGET_USD: process.env.CX_AGENT_MAX_BUDGET_USD,
        CX_AGENT_AUTO_CONTINUE: process.env.CX_AGENT_AUTO_CONTINUE,
      };
      process.env.CX_AGENT_MAX_TURNS = "400";
      process.env.CX_AGENT_TIMEOUT_MS = "900000";
      process.env.CX_AGENT_MAX_BUDGET_USD = "5.5";
      process.env.CX_AGENT_AUTO_CONTINUE = "3";
      try {
        const s = loadSettings(p);
        expect(s.maxTurns).toBe(400);
        expect(s.timeoutMs).toBe(900000);
        expect(s.maxBudgetUsd).toBe(5.5);
        expect(s.autoContinue).toBe(3);
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a non-numeric budget env value and falls back to config/defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "cxagent-budget-env-bad-"));
    try {
      const p = join(dir, "s.json");
      writeFileSync(p, JSON.stringify({ agent_defaults: { maxTurns: 77 } }));
      const prev = process.env.CX_AGENT_MAX_TURNS;
      process.env.CX_AGENT_MAX_TURNS = "not-a-number";
      try {
        expect(loadSettings(p).maxTurns).toBe(77);
      } finally {
        if (prev === undefined) delete process.env.CX_AGENT_MAX_TURNS;
        else process.env.CX_AGENT_MAX_TURNS = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A runaway continuation loop is worse than an incomplete job, so the knob is clamped
  // rather than trusted.
  it("clamps autoContinue into [0, MAX_AUTO_CONTINUE] and disables it on junk input", () => {
    expect(clampAutoContinue(3)).toBe(3);
    expect(clampAutoContinue(3.9)).toBe(3);
    expect(clampAutoContinue(999)).toBe(MAX_AUTO_CONTINUE);
    expect(clampAutoContinue(0)).toBe(0);
    expect(clampAutoContinue(-1)).toBe(0);
    expect(clampAutoContinue(undefined)).toBe(0);
    expect(clampAutoContinue(Number.NaN)).toBe(0);
    expect(clampAutoContinue(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("clamps an out-of-range autoContinue coming from settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cxagent-budget-clamp-"));
    try {
      const p = join(dir, "s.json");
      writeFileSync(p, JSON.stringify({ agent_defaults: { autoContinue: 500 } }));
      expect(loadSettings(p).autoContinue).toBe(MAX_AUTO_CONTINUE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inheritSettings — worker isolation (B-01)", () => {
  it("defaults to false: workers run isolated from operator settings by default", () => {
    expect(FALLBACK_DEFAULTS.inheritSettings).toBe(false);
    expect(loadSettings("C:/nonexistent/path/settings.json").inheritSettings).toBe(false);
  });

  it("CX_AGENT_INHERIT_SETTINGS=1 opts in when no config file exists", () => {
    process.env.CX_AGENT_INHERIT_SETTINGS = "1";
    try {
      expect(loadSettings("C:/nonexistent/path/settings.json").inheritSettings).toBe(true);
    } finally {
      delete process.env.CX_AGENT_INHERIT_SETTINGS;
    }
  });

  it("config file agent_defaults.inheritSettings wins when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "cxagent-inherit-"));
    try {
      const p = join(dir, "settings.json");
      writeFileSync(p, JSON.stringify({ agent_defaults: { inheritSettings: true, pool: "Worker lvl" } }));
      expect(loadSettings(p).inheritSettings).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

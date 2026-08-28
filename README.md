# Claudex Agent

An MCP server that offloads long-running tasks from a main agent session to a worker model behind **any gateway you configure**, then **blocks until the work is done** and pushes the result back as a task notification.

cx-agent bridges any MCP client with any Anthropic-compatible gateway (LiteLLM, CLIProxyAPI, claude-code-router, or your own local router) so expensive work runs on cheaper models while the main session stays responsive. It uses the same `@anthropic-ai/claude-agent-sdk` engine as Claude Code itself — not a one-shot subprocess — so the worker gets a full resumable agent session with file tools, bash, and nested subagents.

**cx-agent has no built-in knowledge of any specific router product.** It is configured entirely through environment variables: point it at a gateway URL, give it a key and a model, and it runs. Nothing about your gateway is baked into the package.

## Why

Claude Code subagents are powerful but bill to your Anthropic account. cx-agent lets you:

- **Delegate to cheaper models** — any alias your gateway serves (`"Worker lvl"`) or a concrete model id (`"openai/mimo-v2.5-free"`)
- **Keep the main session responsive** — clients that support it (Claude Code, ZCode) auto-background the call at ~2 minutes and return the result as a push notification
- **Isolate credentials** — the worker's gateway token never touches your main session's OAuth
- **Resume and fork** — continue a completed job's conversation or branch it to a new session

## Requirements

- Node.js >= 18
- A reachable Anthropic-compatible Messages endpoint
- `CX_AGENT_BASE_URL`, `CX_AGENT_API_KEY`, and `CX_AGENT_MODEL`

That's the whole dependency story — no install paths, no Python, no specific router required, any platform.

## Quick start

```bash
CX_AGENT_BASE_URL=https://gateway.example.com \
CX_AGENT_API_KEY=sk-your-key \
CX_AGENT_AUTH_MODE=api-key \
CX_AGENT_MODEL=worker-model \
npx cx-agent
```

`api-key` selects Anthropic's `x-api-key` authentication. Bearer-token gateways can omit `CX_AGENT_AUTH_MODE`; `bearer` is the backward-compatible default. Model discovery is not required when `CX_AGENT_MODEL` is configured.

Or configure the server with environment variables in your MCP client — pick yours under [Install in your harness](#install-in-your-harness). Full variable reference in [Configuration](#configuration).

## Install (local development)

```bash
git clone <repo>
cd cx-agent
npm install
npm run build
```

## Install in your harness

cx-agent is a plain **stdio MCP server** — any MCP-capable client can run it. The universal recipe: launch `npx -y cx-agent` with the `CX_AGENT_*` environment variables set. Expand your client below.

> **Timeouts:** `cx_agent_run` **blocks** until the worker finishes — minutes to hours. cx-agent streams MCP progress notifications with a 10 s heartbeat so idle-based clients don't kill the call, but raise your client's tool timeout where it has one (noted per client).

<details>
<summary><strong>Claude Code</strong></summary>

CLI (user scope):

```bash
claude mcp add --scope user \
  --env CX_AGENT_BASE_URL=http://127.0.0.1:4000 \
  --env CX_AGENT_API_KEY=sk-your-key \
  --env CX_AGENT_MODEL="Worker lvl" \
  --transport stdio cx-agent -- npx -y cx-agent
```

Or JSON — `~/.claude.json` (user scope) or `.mcp.json` (project scope, shareable via git):

```json
{
  "mcpServers": {
    "cx-agent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      },
      "timeout": 14400000
    }
  }
}
```

Per-server `timeout` (ms) or `MCP_TOOL_TIMEOUT` covers long jobs; unset, the tool timeout defaults to ~28 h. Claude Code auto-backgrounds a long call at ~2 minutes — cx-agent's progress stream is built for exactly this.

</details>

<details>
<summary><strong>ZCode</strong></summary>

`~/.zcode/cli/config.json` (user scope) or `<repo>/.zcode/config.json` (workspace scope), under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "cx-agent": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "cx-agent"],
        "env": {
          "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
          "CX_AGENT_API_KEY": "sk-your-key",
          "CX_AGENT_MODEL": "Worker lvl"
        },
        "timeoutMs": 600000
      }
    }
  }
}
```

Long `cx_agent_run` calls auto-background at ~2 minutes and return as task notifications. (`~/.agents/mcp.json` → `mcpServers` is honored as a fallback location.)

</details>

<details>
<summary><strong>OpenAI Codex CLI</strong></summary>

`~/.codex/config.toml` (user) or `.codex/config.toml` (project):

```toml
[mcp_servers.cx-agent]
command = "npx"
args = ["-y", "cx-agent"]
tool_timeout_sec = 14400

[mcp_servers.cx-agent.env]
CX_AGENT_BASE_URL = "http://127.0.0.1:4000"
CX_AGENT_API_KEY = "sk-your-key"
CX_AGENT_MODEL = "Worker lvl"
```

`tool_timeout_sec` (4 h above) is optional — set it to cover your longest job.

</details>

<details>
<summary><strong>Cursor</strong></summary>

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global), or Cursor Settings → Features → MCP Servers → Add:

```json
{
  "mcpServers": {
    "cx-agent": {
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf</strong></summary>

`~/.codeium/windsurf/mcp_config.json`, or Windsurf Settings → Cascade → MCP Servers:

```json
{
  "mcpServers": {
    "cx-agent": {
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

The file supports `${env:VAR_NAME}` interpolation in `command`/`args`/`env` if you'd rather not hardcode the key.

</details>

<details>
<summary><strong>Cline</strong></summary>

CLI: edit `~/.cline/mcp.json`, or run `cline mcp` for an interactive wizard. VS Code extension: Cline panel → MCP Servers icon (top toolbar) → Configure tab → **Configure MCP Servers**:

```json
{
  "mcpServers": {
    "cx-agent": {
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

Workspace: `.vscode/mcp.json` (shareable via git). Global: Command Palette → **MCP: Open User Configuration**, or **MCP: Add Server** for a guided flow. Note the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "cx-agent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Antigravity CLI (Google — Gemini CLI's successor)</strong></summary>

Create a workspace-level `mcp_config.json` in your project root, or add the server through the Interactive MCP Manager (which also edits the global setup). Local stdio and remote servers share one `mcpServers` object:

```json
{
  "mcpServers": {
    "cx-agent": {
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Kilo Code</strong></summary>

**VS Code extension:** Settings → MCP Servers → Edit Project MCP (creates `.kilocode/mcp.json`) — standard `mcpServers` shape.

**Kilo CLI:** `kilo.json` in the project root (or `.kilo/kilo.json`), `~/.config/kilo/kilo.json` for all workspaces, under the top-level `mcp` key:

```json
{
  "mcp": {
    "cx-agent": {
      "type": "local",
      "command": ["npx", "-y", "cx-agent"],
      "enabled": true,
      "environment": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

Note the CLI field names: `environment` (not `env`) and `command` is an array.

</details>

<details>
<summary><strong>Kiro (IDE &amp; CLI)</strong></summary>

`.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (user) — same file for the IDE, the CLI, and Kiro Web:

```json
{
  "mcpServers": {
    "cx-agent": {
      "command": "npx",
      "args": ["-y", "cx-agent"],
      "env": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      },
      "disabled": false,
      "autoApprove": ["cx_agent_run", "cx_agent_reply", "cx_agent_interrupt"]
    }
  }
}
```

`autoApprove` matters in Kiro: without it every tool call waits for an interactive approval, which is painful for a blocking tool.

</details>

<details>
<summary><strong>opencode</strong></summary>

`opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cx-agent": {
      "type": "local",
      "command": ["npx", "-y", "cx-agent"],
      "enabled": true,
      "environment": {
        "CX_AGENT_BASE_URL": "http://127.0.0.1:4000",
        "CX_AGENT_API_KEY": "sk-your-key",
        "CX_AGENT_MODEL": "Worker lvl"
      }
    }
  }
}
```

Field names: `environment` (not `env`) and `command` is an array.

</details>

<details>
<summary><strong>Goose</strong></summary>

`~/.config/goose/config.yaml`, or `goose configure` → Extensions → Add Custom Extension (Command-line):

```yaml
extensions:
  cx-agent:
    cmd: npx
    args: ["-y", "cx-agent"]
    enabled: true
    type: stdio
    timeout: 14400
    envs:
      CX_AGENT_BASE_URL: "http://127.0.0.1:4000"
      CX_AGENT_API_KEY: "sk-your-key"
      CX_AGENT_MODEL: "Worker lvl"
```

</details>

<details>
<summary><strong>DeepSeek CLI</strong></summary>

The community terminal coding agent for DeepSeek models ([appleweiping/deepseek-cli](https://github.com/appleweiping/deepseek-cli)). Edit `~/.deepseek-cli/config.toml`:

```toml
[mcp_servers.cx-agent]
command = "npx"
args = ["-y", "cx-agent"]

[mcp_servers.cx-agent.env]
CX_AGENT_BASE_URL = "http://127.0.0.1:4000"
CX_AGENT_API_KEY = "sk-your-key"
CX_AGENT_MODEL = "Worker lvl"
```

</details>

Your harness not listed? cx-agent is a standard stdio MCP server: point your client at `npx -y cx-agent` (or `node <path-to-repo>/dist/index.js` from a local build) and pass the `CX_AGENT_*` env vars.

## Providers

One provider ships: the **gateway** provider — pure env, zero subprocess.

| Provider | id | How it discovers models | Requires |
|---|---|---|---|
| **gateway** | `gateway` (aliases: `auto`, `openai-compatible`) | optional `GET {baseUrl}/v1/models` or a static `CX_AGENT_MODELS` list | an Anthropic-compatible Messages endpoint |

Selection via `CX_AGENT_PROVIDER` (default `auto`): `auto`, `gateway`, and `openai-compatible` are synonyms. Any other value fails fast with a clear config error. The value `cx` is recognized **only to reject it with the v0.3 migration message** — the former built-in cx provider was removed (see [Migration](#migration-from-v02)).

Discovery strategies (`CX_AGENT_DISCOVERY`):

- `none` — no discovery request; the selected model is passed directly to the SDK. This is the default when `CX_AGENT_MODEL` or the tool's `model` argument is set.
- `static` — the comma-separated list in `CX_AGENT_MODELS`; no network. Implied when `CX_AGENT_MODELS` is set.
- `models-endpoint` — `GET {base}/v1/models` with the selected authentication mode. Results are cached for `CX_AGENT_DISCOVERY_TTL_MS` (default 60 seconds). This remains the fallback when neither a model nor a static catalog is configured.

A trailing `/v1` in `CX_AGENT_BASE_URL` is tolerated and stripped; give the gateway root.

## Configuration

One resolution order per key: **explicit argument → `CX_AGENT_*` env → legacy env alias → config file → built-in fallback.**

### Canonical environment variables

| Key | Purpose | Default |
|---|---|---|
| `CX_AGENT_PROVIDER` | `auto` \| `gateway` \| `openai-compatible` | `auto` |
| `CX_AGENT_BASE_URL` | gateway root URL | — (required) |
| `CX_AGENT_API_KEY` | endpoint credential | — |
| `CX_AGENT_AUTH_MODE` | `bearer` (`Authorization`) or `api-key` (`x-api-key`) | `bearer` |
| `CX_AGENT_MODEL` | default model alias | — (required; or `agent_defaults.pool` in the config file) |
| `CX_AGENT_MODELS` | comma-separated static catalog | — |
| `CX_AGENT_DISCOVERY` | `models-endpoint` \| `static` \| `none` | inferred (`static` with `CX_AGENT_MODELS`, otherwise `none` with `CX_AGENT_MODEL`) |
| `CX_AGENT_DISCOVERY_TTL_MS` | catalog cache lifetime | `60000` |
| `CX_AGENT_INHERIT_SETTINGS` | workers inherit operator settings (`1`/`true`) | `0` (isolated) |
| `CX_AGENT_CONFIG` | JSON config file path | — |
| `CX_AGENT_DATA_DIR` | job/transcript root | platform default (see below) |
| `CX_AGENT_SHELL_PATH` | worker shell; win32 only | `C:\Program Files\Git\bin\bash.exe` |
| `CX_AGENT_MAX_DEPTH` | recursion guard | `2` |
| `CX_AGENT_DEPTH` | current nesting depth (stamped by the runtime) | `0` |
| `CX_AGENT_MAX_TURNS` | per-round SDK turn cap | `200` |
| `CX_AGENT_TIMEOUT_MS` | job timeout in milliseconds | `14400000` |
| `CX_AGENT_MAX_BUDGET_USD` | per-round cost cap; `0` omits the SDK option | `0` |
| `CX_AGENT_AUTO_CONTINUE` | automatic same-session continuations after a budget stop | `2` |
| `CX_AGENT_THINKING` | default extended thinking: `adaptive` \| `disabled` \| a positive token budget | — (not sent) |
| `CX_AGENT_THINKING_DISPLAY` | `summarized` \| `omitted` | `summarized` when thinking is on |
| `CX_AGENT_EFFORT` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | — (not sent) |
| `CX_AGENT_FORWARD_SUBAGENT_TEXT` | forward nested-subagent output (incl. its reasoning) to the parent stream | `0` |

### Data directory

Job transcripts and `.meta.json` sidecars live under `CX_AGENT_DATA_DIR`, defaulting to a per-user platform location:

- **Windows** — `%LOCALAPPDATA%\cx-agent`
- **POSIX** — `$XDG_DATA_HOME/cx-agent` (or `~/.local/share/cx-agent`)

On first run after upgrade from a pre-0.2 in-package `data/agents/` layout, existing sidecars are copied once into the new location (idempotent via a sentinel file; originals are left in place as a safety net).

### Legacy aliases

| Canonical | Legacy alias(es) |
|---|---|
| `CX_AGENT_CONFIG` | `CX_AGENT_SETTINGS` |
| `CX_AGENT_SHELL_PATH` | `CLAUDE_CODE_GIT_BASH_PATH` |

### Config file

`CX_AGENT_CONFIG` (or legacy `CX_AGENT_SETTINGS`) is read as JSON. Keys are accepted at the top level **or** under `agent_defaults`. Snake-case siblings (`max_turns`, `git_bash_path`, …) are accepted alongside the camelCase names.

| Setting | Default |
|---|---|
| `pool` | — (none; env or per-call `model` supplies it) |
| `max_turns` | `200` |
| `timeout_ms` | `14,400,000` (4h) |
| `max_depth` | `2` |
| `git_bash_path` | (win32 default) |
| `inherit_settings` | `false` |
| `max_budget_usd` | `0` (no cap) |
| `auto_continue` | `2` |
| `thinking` | — (not sent) |
| `thinking_display` | `summarized` when thinking is on |
| `effort` | — (not sent) |
| `forward_subagent_text` | `false` |

## Reasoning

Workers do not request extended thinking unless you ask them to. `thinking` and `effort` are placed on
the SDK options **only** when configured, so an unconfigured job sends exactly what it always sent —
the pool may front a model or gateway that rejects those keys.

```jsonc
// per call
{ "prompt": "…", "thinking": "adaptive", "effort": "high" }
{ "prompt": "…", "thinking": 8000 }          // explicit thinking-token budget
{ "prompt": "…", "thinking": "disabled" }    // off
```

Three things worth knowing:

- **`thinking_display` defaults to `summarized`.** The API default is `omitted` on Opus 4.7+, which streams
  thinking blocks with *empty text* — you would get the cost of thinking and none of the transcript.
  Pass `thinking_display: "omitted"` deliberately if that is what you want.
- **Reasoning text lands in the JSONL transcript only.** It never rides back on the `cx_agent_run` envelope,
  and progress/ring events carry a size (`thinking · 412 chars`), never the words — that is the whole point
  of the slim envelope. Read it with `cx_agent_fetch(job_id, fields:["reasoning"])`, which returns
  `{config:{thinking,effort}, blocks, redacted, chars, truncated, text}` with `text` byte-capped and
  `chars` reporting the true total. Expect noticeably larger transcript files.
- **Nested subagents.** A worker's own subagents do not forward their output — reasoning included — to the
  parent stream unless `forward_subagent_text` is on. It is settings-only, not a per-call argument.

Reasoning config is **inherited** by `cx_agent_reply`, like cwd/model/agent/tools: a session that was
capturing reasoning keeps capturing it. Whether reasoning materializes at all still depends on the
gateway — it only appears if the gateway emits Anthropic-shaped `thinking` blocks.

## Tools

### `cx_agent_run`

The primary tool. **BLOCKS** until the worker finishes and returns a structured result.

```ts
cx_agent_run(args: {
  prompt:            string,        // required — verbatim task for the worker
  model?:            string,        // model alias or concrete model id (default from settings)
  pool?:             string,        // deprecated alias for `model`
  cwd?:              string,        // worker working directory
  agent?:            string,        // nested subagent name inside the worker (requires CX_AGENT_INHERIT_SETTINGS=1)
  allowed_tools?:    string[],      // when non-empty, restricts the worker's built-in tool menu to exactly these; empty/omitted = all tools
  disallowed_tools?: string[],      // extra tools to deny the worker (on top of the hazard denylist)
  max_turns?:        number,        // SDK maxTurns
  timeout_ms?:       number,        // server-side cap (default 4h)
  max_budget_usd?:   number,        // SDK maxBudgetUsd for one round
  auto_continue?:    number,        // budget-stop retries in the same session
  thinking?:         "adaptive" | "disabled" | number,   // omitted = not sent; number = thinking-token budget
  thinking_display?: "summarized" | "omitted",           // default "summarized"; ignored without `thinking`
  effort?:           "low"|"medium"|"high"|"xhigh"|"max",// omitted = not sent
}): {
  { job_id: string, result: string }                                                    // completed
  { job_id: string, status: "failed"|"interrupted"|"incomplete",
    error: { code: ErrorCode, message: string }, result?: string, truncated?: boolean } // otherwise
}
```

The slim envelope keeps inline context small: turns, transcript path, and timestamps stay on disk and are fetched via `cx_agent_fetch` only when needed. Partial output from `error_max_turns` (status `incomplete`) is returned as a bounded excerpt (max 2 KB) with `truncated: true`.

Before spawning, the worker runs the same pre-flight as `cx_agent_setup`: the gateway must answer discovery and the model must be in its catalog (when a catalog is available). A misconfigured gateway fails in milliseconds with a diagnostic, not minutes into a job.

At ~2 minutes, clients that support auto-backgrounding (Claude Code, ZCode) suspend the call. The session stays usable. The result arrives as a **task notification** — no second tool call, no polling.

### `cx_agent_reply`

Continue or fork a **completed** job's SDK session with a new prompt. **BLOCKS** like `cx_agent_run` — same push-on-completion path.

```ts
cx_agent_reply(args: {
  job_id:           string,        // required — the completed job to resume/fork
  prompt:           string,        // required — the next user turn, verbatim
  model?:           string,        // model alias or concrete model id
  cwd?:             string,        // working directory (default: the resumed job's cwd)
  agent?:           string,        // nested subagent name
  allowed_tools?:   string[],      // restrict the worker's tool menu
  disallowed_tools?: string[],     // extra tools to deny
  max_turns?:       number,        // SDK maxTurns for this turn
  timeout_ms?:      number,        // server-side cap (ms)
  thinking?:        "adaptive" | "disabled" | number,    // default: INHERITED from the resumed job
  thinking_display?: "summarized" | "omitted",
  effort?:          "low"|"medium"|"high"|"xhigh"|"max", // default: INHERITED from the resumed job
  fork?:            boolean,       // true → new session id (original untouched); false (default) → continues the resumed session
})
```

Rejects with `SESSION_BUSY` if the job is still running and `SESSION_NOT_FOUND` if the job or its session_id is unknown. The job stays resumable after `cx_agent_interrupt` — its session_id is retained.

### `cx_agent_check`

Ring-buffered event window for a **known** job_id. Returns `{ status, events[], nextCursor, terminal }`. **NOT for waiting on completion** — the buffer is gone once a settled job's live record detaches (returns terminal status with `events:[]`). Use for resumed/external jobs the main agent already has an id for.

```ts
cx_agent_check(args: {
  job_id:       string,   // the job to inspect
  since_cursor?: number,  // return events with seq > this cursor (default 0)
})
```

### `cx_agent_fetch`

Read selected persisted fields for a job from its `.meta.json` sidecar (or JSONL transcript fallback). Use after `cx_agent_run` returns if you need fields the slim envelope omits.

```ts
cx_agent_fetch(args: {
  job_id: string,
  fields?: ("status"|"result"|"turns"|"pool_resolved"|"transcript_path"|"error"|"started_at"|"ended_at"
           |"cx_agent_version"|"usage"|"session_id"|"files_changed"|"resumable"|"resumed_from"
           |"continuations"|"cwd"|"agent"|"budget"|"reasoning")[]
})
```

If `fields` is omitted, returns only `status` + `error`. `result` returns the full untruncated text (`null` when never recorded — distinct from an empty result). `files_changed` returns the sorted union of file paths the worker touched. `session_id` returns the SDK resume handle. The persisted field names (`pool`, `pool_resolved`) are historical and intentionally unchanged.

`reasoning` is the one deliberately large field, and the only one read from the JSONL rather than the sidecar. It returns `{config:{thinking,effort}, blocks, redacted, chars, truncated, text}` — `text` byte-capped at 8 KB, `chars` the true total — and is empty unless the job ran with `thinking` set. It is excluded from `cx_agent_session get`'s full-sidecar view for that reason; request it explicitly.

### `cx_agent_interrupt`

Resumable kill of a running job's process tree and resolves the pending `cx_agent_run` call as `status: "interrupted"`. The job stays **resumable** via `cx_agent_reply` (session_id is retained).

For a **terminal** (non-resumable) stop, use `cx_agent_session` with `action: "cancel"`.

### `cx_agent_session`

Manager over job records: list, get, cancel, and clean.

```ts
cx_agent_session(args: {
  action:        "list" | "get" | "cancel" | "clean",
  job_id?:       string,                                    // required for get/cancel
  statuses?:     ("completed"|"failed"|"interrupted"|"incomplete")[],  // clean: filter by terminal status
  older_than_ms?: number,                                   // clean: only remove jobs older than this
  dry_run?:      boolean,                                   // clean: preview without deleting
})
```

- **list** — one-line-per-job from on-disk sidecars (same as `cx_agent_list`)
- **get** — full meta for a job_id (all fetch fields)
- **cancel** — terminal stop of a live job (**not resumable** — prefer `cx_agent_interrupt` for resumable)
- **clean** — delete terminal job files; accepts `statuses` / `older_than_ms` filters; `dry_run` previews without deleting

### `cx_agent_setup`

Endpoint configuration check. Returns `{ ready, model, models, diagnostics }`. With discovery disabled, `ready` confirms that the URL and model are configured; the first worker request remains the authoritative connectivity check. With static or endpoint discovery, the model is also validated against the catalog. Takes no input.

### `cx_agent_list`

Operator convenience: one-line-per-job from on-disk sidecars. **Not for waiting on running jobs.** Most-recent first.

## Structured Errors

Every non-completed result carries a typed error envelope:

```ts
{ code: ErrorCode, message: string }
```

Error codes: `INVALID_ARGUMENT`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `PERMISSION_REQUEST_NOT_FOUND`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `TIMEOUT`, `CANCELLED`, `INTERRUPTED`, `INCOMPLETE`, `INTERNAL`.

The `isError: true` flag is also set for MCP clients that key on it; `error.code` is authoritative.

## Credential Isolation

The worker runs with a dedicated environment built from the resolved provider connection. Bearer mode sets only `ANTHROPIC_AUTH_TOKEN`; API-key mode sets only `ANTHROPIC_API_KEY`. Both set `ANTHROPIC_BASE_URL` and the selected model aliases. Ambient Anthropic credentials are never copied, and provider extras cannot replace the selected URL, credential, or model.

## Worker Isolation

The worker runs non-interactively under `bypassPermissions`. Three layers of isolation:

1. **Settings isolation (default)** — workers spawn with `settingSources: []`: your MCP servers, hooks, and settings files do **not** load inside delegated sessions. No operator hook fires in a worker, no MCP server spins up per job. Opt back in with `CX_AGENT_INHERIT_SETTINGS=1` (needed if workers must use user-level agents/skills, e.g. the `agent` argument).

2. **Hazard tool denylist** — tools that would stall a blocking session, create operator-session side effects, or self-delegate are always denied: interactive/plan/worktree/scheduling/notification tools plus all eight `cx_agent_*` tools in bare and MCP-qualified form.

3. **Recursion guard** — a `CX_AGENT_DEPTH` counter stamped into the worker env at each nesting level. If the incoming depth is ≥ `maxDepth` (default: 2), the worker refuses to spawn before doing any work. This prevents unbounded delegation chains. Override via `agent_defaults.maxDepth` in your config file.

**Trust model:** this is a privileged local code-execution service. Anyone who can reach the MCP server can spawn workers that run with `bypassPermissions` in the configured `cwd`. Expose it only to your own MCP clients.

## Job Metadata

Every job writes a `.meta.json` sidecar with:

```json
{
  "job_id": "20260808T152738-abc123",
  "status": "completed",
  "pool": "Worker lvl",
  "pool_resolved": [],
  "cwd": "D:/AI/my-project",
  "started_at": "2026-08-08T15:27:38.000Z",
  "ended_at": "2026-08-08T15:29:01.000Z",
  "turns": 4,
  "error": null,
  "result": "the full assistant output text",
  "cx_agent_version": "0.3.0",
  "session_id": "abc123...",
  "usage": { "input_tokens": 1234, "output_tokens": 567, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 },
  "files_changed": ["index.ts", "README.md"],
  "thinking": { "type": "adaptive", "display": "summarized" },
  "effort": "high"
}
```

The `cx_agent_version` field records which cx-agent build produced the job. `session_id` is the SDK resume handle for `cx_agent_reply`. `files_changed` is the sorted union of file paths the worker touched. `thinking` and `effort` record the reasoning config the job ran under (`null` when none was sent); they are what `cx_agent_reply` inherits. Reasoning **text** is deliberately absent here — the sidecar is parsed for every job by `cx_agent_list`, so it stays small. The persisted field names (`pool`, `pool_resolved`) are stable and intentionally unchanged across versions.

## Transcript Format

Each job writes an append-only JSONL transcript to `<dataDir>/agents/<job_id>.jsonl`:

```jsonl
{"ts":"2026-08-08T15:27:38.000Z","job_id":"...","seq":1,"kind":"system","payload":{...}}
{"ts":"...","seq":2,"kind":"assistant","payload":{...}}
{"ts":"...","seq":3,"kind":"tool_use","payload":{...}}
```

Kind values: `system | assistant | user | tool_use | tool_result | result | error | progress`.

Payloads are the whole SDK message, so an `assistant` record carries its `thinking` / `redacted_thinking`
blocks verbatim, signatures included. This is the only place reasoning text is stored, and it is what
`cx_agent_fetch fields:["reasoning"]` reads. Signatures are never redacted — stripping them would break
any future replay of the message back to the API.

## Architecture

```
Main harness session (operator credentials — never copied into the worker)
  └─[stdio MCP]→ cx-agent server (Node/TypeScript)
        ├─ resolveProvider() → ModelProvider (gateway: pure env, zero subprocess)
        │     Connection { baseUrl, apiKey, authMode, model, extraEnv? }
        ├─ query() from @anthropic-ai/claude-agent-sdk
        │     runtime/claude-sdk.ts maps Connection → ANTHROPIC_* + CLAUDE_CODE_* env
        │     (the only module that knows Anthropic/Claude-Code env names)
        ├─ streams SDK messages → MCP progress notifications (strictly increasing)
        ├─ writes <dataDir>/agents/<job_id>.jsonl transcript + .meta.json sidecar
        ├─ enforces recursion guard (maxDepth, default 2)
        ├─ spawns workers with settingSources: [] (opt-in inheritance)
        ├─ denies hazard tools to the worker
        └─ BLOCKS until terminal → returns structured result
              ↓ at ~2 min, supporting harnesses auto-background the call;
                result arrives as a task notification (no polling)
```

The provider/runtime split is deliberate: `ModelProvider` knows where models come from and nothing about Anthropic; `AgentRuntime` knows the Anthropic-shaped env and nothing about gateways. `Connection` is the whole contract between them.

## Migration from v0.2

The built-in `cx` provider was **removed** in v0.3 — cx-agent no longer knows about cx (or any specific router). If you configured `CX_AGENT_CX_ROOT`, `CX_AGENT_ROUTER_PORT/HOST`, or `CX_AGENT_AUTH_TOKEN`, switch to the generic gateway variables; cx's router speaks both shapes cx-agent needs:

| v0.2 | v0.3 |
|---|---|
| `CX_AGENT_CX_ROOT=C:\CLI\cx` | *(deleted — no equivalent needed)* |
| `CX_AGENT_ROUTER_HOST` + `CX_AGENT_ROUTER_PORT` (default 4000) | `CX_AGENT_BASE_URL=http://127.0.0.1:4000` |
| `CX_AGENT_AUTH_TOKEN=sk-cx-local` | `CX_AGENT_API_KEY=sk-cx-local` |
| (pool validation via cx's Python) | optional `CX_AGENT_MODELS=Worker lvl,Opus lvl` or `CX_AGENT_DISCOVERY=models-endpoint` |
| workers inherit your settings | workers isolated by default; set `CX_AGENT_INHERIT_SETTINGS=1` to keep v0.2 behavior |

cx-agent does not start or manage an endpoint process. With the default discovery-free configuration, connectivity errors come from the worker request; enable discovery when preflight catalog validation is useful.

## Cross-platform

- **Process-tree kill** — Windows uses `taskkill /T /F`; POSIX spawns the worker `detached: true` so it owns a process group, then `kill(-pid, SIGTERM)` escalating to `SIGKILL` after a grace window.
- **Shell path** — `CX_AGENT_SHELL_PATH` / `CLAUDE_CODE_GIT_BASH_PATH` is meaningful only on win32; on POSIX the key is omitted entirely rather than set to a bogus default.

CI runs the complete verification pipeline on Windows x64, Ubuntu x64, Ubuntu ARM64, and macOS. GitHub's standard `ubuntu-24.04-arm` runner requires a public repository or an account with that runner available.

## Development

```bash
npm test          # run vitest suite (hermetic — no live model calls, no network)
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/index.js
npm run smoke     # initialize the built MCP server and list its tools over stdio
npm run verify    # typecheck, tests, build, and packaged MCP smoke test
npm run smoke:live # make one minimal request against the configured endpoint
```

`smoke:live` requires the three core variables in its process environment and may consume provider credits. It restricts the worker tool menu and removes its temporary transcript directory after the check.

## License

Apache-2.0 — see [LICENSE](LICENSE).

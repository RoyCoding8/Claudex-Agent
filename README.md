<div align="center">

<img src="assets/banner.svg" alt="cx-agent delegation bridge for MCP" width="720">

<p>
  <em>Delegate work to Claude, Codex, or Pi with your own model gateway.<br>
  Start a background job, keep working, and collect its result when ready.</em>
</p>

<p>
  <a href="https://m8ven.ai/mcp/roycoding8-claudex-agent-1wg602"><img src="https://m8ven.ai/badge/mcp/roycoding8-claudex-agent-1wg602" alt="M8ven Score"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="Apache-2.0 license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-5FA04E?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node >= 22.19">
  <img src="https://img.shields.io/badge/MCP-stdio%20server-1F2937?style=flat-square" alt="MCP stdio server">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-64748B?style=flat-square" alt="Windows, macOS, Linux">
</p>

<p>
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#install-in-your-harness"><b>Install</b></a> &nbsp;·&nbsp;
  <a href="#configuration"><b>Configuration</b></a> &nbsp;·&nbsp;
  <a href="#tools"><b>Tools</b></a> &nbsp;·&nbsp;
  <a href="#architecture"><b>Architecture</b></a> &nbsp;·&nbsp;
  <a href="#migration-from-v02"><b>Migration</b></a>
</p>

</div>

---

cx-agent lets any MCP client delegate to a worker with an independently selected engine and model. Your main agent can use OpenAI while a worker uses another provider through your gateway. Claude uses the Claude Agent SDK. Codex and Pi use their published TypeScript SDKs.

Set `background:true` on a run or reply to return immediately. `cx_agent_wait` collects the result with a bounded wait. The MCP server owns the worker while its process remains alive. Existing calls without `background:true` continue to block.

`cx_agent_group` runs named tasks together, starts dependent tasks automatically, and returns completion events through one `wait_any` call. The default stdio connection cannot wake the parent model. Setup reports this under `completion_delivery` instead of implying that a notification resumes the parent.

<details>
<summary><strong>Table of contents</strong></summary>

- [Why](#why)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Install (local development)](#install-local-development)
- [Install in your harness](#install-in-your-harness)
- [Providers](#providers)
- [Configuration](#configuration)
- [Reasoning](#reasoning)
- [Tools](#tools)
- [Structured Errors](#structured-errors)
- [Credential Isolation](#credential-isolation)
- [Worker Isolation](#worker-isolation)
- [Job Metadata](#job-metadata)
- [Transcript Format](#transcript-format)
- [Architecture](#architecture)
- [Migration from v0.2](#migration-from-v02)
- [Cross-platform](#cross-platform)
- [Development](#development)
- [License](#license)

</details>

## Why

- Select the worker engine and model independently of the main agent.
- Delegate in the background without depending on client auto-backgrounding.
- Keep worker gateway credentials separate from the main session.
- Inspect transcripts and resume supported native sessions.

## Requirements

- Node.js >= 22.19.0
- A gateway exposing the selected engine protocol. Claude requires Anthropic Messages, Codex requires OpenAI Responses, and Pi uses OpenAI Chat Completions by default.
- `CX_AGENT_BASE_URL`, `CX_AGENT_API_KEY`, and `CX_AGENT_MODEL`

The default Claude engine is bundled through its SDK. The Codex and Pi SDKs are package dependencies.

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
git clone https://github.com/RoyCoding8/Claudex-Agent.git
cd Claudex-Agent
npm install
npm run build
```

## Install in your harness

cx-agent is a plain **stdio MCP server** — any MCP-capable client can run it. The universal recipe: launch `npx -y cx-agent` with the `CX_AGENT_*` environment variables set. Expand your client below.

> Set `background:true` to avoid a long tool call. Use `cx_agent_wait` to collect completion. Blocking calls still emit progress heartbeats, but client timeout and automatic backgrounding behavior depend on the client.

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

Use `background:true` for long jobs and collect the result with `cx_agent_wait`. If you use blocking calls, configure the client tool timeout to cover the job.

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

Use `background:true` and `cx_agent_wait` for a request that returns without waiting for the worker.

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

## Worker engines

| Engine | Execution | Gateway protocol | Native sessions |
|---|---|---|---|
| `claude` | Bundled Claude Agent SDK | Anthropic Messages | Resume and fork |
| `codex` | Codex TypeScript SDK | OpenAI Responses | Resume |
| `pi` | Pi TypeScript SDK | OpenAI Chat Completions by default | Resume, fork, and native compaction |

Pass `engine` per run or set `CX_AGENT_ENGINE`. `cx_agent_setup` reports the adapter capabilities. The main agent's provider does not constrain this choice. Each worker still needs a model accepted by its configured endpoint. The current Codex SDK does not expose native fork or manual compaction, so those operations return an unsupported-operation error. Codex and Pi use the explicit gateway credential rather than your main agent's OAuth login.

Codex and Pi reject Claude-specific tool, thinking, and budget options. Codex accepts `effort`; Pi currently rejects it. Their wall-clock limit remains available through `timeout_ms`. Token usage and changed-file accounting currently come from the Claude SDK path. Pi can select `openai-responses` or `anthropic-messages` through `CX_AGENT_PI_API`. Codex requires bearer authentication. Pi supports API-key authentication with Anthropic Messages and bearer authentication with all three protocols.

### Codex host policy limitations

In a Windows Codex-hosted acceptance run, the Codex SDK completed inference and returned a report, but its `exec_command` call to read `src/errors.ts` with PowerShell `Get-Content` was rejected with `blocked by policy`. The report explicitly left the file contents unverified. Claude and Pi workers read the same file successfully. The policy source remains unresolved; this observation is specific to that host configuration.

A job's `completed` status means its SDK turn finished successfully. Check the report and `output.unresolved_questions` before treating repository inspection as complete. `cx_agent_setup` with `verify:true` verifies the model's streaming protocol; it does not exercise file access or sandbox permissions. If a read is blocked, inspect the result and transcript with `cx_agent_fetch` and check the host's tool and sandbox policy before relying on the worker's findings.

### Context and automatic compaction

`cx_agent_run` and `cx_agent_reply` accept a `context` object. For example:

```json
{
  "engine": "pi",
  "model": "your-custom-model",
  "prompt": "Implement the requested change and verify it.",
  "background": true,
  "context": {
    "window_tokens": 64000,
    "max_output_tokens": 4096,
    "compaction": {
      "enabled": true,
      "trigger_tokens": 48000,
      "keep_recent_tokens": 12000
    }
  }
}
```

The SDKs expose different controls:

| Control | Claude | Codex | Pi |
|---|---|---|---|
| Context capacity (`window_tokens`) | Yes | Yes | Yes |
| Response limit (`max_output_tokens`) | Yes | — | Yes |
| Enable or disable automatic compaction | Yes | — | Yes |
| Automatic compaction threshold (`trigger_tokens`) | — | Yes | Yes |
| Recent history retained (`keep_recent_tokens`) | — | — | Yes |

Claude controls map to its documented [environment variables](https://code.claude.com/docs/en/env-vars). Codex capacity and threshold map to [`model_context_window` and `model_auto_compact_token_limit`](https://learn.chatgpt.com/docs/config-file/config-reference) in SDK configuration.

Unsupported controls return `UNSUPPORTED_OPERATION`; inconsistent token budgets return `INVALID_ARGUMENT`. Context capacity describes the actual model or gateway capacity. Setting a larger value cannot increase the endpoint's limit.

Pi defaults to a 128,000-token context capacity, an 8,192-token response limit, automatic compaction above 111,616 tokens, and about 20,000 tokens of retained recent history. Smaller custom capacities derive smaller defaults for output, reserved space, and retained history. Claude and Codex retain their SDK/model defaults when controls are omitted; this server does not report an invented numeric default for them. All three engines support native automatic compaction, which can still fail if the model request fails.

Replies and forks inherit the persisted context policy, including nested compaction settings. Reply overrides merge into that policy; if you shrink the capacity, supply compatible output and compaction limits too. `cx_agent_fetch` with `fields: ["context"]` returns the configured policy, and `cx_agent_setup` reports supported controls under `capabilities.context`. These are configured limits, not live token occupancy.

Manual compaction is separately available for Pi through `cx_agent_compact`. Pi uses native retention rules; a session with too little history returns "Nothing to compact".

Other toolkits, including Antigravity, need an adapter for a documented programmatic API. They are not implemented in this release.

## Providers

One gateway provider supplies endpoint configuration and optional model discovery. Engine adapters choose the wire protocol.

| Provider | id | How it discovers models | Requires |
|---|---|---|---|
| **gateway** | `gateway` (aliases: `auto`, `openai-compatible`) | optional `GET {baseUrl}/v1/models` or a static `CX_AGENT_MODELS` list | an endpoint compatible with the selected engine |

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
| `CX_AGENT_ENGINE` | `claude`, `codex`, or `pi` | `claude` |
| `CX_AGENT_CODEX_PATH` | optional SDK executable override | SDK bundled executable |
| `CX_AGENT_PI_API` | Pi gateway API, see engine support | `openai-completions` |
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

| Tool | Behavior |
|---|---|
| `cx_agent_run` | Starts a worker. With `background:true`, returns `{job_id,status:"running"}` immediately. Otherwise waits for completion. |
| `cx_agent_wait` | Waits up to `timeout_ms` for a result. Default 1000 ms, maximum 30000 ms. Zero checks immediately. |
| `cx_agent_group` | Creates a group, reports compact status, or waits for terminal events with `action:"wait_any"`. Supports named dependencies and `max_parallel`. |
| `cx_agent_reply` | Continues a resumable terminal job with a new prompt and job ID. Accepts `background:true`. Inherits the source engine, model, working directory, tools, and reasoning configuration. |
| `cx_agent_compact` | Compacts a resumable Pi session through its SDK. Accepts optional `instructions`, `background`, and `timeout_ms`. |
| `cx_agent_check` | Returns recent events after `since_cursor`, status, and progress with last activity, elapsed time, and current step. |
| `cx_agent_fetch` | Reads selected persisted fields. Omitting `fields` returns status and error. |
| `cx_agent_interrupt` | Stops a running worker. A recorded native session remains available for reply. |
| `cx_agent_session` | Lists, gets, cancels, or cleans jobs. Terminal cancel clears resumability. Clean supports `statuses`, `older_than_ms`, and `dry_run`. |
| `cx_agent_setup` | Separates configuration, model availability, protocol verification, and completion delivery. `verify:true` sends a small paid request for the exact model. |
| `cx_agent_list` | Lists recent persisted jobs. |

Start work with `cx_agent_run`:

```json
{
  "prompt": "Inspect the parser and report malformed input handling.",
  "engine": "codex",
  "model": "worker-model",
  "background": true
}
```

Collect the result with `cx_agent_wait`:

```json
{ "job_id": "the-returned-job-id", "timeout_ms": 1000 }
```

A completed job returns `{job_id,result,output}`. A failed, interrupted, or incomplete job returns `{job_id,status,error,resumable,output}` with an optional bounded result excerpt. `output` contains source revision and dirty state, outcome, artifact references, and unresolved questions. Questions are `null` unless the final text is JSON with an `unresolved_questions` string array. A wait that expires returns `{job_id,status:"running"}`. Cancelling a wait or the original background request does not stop the worker. To stop work, call `cx_agent_interrupt` or `cx_agent_session` with `action:"cancel"`.

Setup returns `ready:false` until a successful `verify:true` probe. Disabled or static discovery reports model availability as unknown. The probe requests a streaming response, capped at 512 output tokens, 15 seconds, and 64 KiB. It requires assistant text and a successful terminal event. This verifies the wire protocol, not SDK tools, resume, or future service availability. Model IDs are passed unchanged; an abbreviated alias is not automatically expanded.

### Groups and dependencies

```json
{
  "action": "create",
  "name": "parser-review",
  "max_parallel": 3,
  "tasks": [
    { "name": "inputs", "engine": "pi", "model": "worker-model", "access": { "mode": "read-only" }, "prompt": "Review parser input validation." },
    { "name": "errors", "engine": "pi", "model": "worker-model", "access": { "mode": "read-only" }, "prompt": "Review parser error handling." },
    { "name": "summary", "depends_on": ["inputs", "errors"], "engine": "pi", "model": "worker-model", "access": { "mode": "read-only" }, "prompt": "Synthesize the prerequisite findings." }
  ]
}
```

Call `cx_agent_group` with `action:"wait_any"`, the returned `group_id`, `after_cursor:0`, and `timeout_ms:30000`. Pass each returned `next_cursor` on the next wait. Events are retained and replayable, with at most 16 per response. A timeout or cancelled wait does not cancel work. Failed, interrupted, or incomplete prerequisites block their dependents. Dependency context includes up to 2048 characters per result and 8192 characters overall; full reports remain available through each job ID.

The whole plan is validated before the first job starts. Group snapshots distinguish queued, running, completed, failed, and blocked tasks. Completed records survive restart. Inputs remain in memory; unfinished tasks are blocked after restart and are never silently rerun. Running workers require the server process to remain alive.

Host integrations can supply `createServer({enqueueParentContinuation})` to enqueue a parent turn after a standalone background job settles. Foreground calls and group investigators do not invoke this callback. The callback receives a stable event ID, job ID, status, short result, resume flag, transcript path, and output metadata. Delivery is attempted once in the running process. A host must implement the continuation itself; the default stdio server and group responses report `parent_resume:false` and provide bounded waits.

If the store cannot write terminal metadata, it reports failure and blocks new jobs and resumes for that server process. Cancellation reports an error when its final metadata cannot be saved. Repair storage and reconcile uncertain job records before restarting. Records still marked `running` after restart cannot be resumed automatically.

To continue a resumable job, call `cx_agent_reply`:

```json
{ "job_id": "the-returned-job-id", "prompt": "Implement the proposed fix.", "background": true }
```

Replies require the original engine. Within one server process, a second continuation of the same engine session receives `SESSION_BUSY` while another continuation is running. Engine-specific options are rejected when the selected engine cannot enforce them.

Claude accepts `agent`, `allowed_tools`, `disallowed_tools`, `max_turns`, `max_budget_usd`, `auto_continue`, `thinking`, `thinking_display`, and `effort`. `timeout_ms` limits a whole job. Claude budget stops return `incomplete` and can resume through reply. Budget allowances start fresh on a reply.

Fetch omitted details only when needed. Supported fields include `engine`, `session_id`, `files_changed`, `usage`, `turns`, `transcript_path`, `resumable`, `continuations`, and `budget`. `fields:["result"]` returns the full stored result. `fields:["reasoning"]` reads captured thinking blocks from the JSONL transcript and bounds the returned text. The complete schemas are available through MCP `tools/list`.

Background jobs require the MCP server process to stay alive. Completed records survive a restart. Running jobs are not automatically restarted or recovered after a server crash.

## Structured Errors

Every non-completed result carries a typed error envelope:

```ts
{ code: ErrorCode, message: string }
```

Error codes: `INVALID_ARGUMENT`, `UNSUPPORTED_OPERATION`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `PERMISSION_REQUEST_NOT_FOUND`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `TIMEOUT`, `CANCELLED`, `INTERRUPTED`, `INCOMPLETE`, `INTERNAL`.

The `isError: true` flag is also set for MCP clients that key on it; `error.code` is authoritative.

## Credential Isolation

The Claude worker runs with a dedicated environment built from the resolved provider connection. Bearer mode sets only `ANTHROPIC_AUTH_TOKEN`; API-key mode sets only `ANTHROPIC_API_KEY`. Both set `ANTHROPIC_BASE_URL` and the selected model aliases. Ambient Anthropic credentials are never copied, and provider extras cannot replace the selected URL, credential, or model. Codex uses a private `CODEX_HOME` and an explicit SDK environment. Pi uses in-memory authentication and private session storage.

## Worker Isolation

By default, Claude workers run non-interactively under `bypassPermissions`. Its isolation controls are:

1. **Settings isolation (default)** — workers spawn with `settingSources: []`: your MCP servers, hooks, and settings files do **not** load inside delegated sessions. No operator hook fires in a worker, no MCP server spins up per job. Opt back in with `CX_AGENT_INHERIT_SETTINGS=1` (needed if workers must use user-level agents/skills, e.g. the `agent` argument).

2. **Hazard tool denylist** — tools that would stall a blocking session, create operator-session side effects, or self-delegate are always denied: interactive/plan/worktree/scheduling/notification tools plus all `cx_agent_*` tools in bare and MCP-qualified form.

3. **Recursion guard** — a `CX_AGENT_DEPTH` counter stamped into the worker env at each nesting level. If the incoming depth is ≥ `maxDepth` (default: 2), the worker refuses to spawn before doing any work. This prevents unbounded delegation chains. Override via `agent_defaults.maxDepth` in your config file.

This is a privileged local code-execution service. Workers can modify the selected working directory and run commands. Settings isolation does not provide an operating-system sandbox.

Set `access:{"mode":"read-only"}` for inspection. Claude exposes only `Read`, `Glob`, and `Grep`, disables inherited settings, and denies other permission requests. Pi exposes only its `read` tool. Codex requests its native read-only sandbox and disables ambient MCP servers. Claude and Pi enforce tool restrictions, not an OS sandbox, and may still read paths outside the checkout. A reply inherits the access mode unless explicitly overridden.

An optional `report_path` in read-only mode lets the parent create one assigned report from the final result. The worker receives no write tool. The destination must be a new file in existing directories, outside job storage and without symlinks or junctions. Existing files are never overwritten, and a reply requires a new explicit report path. Use `artifact_paths` to request structured references to other caller-selected files; hashes are returned for files up to 8 MiB. File references do not establish that an artifact is correct or that a worker authored it.

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

Claude payloads are the whole SDK message, so an `assistant` record carries its `thinking` / `redacted_thinking`
blocks verbatim, signatures included. This is the only place reasoning text is stored, and it is what
`cx_agent_fetch fields:["reasoning"]` reads. Signatures are never redacted — stripping them would break
any future replay of the message back to the API. Codex and Pi transcripts contain normalized session, assistant, and tool events.

## Architecture

```text
MCP client
  -> tool schemas and handlers
  -> SessionStore owns jobs, waits, interruption, and session locks
  -> runWorker handles shared execution and terminal persistence
     -> runtime/claude.ts: Claude Agent SDK and continuation loop
     -> runtime/codex.ts: Codex SDK
     -> runtime/pi.ts: Pi SDK
  -> JSONL transcripts and job metadata
```

Engine choice is separate from gateway choice. The gateway supplies endpoint credentials and model names. Each engine adapter owns its native invocation and returns one shared terminal result type. The worker owns deadlines, heartbeat, interruption precedence, and terminal persistence. The job store owns request-independent execution and session locks. Context validation, defaults, and supported controls live in `runtime/context-policy.ts`.

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

- **Claude process cleanup** — Windows uses `taskkill /T /F`; POSIX spawns the worker `detached: true` so it owns a process group, then `kill(-pid, SIGTERM)` escalating to `SIGKILL` after a grace window. Codex and Pi use their SDK cancellation mechanisms.
- **Shell path** — `CX_AGENT_SHELL_PATH` / `CLAUDE_CODE_GIT_BASH_PATH` is meaningful only on win32; on POSIX the key is omitted entirely rather than set to a bogus default.

CI runs the complete verification pipeline on Windows x64, Ubuntu x64, Ubuntu ARM64, and macOS. GitHub's standard `ubuntu-24.04-arm` runner requires a public repository or an account with that runner available.

## Development

```bash
npm test          # run Vitest with local fixtures and no external model calls
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/index.js
npm run smoke     # initialize the built MCP server and list its tools over stdio
npm run verify    # typecheck, tests, build, MCP and SDK smoke tests
npm run smoke:engines # exercise Codex and Pi SDKs against a local test gateway
npm run smoke:live # make one minimal request against the configured endpoint
```

`smoke:engines` exercises the installed SDK dependencies. It uses a local test endpoint and makes no paid model requests. Pass one engine to test it alone, such as `npm run smoke:engines -- codex`.

`smoke:live` requires the three core variables in its process environment and may consume provider credits. It restricts the worker tool menu and removes its temporary transcript directory after the check.

## License

Apache-2.0 — see [LICENSE](LICENSE).

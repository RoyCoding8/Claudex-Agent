import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "../providers/types.js";
import { jobStoreDir } from "../paths.js";
import { configValue } from "../config.js";
import type { EngineInput, EngineResult, EngineRunContext } from "./engine.js";
import { buildRuntimeEnv } from "./engine.js";
import { InterruptHandle } from "../interrupt.js";
import { resolveContextPolicy, type ContextPolicy } from "./context-policy.js";

type CodexClient = Pick<Codex, "startThread" | "resumeThread">;
type CodexFactory = (options: CodexOptions) => CodexClient;

export function buildCodexOptions(
  connection: Connection,
  options: { home?: string; sourceEnv?: NodeJS.ProcessEnv; codexPathOverride?: string; context?: ContextPolicy } = {},
): CodexOptions {
  if (connection.authMode === "api-key") {
    throw new Error("Codex SDK custom gateways require bearer-token authentication; this connection uses api-key auth.");
  }
  const home = options.home ?? join(jobStoreDir(), "codex-home");
  mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(buildRuntimeEnv(options.sourceEnv)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.CODEX_HOME = home;
  env.CX_AGENT_GATEWAY_KEY = connection.apiKey;
  const policy = resolveContextPolicy("codex", options.context);
  return {
    codexPathOverride: options.codexPathOverride ?? configValue("CX_AGENT_CODEX_PATH"),
    config: {
      model_provider: "cx_agent",
      ...(policy?.window_tokens !== undefined ? { model_context_window: policy.window_tokens } : {}),
      ...(policy?.compaction?.trigger_tokens !== undefined ? { model_auto_compact_token_limit: policy.compaction.trigger_tokens } : {}),
      model_providers: {
        cx_agent: {
          name: "cx-agent",
          base_url: connection.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "") + "/v1",
          env_key: "CX_AGENT_GATEWAY_KEY",
          wire_api: "responses",
        },
      },
    },
    env,
  };
}

export async function runCodex(
  input: EngineInput,
  context: EngineRunContext,
  interrupt: InterruptHandle,
  createClient: CodexFactory = (options) => new Codex(options),
): Promise<EngineResult> {
  if (!input.connection) throw new Error("Codex engine requires a configured CX_AGENT_BASE_URL and API key.");
  if (input.operation === "compact") {
    throw new Error("Codex SDK does not expose native session compaction.");
  }
  if (input.fork) {
    throw new Error("Codex SDK does not expose native session forking.");
  }

  const options = buildCodexOptions(input.connection, { context: input.context });
  const client = createClient(options);
  const threadOptions: ThreadOptions = {
    model: input.model,
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    webSearchMode: "disabled",
  };
  if (input.effort) {
    if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"].includes(input.effort)) {
      throw new Error("Codex does not support reasoning effort \"" + input.effort + "\".");
    }
    threadOptions.modelReasoningEffort = input.effort as NonNullable<ThreadOptions["modelReasoningEffort"]>;
  }
  const thread = input.resumeSessionId
    ? client.resumeThread(input.resumeSessionId, threadOptions)
    : client.startThread(threadOptions);
  if (input.resumeSessionId) context.emit({ kind: "session", sessionId: input.resumeSessionId });

  return streamThread(thread, input.prompt, context, interrupt);
}

async function streamThread(
  thread: Pick<Thread, "id" | "runStreamed">,
  prompt: string,
  context: EngineRunContext,
  interrupt: InterruptHandle,
): Promise<EngineResult> {
  let result = "";
  let turns = 0;
  let succeeded = false;
  let error: string | null = null;
  let sessionId: string | null = thread.id;

  try {
    const stream = await thread.runStreamed(prompt, { signal: context.signal });
    for await (const event of stream.events) {
      const nextSessionId = event.type === "thread.started" ? event.thread_id : thread.id;
      if (nextSessionId && nextSessionId !== sessionId) {
        sessionId = nextSessionId;
        context.emit({ kind: "session", sessionId });
      }
      processEvent(event, context, (text) => { result += text; }, () => { turns += 1; }, {
        complete: () => { succeeded = true; },
        fail: (message) => { error = message; succeeded = false; },
      });
    }
  } catch (cause) {
    if (!interrupt.isAborted) error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error) succeeded = false;
  if (!succeeded && !error && !interrupt.isAborted) error = "Codex stream ended without a completed turn";
  turns = Math.max(turns, 1);
  if (succeeded) return { result, sessionId, turns, status: "completed", error: null };
  return { result, sessionId, turns, status: "failed", error: error ?? "Codex job was interrupted." };
}

function processEvent(
  event: ThreadEvent,
  context: EngineRunContext,
  appendResult: (text: string) => void,
  countTurn: () => void,
  terminal: { complete(): void; fail(message: string): void },
): void {
  switch (event.type) {
    case "thread.started":
      break;
    case "turn.started":
      countTurn();
      context.emit({ kind: "system", summary: "Codex turn started" });
      break;
    case "turn.completed":
      terminal.complete();
      break;
    case "turn.failed":
      terminal.fail(event.error.message);
      break;
    case "error":
      terminal.fail(event.message);
      break;
    case "item.started":
      if (event.item.type === "command_execution") {
        context.emit({ kind: "tool_use", name: "command", summary: event.item.command });
      } else if (event.item.type === "mcp_tool_call") {
        context.emit({ kind: "tool_use", name: event.item.tool, summary: event.item.server });
      }
      break;
    case "item.completed":
      if (event.item.type === "agent_message") {
        appendResult(event.item.text);
        context.emit({ kind: "assistant", text: event.item.text });
      } else if (event.item.type === "command_execution") {
        context.emit({ kind: "tool_result", summary: event.item.aggregated_output.slice(0, 4096) });
      } else if (event.item.type === "file_change") {
        const changed = event.item.changes.map((change) => change.path).join(", ");
        context.emit({ kind: "tool_use", name: "file_change", summary: changed || "Codex changed files" });
      } else if (event.item.type === "error") {
        context.emit({ kind: "tool_result", summary: event.item.message });
      } else if (event.item.type === "mcp_tool_call" && event.item.error) {
        context.emit({ kind: "tool_result", summary: event.item.error.message });
      }
      break;
  }
}

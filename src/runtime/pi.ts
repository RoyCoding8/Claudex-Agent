import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EngineInput, EngineResult, EngineRunContext } from "./engine.js";
import type { InterruptHandle } from "../interrupt.js";
import { jobStoreDir } from "../paths.js";
import { configValue } from "../config.js";
import { resolveContextPolicy } from "./context-policy.js";
import type { AccessPolicy } from "../access.js";

type PiApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface PiRunInput extends EngineInput {
  api?: PiApi;
}

const PI_APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
const API_KEY_AUTH_API: PiApi = "anthropic-messages";
const PROVIDER_ID = "cx-agent";

export function piToolsForAccess(access?: AccessPolicy): string[] {
  return access?.mode === "read-only" ? ["read"] : ["read", "bash", "edit", "write"];
}

function isPiApi(value: string): value is PiApi {
  return PI_APIS.some((supported) => supported === value);
}

function selectedApi(input: PiRunInput): PiApi {
  const api: unknown = input.api ?? configValue("CX_AGENT_PI_API") ?? "openai-completions";
  if (typeof api !== "string" || !isPiApi(api)) {
    throw new Error(`Unsupported Pi API "${String(api)}". Choose ${PI_APIS.join(", ")}.`);
  }
  return api;
}

function resultFailure(error: unknown, sessionId: string | null = null, turns = 0): EngineResult {
  return {
    result: "",
    sessionId,
    turns,
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function runPi(
  input: PiRunInput,
  context: EngineRunContext,
  interrupt?: InterruptHandle,
): Promise<EngineResult> {
  let tempAgentDir: string | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortPromise: Promise<void> | undefined;
  let abortHandler: (() => void) | undefined;
  let turns = 0;
  let result = "";
  let lastAssistant: AssistantMessage | undefined;
  let sessionId: string | null = input.resumeSessionId ?? null;

  try {
    if (!input.connection) throw new Error("Pi requires a provider connection.");
    const api = selectedApi(input);
    const policy = resolveContextPolicy("pi", input.context);
    if (input.connection.authMode === "api-key" && api !== API_KEY_AUTH_API) {
      throw new Error(`Pi API-key authentication is supported only with ${API_KEY_AUTH_API}.`);
    }
    if (context.signal.aborted || interrupt?.isAborted) throw new Error("Pi job was interrupted before startup.");

    const authMode = input.connection.authMode ?? "bearer";
    const baseUrl = input.connection.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "") + (api === "anthropic-messages" ? "" : "/v1");
    tempAgentDir = await mkdtemp(join(tmpdir(), "cx-agent-pi-"));
    const sessionDir = join(jobStoreDir(), "pi-sessions");
    await mkdir(sessionDir, { recursive: true });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "cx-agent",
      baseUrl,
      api,
      authHeader: authMode === "bearer",
      models: [{
        id: input.connection.model,
        name: input.connection.model,
        api,
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: policy.window_tokens,
        maxTokens: policy.max_output_tokens,
      }],
    });
    await modelRuntime.setRuntimeApiKey(PROVIDER_ID, input.connection.apiKey);
    if (api === "anthropic-messages" && authMode === "bearer") {
      const provider = modelRuntime.getProvider(PROVIDER_ID);
      if (!provider) throw new Error("Pi gateway provider was not registered.");
      const authorization = `Bearer ${input.connection.apiKey}`;
      modelRuntime.registerNativeProvider({
        ...provider,
        auth: { apiKey: { name: "Gateway bearer token", resolve: async () => ({ auth: { headers: { Authorization: authorization } }, source: "cx-agent" }) } },
      });
    }
    const model = modelRuntime.getModel(PROVIDER_ID, input.connection.model);
    if (!model) throw new Error(`Pi could not load model "${input.connection.model}".`);

    const settingsManager = SettingsManager.inMemory({ compaction: {
      enabled: policy.compaction.enabled,
      reserveTokens: policy.window_tokens - policy.compaction.trigger_tokens,
      keepRecentTokens: policy.compaction.keep_recent_tokens,
    } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: tempAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    let sessionManager: SessionManager;
    if (!input.resumeSessionId) {
      sessionManager = SessionManager.create(input.cwd, sessionDir);
    } else {
      const source = SessionManager.findById(input.cwd, input.resumeSessionId, sessionDir);
      if (!source) throw new Error(`Pi session "${input.resumeSessionId}" was not found for ${input.cwd}.`);
      sessionManager = input.fork
        ? SessionManager.forkFrom(source, input.cwd, sessionDir)
        : SessionManager.open(source, sessionDir, input.cwd);
    }

    const created = await createAgentSession({
      cwd: input.cwd,
      agentDir: tempAgentDir,
      modelRuntime,
      model,
      tools: piToolsForAccess(input.access),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    sessionId = session.sessionId;
    context.emit({ kind: "session", sessionId });

    abortHandler = (): void => {
      abortPromise ??= session?.abort();
    };
    context.signal.addEventListener("abort", abortHandler, { once: true });
    interrupt?.signal.addEventListener("abort", abortHandler, { once: true });
    if (context.signal.aborted || interrupt?.isAborted) abortHandler();

    unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start" && event.reason !== "manual") context.emit({ kind: "system", summary: "automatic compaction started" });
      if (event.type === "compaction_end" && event.reason !== "manual") context.emit({ kind: "system", summary: event.aborted ? "automatic compaction aborted" : event.result ? "automatic compaction completed" : "automatic compaction failed" });
      if (event.type === "message_end" && event.message.role === "assistant") lastAssistant = event.message;
      if (event.type === "turn_end") turns += 1;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        context.emit({ kind: "assistant", text: event.assistantMessageEvent.delta });
      }
      if (event.type === "tool_execution_start") {
        context.emit({ kind: "tool_use", name: event.toolName, summary: event.toolName });
      }
      if (event.type === "tool_execution_end") {
        context.emit({ kind: "tool_result", summary: `${event.toolName} ${event.isError ? "failed" : "completed"}` });
      }
    });

    if (input.operation === "compact") {
      if (!input.resumeSessionId) throw new Error("Pi compaction requires an existing session.");
      const compaction = await session.compact(input.prompt.trim() || undefined);
      result = compaction.summary;
    } else {
      await session.prompt(input.prompt);
      result = lastAssistant?.content.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
      const last = lastAssistant;
      if (last?.stopReason === "length") {
        return { result, sessionId, turns, status: "incomplete", error: "Pi reached the model output token limit." };
      }
      if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
        return { result, sessionId, turns, status: "failed", error: last.errorMessage ?? `Pi turn ended with ${last.stopReason}.` };
      }
    }

    if (abortPromise) await abortPromise;
    const aborted = context.signal.aborted || Boolean(interrupt?.isAborted);
    if (aborted) return { result, sessionId, turns, status: "failed", error: "Pi job was interrupted." };
    return { result, sessionId, turns, status: "completed", error: null };
  } catch (error) {
    if (abortPromise) await abortPromise;
    return resultFailure(error, session?.sessionId ?? sessionId, turns);
  } finally {
    if (abortHandler) {
      context.signal.removeEventListener("abort", abortHandler);
      interrupt?.signal.removeEventListener("abort", abortHandler);
    }
    if (session) {
      unsubscribe?.();
      session.dispose();
    }
    if (tempAgentDir) await rm(tempAgentDir, { recursive: true, force: true });
  }
}

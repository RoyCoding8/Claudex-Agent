import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineRunContext, WorkerEvent } from "../src/runtime/engine.js";

const originalDataDir = process.env.CX_AGENT_DATA_DIR;
let dataDir: string;
let server: Server;
let baseUrl: string;
let runPi: typeof import("../src/runtime/pi.js").runPi;
const requests: Array<{ path: string | undefined; authorization: string | undefined; apiKey: string | string[] | undefined; messages: unknown; outputLimit?: number }> = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cx-agent-pi-test-"));
  process.env.CX_AGENT_DATA_DIR = dataDir;
  ({ runPi } = await import("../src/runtime/pi.js"));
  server = createServer((request, response) => respond(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake gateway did not bind a TCP port.");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalDataDir === undefined) delete process.env.CX_AGENT_DATA_DIR;
  else process.env.CX_AGENT_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("Pi SDK runtime", () => {
  it.each([true, false])("honors the context output limit and automatic compaction setting %s", async (enabled) => {
    const events: WorkerEvent[] = [];
    const context: EngineRunContext = { signal: new AbortController().signal, emit: (event) => events.push(event) };
    const startCount = requests.length;
    const input = { prompt: "a first turn", model: "local-model", cwd: dataDir, timeoutMs: 30000,
      connection: { baseUrl, apiKey: "test-secret", model: "local-model", authMode: "bearer" as const },
      context: { window_tokens: 32768, max_output_tokens: 1024, compaction: { enabled, trigger_tokens: 5000, keep_recent_tokens: 1000 } } };
    const first = await runPi(input, context);
    expect(first.status).toBe("completed");
    expect(requests[startCount]?.outputLimit).toBe(1024);
    const resumed = await runPi({ ...input, resumeSessionId: first.sessionId ?? undefined,
      prompt: "TRIGGER_AUTO_COMPACTION " + "retained context ".repeat(3000) }, context);
    expect(resumed.status).toBe("completed");
    const compactionEvents = events.filter((event) => "summary" in event && event.summary === "automatic compaction completed");
    expect(compactionEvents.length).toBe(enabled ? 1 : 0);
    expect(requests.length - startCount).toBe(enabled ? 3 : 2);
  });

  it("persists, resumes, forks, and natively compacts a session through a local gateway", async () => {
    const cwd = dataDir;
    const connection = { baseUrl, apiKey: "test-secret", model: "local-model", authMode: "bearer" as const };
    const first = await execute({ prompt: "first request", model: "local-model", cwd, timeoutMs: 30000, connection });

    expect(first).toMatchObject({ result: "gateway-answer", status: "completed", error: null, turns: 1 });
    expect(first.sessionId).toBeTypeOf("string");
    expect(requests[0]?.authorization).toBe("Bearer test-secret");

    const resumed = await execute({
      prompt: "continue the same session " + "context to summarize ".repeat(5000),
      model: "local-model",
      cwd,
      timeoutMs: 30000,
      connection,
      resumeSessionId: first.sessionId ?? undefined,
    });
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.result).toBe("gateway-answer");

    const forked = await execute({
      prompt: "continue in a fork",
      model: "local-model",
      cwd,
      timeoutMs: 30000,
      connection,
      resumeSessionId: first.sessionId ?? undefined,
      fork: true,
    });
    expect(forked.status).toBe("completed");
    expect(forked.sessionId).not.toBe(first.sessionId);

    const compacted = await execute({
      prompt: "retain the user goal and decisions",
      operation: "compact",
      model: "local-model",
      cwd,
      timeoutMs: 30000,
      connection,
      resumeSessionId: first.sessionId ?? undefined,
    });
    expect(compacted.error).toBeNull();
    expect(compacted.status).toBe("completed");
    expect(compacted.result).toContain("gateway-answer");
    expect(compacted.sessionId).toBe(first.sessionId);
    expect(requests.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects API-key auth when the selected API cannot preserve its wire format", async () => {
    const result = await execute({
      prompt: "unsupported auth combination",
      model: "local-model",
      cwd: dataDir,
      timeoutMs: 30000,
      api: "openai-completions",
      connection: { baseUrl, apiKey: "test-secret", model: "local-model", authMode: "api-key" },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("supported only with anthropic-messages");
  });

  it("reports gateway errors instead of completing with an empty answer", async () => {
    const result = await execute({
      prompt: "FORCE_GATEWAY_ERROR", model: "local-model", cwd: dataDir, timeoutMs: 30000,
      connection: { baseUrl, apiKey: "test-secret", model: "local-model", authMode: "bearer" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("deliberate authentication failure");
  });

  it("keeps a length-limited answer incomplete and resumable", async () => {
    const result = await execute({
      prompt: "FORCE_TOKEN_LIMIT", model: "local-model", cwd: dataDir, timeoutMs: 30000,
      connection: { baseUrl, apiKey: "test-secret", model: "local-model", authMode: "bearer" },
    });
    expect(result).toMatchObject({ status: "incomplete", result: "gateway-answer", error: "Pi reached the model output token limit." });
    expect(result.sessionId).toBeTypeOf("string");
  });

  it.each(["bearer", "api-key"] as const)("uses Anthropic Messages with %s authentication", async (authMode) => {
    const result = await execute({
      prompt: "use messages", model: "local-model", cwd: dataDir, timeoutMs: 30000, api: "anthropic-messages",
      connection: { baseUrl, apiKey: "test-secret", model: "local-model", authMode },
    });
    expect(result).toMatchObject({ status: "completed", result: "gateway-answer", error: null });
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/messages",
      authorization: authMode === "bearer" ? "Bearer test-secret" : undefined,
      apiKey: authMode === "api-key" ? "test-secret" : undefined,
    });
  });
});

async function execute(input: Parameters<typeof runPi>[0]): Promise<Awaited<ReturnType<typeof runPi>>> {
  const context: EngineRunContext = {
    signal: new AbortController().signal,
    emit: () => undefined,
  };
  return runPi(input, context);
}

function respond(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    let body: { messages?: unknown; max_tokens?: number; max_completion_tokens?: number } = {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed === "object" && parsed !== null && "messages" in parsed) {
        body = { messages: parsed.messages };
        if ("max_tokens" in parsed && typeof parsed.max_tokens === "number") body.max_tokens = parsed.max_tokens;
        if ("max_completion_tokens" in parsed && typeof parsed.max_completion_tokens === "number") body.max_completion_tokens = parsed.max_completion_tokens;
      }
    } catch {
      response.writeHead(400).end("invalid json");
      return;
    }
    requests.push({ path, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"], messages: body.messages, outputLimit: body.max_tokens ?? body.max_completion_tokens });
    const messageText = JSON.stringify(body.messages);
    const inputTokens = messageText.includes("TRIGGER_AUTO_COMPACTION") && !messageText.includes("You are a context summarization assistant") ? 7000 : 1;
    if (JSON.stringify(body.messages).includes("FORCE_GATEWAY_ERROR")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "deliberate authentication failure", type: "authentication_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (path === "/v1/messages") {
      const events = [
        { type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", content: [], model: "local-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "gateway-answer" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    response.end([
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{"role":"assistant","content":"gateway-answer"},"finish_reason":null}]}',
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: {}, finish_reason: messageText.includes("FORCE_TOKEN_LIMIT") ? "length" : "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: 1, total_tokens: inputTokens + 1 } })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n"));
  });
}

import { afterEach, describe, expect, it } from "vitest";
import { inspectReadiness } from "../src/readiness.js";
import type { ModelProvider } from "../src/providers/types.js";

const previousPiApi = process.env.CX_AGENT_PI_API;
afterEach(() => {
  if (previousPiApi === undefined) delete process.env.CX_AGENT_PI_API;
  else process.env.CX_AGENT_PI_API = previousPiApi;
});

function provider(input: {
  models?: string[];
  source?: "models-endpoint" | "static" | "none";
  configuration?: "configured" | "missing" | "invalid";
  ready?: boolean;
  baseUrl?: string;
  apiKey?: string;
  authMode?: "bearer" | "api-key";
} = {}): ModelProvider {
  return {
    id: "test",
    discover: async () => ({
      models: input.models ?? ["m"],
      ready: input.ready ?? true,
      diagnostics: [],
      source: input.source ?? "models-endpoint",
      configuration: input.configuration,
    }),
    connection: async (model) => ({
      baseUrl: input.baseUrl ?? "https://gateway.example/v1",
      apiKey: input.apiKey ?? "secret-token",
      authMode: input.authMode ?? "bearer",
      model,
    }),
  };
}

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const streamResponse = (chunks: string[]): Response => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}), { headers: { "Content-Type": "text/event-stream" } });

describe("inspectReadiness", () => {
  it("does not report ready until the selected protocol has been explicitly checked", async () => {
    const result = await inspectReadiness({ provider: provider(), model: "m", engine: "claude" });
    expect(result).toMatchObject({
      ready: false,
      phase: "protocol",
      configuration: "configured",
      availability: { status: "available", source: "models-endpoint" },
      protocol: { status: "not-requested", api: "anthropic-messages" },
    });
  });

  it("probes the exact Claude model over Anthropic Messages only when requested", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const result = await inspectReadiness({
      provider: provider({ baseUrl: "https://gateway.example/v1", authMode: "api-key" }),
      model: "m",
      engine: "claude",
      verify: true,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return response({ type: "message", content: [{ type: "text", text: "ok" }] });
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://gateway.example/v1/messages");
    expect(new Headers(requests[0].init?.headers).get("x-api-key")).toBe("secret-token");
    expect(new Headers(requests[0].init?.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({ model: "m", max_tokens: 512, stream: true });
    expect(result).toMatchObject({ ready: true, phase: "ready", availability: { status: "available", source: "protocol" }, protocol: { status: "verified" } });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("probes the requested alias verbatim even when the catalog lists another ID", async () => {
    let sentModel = "";
    const result = await inspectReadiness({
      provider: provider({ models: ["openrouter/stealth/crouton-alpha"] }),
      model: "crouton-alpha",
      engine: "claude",
      verify: true,
      fetchImpl: async (_input, init) => {
        sentModel = JSON.parse(String(init?.body)).model;
        return response({ type: "message", content: [{ type: "text", text: "ok" }] });
      },
    });
    expect(sentModel).toBe("crouton-alpha");
    expect(result).toMatchObject({ ready: true, availability: { status: "available", source: "protocol" }, protocol: { status: "verified" } });
    expect(result.diagnostics.join(" ")).toMatch(/accepted by protocol probe but is absent from the catalog/);
  });

  it("probes static models because their availability is unknown", async () => {
    let requests = 0;
    const result = await inspectReadiness({
      provider: provider({ source: "static" }),
      model: "m",
      engine: "claude",
      verify: true,
      fetchImpl: async () => { requests += 1; return response({ type: "message", content: [{ type: "text", text: "ok" }] }); },
    });
    expect(requests).toBe(1);
    expect(result).toMatchObject({ ready: true, availability: { status: "available", source: "protocol" } });
    expect(result.diagnostics.join(" ")).not.toMatch(/availability is unknown/);
  });

  it("uses the Codex Responses API and never returns response bodies or credentials", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await inspectReadiness({
      provider: provider({ apiKey: "do-not-return" }),
      model: "m",
      engine: "codex",
      verify: true,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return response({ id: "r", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
      },
    });
    expect(request?.url).toBe("https://gateway.example/v1/responses");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer do-not-return");
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({ model: "m", max_output_tokens: 512, stream: true, store: false });
    expect(result.protocol.status).toBe("verified");
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(JSON.stringify(result)).not.toContain('"output"');
  });

  it("rejects Responses API errors and output without assistant text", async () => {
    for (const body of [
      { id: "r", status: "failed", error: { message: "private detail" }, output: [] },
      { id: "r", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "  " }] }] },
    ]) {
      const result = await inspectReadiness({
        provider: provider(), model: "m", engine: "codex", verify: true,
        fetchImpl: async () => response(body),
      });
      expect(result.ready).toBe(false);
      expect(result.protocol.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("private detail");
    }
  });

  it("uses the configured Pi API and reports bounded failures", async () => {
    process.env.CX_AGENT_PI_API = "openai-completions";
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await inspectReadiness({
      provider: provider(),
      model: "m",
      engine: "pi",
      verify: true,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return new Response("private response token=do-not-return", { status: 401 });
      },
    });
    expect(request?.url).toBe("https://gateway.example/v1/chat/completions");
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({ model: "m", max_tokens: 512, stream: true });
    expect(result).toMatchObject({ ready: false, protocol: { status: "failed", api: "openai-completions" } });
    expect(JSON.stringify(result)).not.toContain("do-not-return");
  });

  it("reports unknown availability when static or disabled catalogs cannot establish model identity", async () => {
    for (const source of ["static", "none"] as const) {
      const result = await inspectReadiness({ provider: provider({ source }), model: "m", engine: "claude" });
      expect(result.availability.status).toBe("unknown");
      expect(result.ready).toBe(false);
    }
  });

  it("keeps model availability unknown when endpoint discovery failed", async () => {
    const result = await inspectReadiness({ provider: provider({ ready: false, models: [] }), model: "m", engine: "claude" });
    expect(result.availability).toEqual({ status: "unknown", source: "models-endpoint" });
  });

  it("rejects successful HTTP responses with empty or failed assistant output", async () => {
    for (const body of [
      { type: "message", content: [] },
      { type: "message", content: [{ type: "text", text: "" }] },
      { type: "error", error: { message: "private detail" } },
      { type: "message", status: "failed", content: [{ type: "text", text: "not a result" }] },
    ]) {
      const result = await inspectReadiness({
        provider: provider(), model: "m", engine: "claude", verify: true,
        fetchImpl: async () => response(body),
      });
      expect(result.ready).toBe(false);
      expect(result.protocol.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("private detail");
    }
  });

  it("rejects invalid configuration without sending a protocol request", async () => {
    let requests = 0;
    const result = await inspectReadiness({
      provider: provider({ configuration: "invalid" }), model: "m", engine: "claude", verify: true,
      fetchImpl: async () => { requests += 1; return response({ type: "message", content: [{ type: "text", text: "ok" }] }); },
    });
    expect(requests).toBe(0);
    expect(result).toMatchObject({ ready: false, configuration: "invalid", phase: "configuration", protocol: { status: "skipped" } });
  });

  it("requires a non-empty assistant choice for Pi OpenAI completions", async () => {
    process.env.CX_AGENT_PI_API = "openai-completions";
    const result = await inspectReadiness({
      provider: provider(), model: "m", engine: "pi", verify: true,
      fetchImpl: async () => response({ choices: [{ message: { role: "assistant", content: "" } }] }),
    });
    expect(result).toMatchObject({ ready: false, protocol: { status: "failed" } });
  });

  it("verifies Claude streaming output through message_stop", async () => {
    let body: Record<string, unknown> = {};
    const result = await inspectReadiness({
      provider: provider(), model: "m", engine: "claude", verify: true,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return streamResponse([
          'event: content_block_delta\r',
          '\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\r\n\r\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
      },
    });
    expect(body).toMatchObject({ model: "m", max_tokens: 512, stream: true });
    expect(result.protocol.status).toBe("verified");
    expect(result.ready).toBe(true);
  });

  it("verifies Responses streaming output through response.completed", async () => {
    let body: Record<string, unknown> = {};
    const result = await inspectReadiness({
      provider: provider(), model: "m", engine: "codex", verify: true,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return streamResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ]);
      },
    });
    expect(body).toMatchObject({ model: "m", max_output_tokens: 512, stream: true });
    expect(result.protocol.status).toBe("verified");
  });

  it("verifies Pi OpenAI streaming output through a terminal choice", async () => {
    process.env.CX_AGENT_PI_API = "openai-completions";
    let body: Record<string, unknown> = {};
    const result = await inspectReadiness({
      provider: provider(), model: "m", engine: "pi", verify: true,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ]);
      },
    });
    expect(body).toMatchObject({ model: "m", max_tokens: 512, stream: true });
    expect(result.protocol.status).toBe("verified");
  });

  it("rejects text followed by an error event and a stream without a terminal event", async () => {
    const responses = [
      streamResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
        'event: error\ndata: {"type":"error","error":{"message":"private detail"}}\n\n',
      ]),
      streamResponse(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n']),
    ];
    for (const stream of responses) {
      const result = await inspectReadiness({
        provider: provider(), model: "m", engine: "claude", verify: true,
        fetchImpl: async () => stream,
      });
      expect(result.ready).toBe(false);
      expect(result.protocol.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("private detail");
    }
  });

  it("rejects an SSE response that exceeds the byte limit", async () => {
    const result = await inspectReadiness({
      provider: provider(), model: "m", engine: "claude", verify: true,
      fetchImpl: async () => streamResponse(["x".repeat(65 * 1024)]),
    });
    expect(result).toMatchObject({ ready: false, protocol: { status: "failed" } });
  });
});

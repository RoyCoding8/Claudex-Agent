import { configValue } from "./config.js";
import type { EngineName } from "./runtime/engine.js";
import type { Catalog, Connection, ModelProvider } from "./providers/types.js";

export type ReadinessSource = "models-endpoint" | "static" | "none" | "protocol" | "unknown";
export type ProtocolApi = "anthropic-messages" | "responses" | "openai-completions";

export interface ReadinessResult {
  ready: boolean;
  phase: "configuration" | "model" | "protocol" | "ready";
  configuration: "configured" | "missing" | "invalid";
  availability: { status: "available" | "unknown" | "unavailable"; source: ReadinessSource };
  protocol: { status: "not-requested" | "verified" | "failed" | "skipped"; api: string };
  model: string | null;
  models: string[];
  diagnostics: string[];
}

export interface ReadinessOptions {
  provider: ModelProvider;
  model: string | null | undefined;
  engine: EngineName;
  verify?: boolean;
  fetchImpl?: typeof fetch;
  piApi?: string;
}

type Probe = { api: ProtocolApi; path: string; request(connection: Connection): { headers: Record<string, string>; body: unknown; valid(body: unknown): boolean } };
type StreamState = { hasText: boolean };
type StreamDisposition = "continue" | "complete" | "failed";

const MAX_RESPONSE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFailure(body: unknown): boolean {
  if (!isRecord(body)) return true;
  if (body.error !== undefined && body.error !== null) return true;
  if (body.type === "error" || body.type === "response.failed" || body.type === "response.incomplete") return true;
  return body.status === "failed" || body.status === "error";
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function readApi(engine: EngineName, piApi?: string): Probe["api"] | undefined {
  if (engine === "claude") return "anthropic-messages";
  if (engine === "codex") return "responses";
  const api = piApi ?? configValue("CX_AGENT_PI_API") ?? "openai-completions";
  if (api === "anthropic-messages" || api === "openai-completions") return api;
  if (api === "openai-responses") return "responses";
  return undefined;
}

function probeFor(api: ProtocolApi): Probe & { streamEvent(event: string, data: unknown, state: StreamState): StreamDisposition } {
  if (api === "anthropic-messages") {
    return {
      api,
      path: "/v1/messages",
      streamEvent: (event, data, state) => {
        if (event === "error" || hasFailure(data)) return "failed";
        if (isRecord(data) && data.type === "content_block_delta" && isRecord(data.delta)
          && data.delta.type === "text_delta" && hasText(data.delta.text)) state.hasText = true;
        if (event === "message_stop" || isRecord(data) && data.type === "message_stop") return "complete";
        return "continue";
      },
      request: (connection) => {
        const headers: Record<string, string> = {
          "anthropic-version": "2023-06-01",
          ...(connection.authMode === "api-key"
            ? { "x-api-key": connection.apiKey }
            : connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        };
        return {
          headers,
          body: { model: connection.model, max_tokens: 512, stream: true, messages: [{ role: "user", content: "Reply OK" }] },
          valid: (body: unknown) => !hasFailure(body) && isRecord(body) && body.type === "message" && Array.isArray(body.content)
            && body.content.some((block) => isRecord(block) && block.type === "text" && hasText(block.text)),
        };
      },
    };
  }
  if (api === "responses") {
    return {
      api,
      path: "/v1/responses",
      streamEvent: (event, data, state) => {
        if (event === "error" || event.endsWith(".failed") || event.endsWith(".incomplete") || hasFailure(data)) return "failed";
        if (isRecord(data) && data.type === "response.completed" && isRecord(data.response)
          && (data.response.status === "failed" || data.response.status === "incomplete")) return "failed";
        if (isRecord(data) && data.type === "response.output_text.delta" && hasText(data.delta)) state.hasText = true;
        if (event === "response.completed" || isRecord(data) && data.type === "response.completed") return "complete";
        return "continue";
      },
      request: (connection) => {
        const headers: Record<string, string> = {};
        if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
        return {
          headers,
          body: { model: connection.model, input: "Reply OK", max_output_tokens: 512, stream: true, store: false },
          valid: (body: unknown) => !hasFailure(body) && isRecord(body) && typeof body.id === "string" && Array.isArray(body.output)
            && body.output.some((item) => isRecord(item) && item.type === "message" && item.role === "assistant"
              && Array.isArray(item.content) && item.content.some((block) => isRecord(block) && block.type === "output_text" && hasText(block.text))),
        };
      },
    };
  }
  return {
    api,
    path: "/v1/chat/completions",
    streamEvent: (event, data, state) => {
      if (data === "[DONE]") return "complete";
      if (event === "error" || hasFailure(data)) return "failed";
      if (!isRecord(data) || !Array.isArray(data.choices)) return "continue";
      for (const choice of data.choices) {
        if (!isRecord(choice)) continue;
        if (choice.finish_reason === "error" || choice.finish_reason === "length" || choice.finish_reason === "content_filter") return "failed";
        if (isRecord(choice.delta) && hasText(choice.delta.content)) state.hasText = true;
        if (choice.finish_reason === "stop") return "complete";
      }
      return "continue";
    },
    request: (connection) => {
      const headers: Record<string, string> = {};
      if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
      return {
        headers,
        body: { model: connection.model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 512, stream: true },
        valid: (body: unknown) => !hasFailure(body) && isRecord(body) && Array.isArray(body.choices)
          && body.choices.some((choice) => isRecord(choice) && isRecord(choice.message)
            && choice.message.role === "assistant" && hasText(choice.message.content)),
      };
    },
  };
}

function sourceOf(catalog: Catalog): Exclude<ReadinessSource, "protocol"> {
  return catalog.source ?? "unknown";
}

function initialAvailability(catalog: Catalog, model: string | null, source: Exclude<ReadinessSource, "protocol">): ReadinessResult["availability"] {
  if (!model) return { status: "unknown", source };
  if (source === "models-endpoint") {
    if (!catalog.ready) return { status: "unknown", source };
    return catalog.models.includes(model)
      ? { status: "available", source }
      : { status: "unavailable", source };
  }
  return { status: "unknown", source };
}

async function verifyProtocol(
  connection: Connection,
  probe: ReturnType<typeof probeFor>,
  fetchImpl: typeof fetch,
): Promise<{ status: "verified" | "failed"; diagnostic?: string }> {
  const baseUrl = connection.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const url = `${baseUrl}${probe.path}`;
  const request = probe.request(connection);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "text/event-stream, application/json", "Content-Type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: "failed", diagnostic: `Protocol check returned HTTP ${response.status}.` };
    const valid = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
      ? await verifyEventStream(response, probe)
      : await verifyJsonResponse(response, request.valid);
    return valid ? { status: "verified" } : { status: "failed", diagnostic: "Protocol check returned no valid assistant text response." };
  } catch {
    return { status: "failed", diagnostic: "Protocol check failed before a valid response was received." };
  }
}

async function verifyJsonResponse(response: Response, valid: (body: unknown) => boolean): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return valid(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return false;
  }
}

async function verifyEventStream(
  response: Response,
  probe: ReturnType<typeof probeFor>,
): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  const state: StreamState = { hasText: false };
  let pending = "";
  let totalBytes = 0;
  let result: StreamDisposition = "continue";
  const processEvent = (block: string): StreamDisposition => {
    let event = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return "continue";
    const text = data.join("\n");
    let value: unknown = text;
    if (text !== "[DONE]") {
      try { value = JSON.parse(text); } catch { return "failed"; }
    }
    return probe.streamEvent(event, value, state);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return false;
      }
      pending += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(pending);
      while (boundary) {
        result = processEvent(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        if (result !== "continue") {
          void reader.cancel().catch(() => undefined);
          return result === "complete" && state.hasText;
        }
        boundary = /\r?\n\r?\n/.exec(pending);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) result = processEvent(pending);
    return result === "complete" && state.hasText;
  } finally {
    reader.releaseLock();
  }
}

export async function inspectReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const model = options.model || null;
  const catalog = await options.provider.discover(model ?? undefined);
  const source = sourceOf(catalog);
  const configuration = catalog.configuration ?? (catalog.diagnostics.some((item) => item.includes("CX_AGENT_BASE_URL is not set")) ? "missing" : "configured");
  let availability = initialAvailability(catalog, model, source);
  const api = readApi(options.engine, options.piApi);
  const selectedApi = options.engine === "pi" ? options.piApi ?? configValue("CX_AGENT_PI_API") ?? "openai-completions" : options.engine === "codex" ? "responses" : "anthropic-messages";
  const protocol: ReadinessResult["protocol"] = { status: "not-requested", api: selectedApi };
  const diagnostics = [...catalog.diagnostics];

  if (!model) diagnostics.push("no model configured — pass a model name or set CX_AGENT_MODEL.");
  else if (availability.status === "unavailable") diagnostics.push(`unknown model "${model}"; valid models: ${catalog.models.join(", ")}`);
  else if (availability.status === "unknown") diagnostics.push("model availability is unknown from static or disabled discovery.");

  if (configuration !== "configured") {
    protocol.status = "skipped";
    if (configuration === "invalid") diagnostics.push("gateway configuration is invalid.");
    return { ready: false, phase: "configuration", configuration, availability, protocol, model, models: catalog.models, diagnostics };
  }
  if (!model) {
    protocol.status = "skipped";
    return { ready: false, phase: "model", configuration, availability, protocol, model, models: catalog.models, diagnostics };
  }
  if (!options.verify) {
    diagnostics.push("protocol not verified; pass verify:true to send a minimal live request.");
    return { ready: false, phase: availability.status === "available" ? "protocol" : "model", configuration, availability, protocol, model, models: catalog.models, diagnostics };
  }
  if (!api) {
    protocol.status = "failed";
    diagnostics.push("unsupported Pi API; choose anthropic-messages, openai-completions, or openai-responses.");
    return { ready: false, phase: "protocol", configuration, availability, protocol, model, models: catalog.models, diagnostics };
  }

  protocol.api = api;
  let connection: Connection;
  try {
    connection = await options.provider.connection(model);
  } catch {
    protocol.status = "failed";
    diagnostics.push("could not resolve the model gateway connection.");
    return { ready: false, phase: "configuration", configuration: "invalid", availability, protocol, model, models: catalog.models, diagnostics };
  }
  if (options.engine === "codex" && connection.authMode === "api-key") {
    protocol.status = "failed";
    diagnostics.push("Codex Responses API requires bearer-token authentication.");
    return { ready: false, phase: "protocol", configuration, availability, protocol, model, models: catalog.models, diagnostics };
  }
  if (options.engine === "pi" && connection.authMode === "api-key" && api !== "anthropic-messages") {
    protocol.status = "failed";
    diagnostics.push("Pi API-key authentication is supported only with anthropic-messages.");
    return { ready: false, phase: "protocol", configuration, availability, protocol, model, models: catalog.models, diagnostics };
  }

  const checked = await verifyProtocol(connection, probeFor(api), options.fetchImpl ?? fetch);
  protocol.status = checked.status;
  if (checked.diagnostic) diagnostics.push(checked.diagnostic);
  if (checked.status === "verified") {
    const unknownAvailability = diagnostics.findIndex((item) => item.startsWith("model availability is unknown"));
    if (unknownAvailability >= 0) diagnostics.splice(unknownAvailability, 1);
    if (availability.status === "unavailable") {
      const unknown = diagnostics.findIndex((item) => item.startsWith(`unknown model "${model}"`));
      if (unknown >= 0) diagnostics.splice(unknown, 1, `model "${model}" was accepted by protocol probe but is absent from the catalog`);
    }
    availability = { status: "available", source: "protocol" };
  }
  return {
    ready: checked.status === "verified",
    phase: checked.status === "verified" ? "ready" : "protocol",
    configuration,
    availability,
    protocol,
    model,
    models: catalog.models,
    diagnostics,
  };
}

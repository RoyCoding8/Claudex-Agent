import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GatewayProvider, normalizeBaseUrl } from "../src/providers/gateway.js";
import { resolveProvider } from "../src/providers/registry.js";

const STUB = [
  "CX_AGENT_PROVIDER", "CX_AGENT_BASE_URL", "CX_AGENT_API_KEY",
  "CX_AGENT_AUTH_MODE", "CX_AGENT_MODEL", "CX_AGENT_MODELS", "CX_AGENT_DISCOVERY", "CX_AGENT_DISCOVERY_TTL_MS", "CX_AGENT_CONFIG",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and a trailing /v1 so both spellings work", () => {
    expect(normalizeBaseUrl("http://h:4000/")).toBe("http://h:4000");
    expect(normalizeBaseUrl("http://h:4000/v1")).toBe("http://h:4000");
    expect(normalizeBaseUrl("http://h:4000/v1/")).toBe("http://h:4000");
    expect(normalizeBaseUrl("  http://h:4000  ")).toBe("http://h:4000");
    expect(normalizeBaseUrl("http://h:4000/api")).toBe("http://h:4000/api");
  });
});

describe("GatewayProvider.discover", () => {
  it("models-endpoint: reads the OpenAI shape, sorts, and is ready", async () => {
    const urls: string[] = [];
    const p = new GatewayProvider({
      baseUrl: "http://g:1", apiKey: "k",
      fetchImpl: async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return jsonResponse({ data: [{ id: "b" }, { id: "a" }] });
      },
    });
    const c = await p.discover();
    expect(c.ready).toBe(true);
    expect(c.models).toEqual(["a", "b"]);
    expect(urls).toEqual(["http://g:1/v1/models"]);
  });

  it("models-endpoint: accepts a bare-array models response", async () => {
    const p = new GatewayProvider({
      baseUrl: "http://g:1",
      fetchImpl: async () => jsonResponse([{ id: "m1" }, { id: "m0" }]),
    });
    const c = await p.discover();
    expect(c.ready).toBe(true);
    expect(c.models).toEqual(["m0", "m1"]);
  });

  it("models-endpoint: unreachable gateway → not ready with a pointed diagnostic", async () => {
    const p = new GatewayProvider({
      baseUrl: "http://g:1",
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    const c = await p.discover();
    expect(c.ready).toBe(false);
    expect(c.diagnostics[0]).toMatch(/GET \/v1\/models failed/);
  });

  it("models-endpoint: 401 gets a CX_AGENT_API_KEY hint", async () => {
    const p = new GatewayProvider({
      baseUrl: "http://g:1", apiKey: "wrong",
      fetchImpl: async () => new Response("denied", { status: 401 }),
    });
    const c = await p.discover();
    expect(c.ready).toBe(false);
    expect(c.diagnostics[0]).toMatch(/401 .* check CX_AGENT_API_KEY/);
  });

  it("models-endpoint uses the selected authentication header", async () => {
    const seen: Headers[] = [];
    const p = new GatewayProvider({
      baseUrl: "https://gateway.example.com", apiKey: "k", authMode: "api-key", discovery: "models-endpoint",
      fetchImpl: async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return jsonResponse({ data: [{ id: "m" }] });
      },
    });
    await p.discover();
    expect(seen[0]?.get("x-api-key")).toBe("k");
    expect(seen[0]?.has("authorization")).toBe(false);
  });

  it("static: uses the configured list with no network", async () => {
    const p = new GatewayProvider({
      baseUrl: "http://g:1", models: ["Worker lvl"], discovery: "static",
      fetchImpl: async () => { throw new Error("must not fetch"); },
    });
    await expect(p.discover()).resolves.toMatchObject({ ready: true, models: ["Worker lvl"] });
  });

  it("static: an empty list is not ready", async () => {
    const p = new GatewayProvider({ baseUrl: "http://g:1", models: [], discovery: "static" });
    const c = await p.discover();
    expect(c.ready).toBe(false);
    expect(c.diagnostics[0]).toMatch(/CX_AGENT_MODELS is empty/);
  });

  it("none: trusts explicit configuration without making a discovery request", async () => {
    const p = new GatewayProvider({
      baseUrl: "http://g:1", discovery: "none",
      fetchImpl: async () => { throw new Error("must not fetch"); },
    });
    await expect(p.discover()).resolves.toMatchObject({ ready: true, models: [] });
  });

  it("a configured model makes discovery optional by default", async () => {
    process.env.CX_AGENT_BASE_URL = "https://gateway.example.com/anthropic";
    process.env.CX_AGENT_MODEL = "worker-model";
    const p = new GatewayProvider({ fetchImpl: async () => { throw new Error("must not fetch"); } });
    await expect(p.discover()).resolves.toMatchObject({ ready: true, models: [], source: "none" });
  });

  it("an explicit per-call model makes discovery optional", async () => {
    const p = new GatewayProvider({
      baseUrl: "https://gateway.example.com",
      fetchImpl: async () => { throw new Error("must not fetch"); },
    });
    await expect(p.discover("worker-model")).resolves.toMatchObject({ ready: true, models: [], source: "none" });
  });

  it("caches discovery for the TTL — two calls, one fetch", async () => {
    let n = 0;
    const p = new GatewayProvider({
      baseUrl: "http://g:1", discoveryTtlMs: 10_000,
      fetchImpl: async () => { n += 1; return jsonResponse({ data: [{ id: "m" }] }); },
    });
    await p.discover();
    await p.discover();
    expect(n).toBe(1);
  });

  it("does not reuse a discovery-free cache entry for catalog discovery", async () => {
    let n = 0;
    const p = new GatewayProvider({
      baseUrl: "http://g:1",
      fetchImpl: async () => { n += 1; return jsonResponse({ data: [{ id: "m" }] }); },
    });
    await p.discover("m");
    await p.discover();
    expect(n).toBe(1);
  });

  it("missing CX_AGENT_BASE_URL yields a pointed diagnostic without network", async () => {
    const p = new GatewayProvider({ fetchImpl: async () => { throw new Error("must not fetch"); } });
    const c = await p.discover();
    expect(c.ready).toBe(false);
    expect(c.diagnostics[0]).toMatch(/CX_AGENT_BASE_URL is not set/);
  });

  it("rejects an unknown discovery mode", async () => {
    process.env.CX_AGENT_BASE_URL = "https://gateway.example.com";
    process.env.CX_AGENT_DISCOVERY = "magic";
    const p = new GatewayProvider();
    await expect(p.discover()).rejects.toThrow(/CX_AGENT_DISCOVERY/);
  });

  it("env wiring: CX_AGENT_MODELS implies static discovery from env", async () => {
    process.env.CX_AGENT_BASE_URL = "http://g:1";
    process.env.CX_AGENT_MODELS = "Worker lvl, Opus lvl";
    const p = new GatewayProvider({ fetchImpl: async () => { throw new Error("must not fetch"); } });
    await expect(p.discover()).resolves.toMatchObject({ ready: true, models: ["Worker lvl", "Opus lvl"] });
  });
});

describe("GatewayProvider.connection", () => {
  it("throws a config diagnostic when no base URL is configured", async () => {
    const p = new GatewayProvider({});
    await expect(p.connection("m")).rejects.toThrow(/CX_AGENT_BASE_URL is not set/);
  });
  it("returns the normalized connection", async () => {
    const p = new GatewayProvider({ baseUrl: "http://g:1/v1/", apiKey: "k" });
    await expect(p.connection("m")).resolves.toEqual({ baseUrl: "http://g:1", apiKey: "k", authMode: "bearer", model: "m" });
  });
  it("selects Anthropic x-api-key authentication explicitly", async () => {
    process.env.CX_AGENT_AUTH_MODE = "api-key";
    const p = new GatewayProvider({ baseUrl: "https://gateway.example.com", apiKey: "k" });
    await expect(p.connection("m")).resolves.toMatchObject({ apiKey: "k", authMode: "api-key" });
  });
  it("rejects unknown authentication modes", async () => {
    process.env.CX_AGENT_AUTH_MODE = "magic";
    const p = new GatewayProvider({ baseUrl: "https://gateway.example.com", apiKey: "k" });
    await expect(p.connection("m")).rejects.toThrow(/CX_AGENT_AUTH_MODE/);
  });
});

describe("resolveProvider", () => {
  it("cx is rejected with the v0.3 migration message (opts and env paths)", () => {
    expect(() => resolveProvider({ provider: "cx" })).toThrow(/removed in v0\.3\.0/);
    process.env.CX_AGENT_PROVIDER = "cx";
    expect(() => resolveProvider()).toThrow(/CX_AGENT_BASE_URL/);
  });
  it("unknown provider names are rejected", () => {
    expect(() => resolveProvider({ provider: "nope" })).toThrow(/Unknown CX_AGENT_PROVIDER/);
  });
  it("auto / gateway / openai-compatible all resolve to the gateway provider", () => {
    expect(resolveProvider({ provider: "auto" }).id).toBe("gateway");
    expect(resolveProvider({ provider: "gateway" }).id).toBe("gateway");
    expect(resolveProvider({ provider: "openai-compatible" }).id).toBe("gateway");
    expect(resolveProvider().id).toBe("gateway");
  });
});

/** Gateway provider — pure-env HTTP model gateway: OpenAI-shaped discovery, Anthropic-shaped traffic.
 *  Knows nothing about any specific router product; everything comes from config. */

import type { ModelProvider, Catalog, Connection, AuthMode } from "./types.js";
import { configValue } from "../config.js";

export type DiscoveryMode = "models-endpoint" | "static" | "none";

export interface GatewayOptions {
  baseUrl?: string;
  apiKey?: string;
  authMode?: AuthMode;
  models?: string[];
  discovery?: DiscoveryMode;
  discoveryTtlMs?: number;
  fetchImpl?: typeof fetch;
}

/** Canonical gateway root: trims trailing slashes and a trailing /v1 so both spellings work. */
export function normalizeBaseUrl(raw: string): string {
  const u = raw.trim().replace(/\/+$/, "");
  return u.endsWith("/v1") ? u.slice(0, -"/v1".length) : u;
}

export class GatewayProvider implements ModelProvider {
  readonly id = "gateway";
  private readonly opts: GatewayOptions;
  private cache: { at: number; mode: DiscoveryMode; catalog: Catalog } | null = null;

  constructor(opts: GatewayOptions = {}) {
    this.opts = opts;
  }

  private resolveBaseUrl(): string {
    return normalizeBaseUrl(this.opts.baseUrl ?? configValue("CX_AGENT_BASE_URL") ?? "");
  }

  private resolveApiKey(): string {
    return this.opts.apiKey ?? configValue("CX_AGENT_API_KEY") ?? "";
  }

  private resolveAuthMode(): AuthMode {
    const mode = this.opts.authMode ?? configValue("CX_AGENT_AUTH_MODE") ?? "bearer";
    if (mode === "bearer" || mode === "api-key") return mode;
    throw new Error(`Invalid CX_AGENT_AUTH_MODE "${mode}" — expected "bearer" or "api-key".`);
  }

  private resolveStaticModels(): string[] {
    if (this.opts.models && this.opts.models.length > 0) return this.opts.models;
    const v = configValue("CX_AGENT_MODELS");
    if (v && v.trim().length > 0) return v.split(",").map((m) => m.trim()).filter(Boolean);
    return [];
  }

  private resolveDiscovery(model?: string): DiscoveryMode {
    if (this.opts.discovery) return this.opts.discovery;
    const env = configValue("CX_AGENT_DISCOVERY");
    if (env === "models-endpoint" || env === "static" || env === "none") return env;
    if (env) throw new Error(`Invalid CX_AGENT_DISCOVERY "${env}" — expected "models-endpoint", "static", or "none".`);
    if (this.resolveStaticModels().length > 0) return "static";
    return model || configValue("CX_AGENT_MODEL") ? "none" : "models-endpoint";
  }

  private resolveTtlMs(): number {
    if (this.opts.discoveryTtlMs != null) return this.opts.discoveryTtlMs;
    const v = parseInt(configValue("CX_AGENT_DISCOVERY_TTL_MS") ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? v : 60_000;
  }

  private fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /** Discovery is cached per provider instance for the TTL — pre-flight must not hit the gateway per job. */
  async discover(model?: string): Promise<Catalog> {
    const now = Date.now();
    const mode = this.resolveDiscovery(model);
    if (this.cache?.mode === mode && now - this.cache.at < this.resolveTtlMs()) return this.cache.catalog;
    const catalog = await this.discoverUncached(mode);
    this.cache = { at: now, mode, catalog };
    return catalog;
  }

  private async discoverUncached(mode: DiscoveryMode): Promise<Catalog> {
    const baseUrl = this.resolveBaseUrl();
    if (!baseUrl) {
      return {
        models: [], ready: false,
        diagnostics: ["CX_AGENT_BASE_URL is not set — configure an Anthropic-compatible endpoint, e.g. https://gateway.example.com"],
      };
    }
    if (mode === "static") {
      const models = this.resolveStaticModels();
      return {
        models, ready: models.length > 0,
        diagnostics: models.length === 0 ? ["CX_AGENT_MODELS is empty"] : [],
      };
    }
    if (mode === "none") return { models: [], ready: true, diagnostics: [] };
    return this.fetchModels(baseUrl);
  }

  /** GET {base}/v1/models (OpenAI shape, or a bare array) — doubles as the upstream health check. */
  private async fetchModels(baseUrl: string): Promise<Catalog> {
    const url = `${baseUrl}/v1/models`;
    try {
      const headers: Record<string, string> = { "Accept": "application/json" };
      const apiKey = this.resolveApiKey();
      if (apiKey) {
        const mode = this.resolveAuthMode();
        headers[mode === "api-key" ? "x-api-key" : "Authorization"] = mode === "api-key" ? apiKey : `Bearer ${apiKey}`;
      }
      const resp = await this.fetchImpl()(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        return { models: [], ready: false, diagnostics: [`GET ${url} returned ${resp.status}${resp.status === 401 || resp.status === 403 ? " — check CX_AGENT_API_KEY" : ""}`] };
      }
      const body = await resp.json() as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
      const list = Array.isArray(body) ? body : (body.data ?? []);
      const models = list.map((m) => m?.id).filter((id): id is string => typeof id === "string").sort();
      if (models.length === 0) {
        return { models: [], ready: false, diagnostics: [`GET ${url} returned no models — check the endpoint's model list`] };
      }
      return { models, ready: true, diagnostics: [] };
    } catch (e) {
      return {
        models: [], ready: false,
        diagnostics: [`GET ${url} failed: ${(e as Error)?.message ?? String(e)} — is the gateway running?`],
      };
    }
  }

  async connection(model: string): Promise<Connection> {
    const baseUrl = this.resolveBaseUrl();
    if (!baseUrl) throw new Error("CX_AGENT_BASE_URL is not set — configure the model gateway before delegating.");
    return { baseUrl, apiKey: this.resolveApiKey(), authMode: this.resolveAuthMode(), model };
  }
}

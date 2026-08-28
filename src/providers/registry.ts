/** Provider registry — resolves the configured ModelProvider. Ships one: the env-driven gateway. */

import type { ModelProvider } from "./types.js";
import { GatewayProvider, type GatewayOptions } from "./gateway.js";
import { resolveEnv } from "../config.js";

export type { ModelProvider, Catalog, Connection, AuthMode } from "./types.js";
export { GatewayProvider } from "./gateway.js";
export type { GatewayOptions, DiscoveryMode } from "./gateway.js";

export type ProviderName = "auto" | "gateway" | "openai-compatible" | "cx";

export interface ResolveOptions extends GatewayOptions {
  provider?: ProviderName;
}

/** v0.3 removed the built-in cx provider; this message tells cx users how to plug in instead. */
const CX_PROVIDER_REMOVED =
  "The built-in cx provider was removed in v0.3.0 — this package no longer knows about cx. " +
  "Point it at any Anthropic-compatible endpoint instead: CX_AGENT_BASE_URL (e.g. https://gateway.example.com), " +
  "CX_AGENT_API_KEY, and CX_AGENT_MODEL / CX_AGENT_MODELS.";

export function resolveProvider(opts: ResolveOptions = {}): ModelProvider {
  const raw = opts.provider ?? resolveEnv("CX_AGENT_PROVIDER") ?? "auto";
  const choice = raw.trim().toLowerCase();
  if (choice === "cx") throw new Error(CX_PROVIDER_REMOVED);
  if (choice === "auto" || choice === "gateway" || choice === "openai-compatible") {
    return new GatewayProvider(opts);
  }
  throw new Error(`Unknown CX_AGENT_PROVIDER "${raw}" — expected "gateway" or "auto".`);
}

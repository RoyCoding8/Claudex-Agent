/** Provider-neutral contract between model discovery and the agent runtime. */
export type AuthMode = "bearer" | "api-key";

export interface Connection {
  baseUrl: string;
  apiKey: string;
  authMode?: AuthMode;
  model: string;
  extraEnv?: Record<string, string>;
}

export interface Catalog {
  models: string[];
  ready: boolean;
  diagnostics: string[];
  source?: "models-endpoint" | "static" | "none";
  configuration?: "configured" | "missing" | "invalid";
}

export interface ModelProvider {
  readonly id: string;
  discover(model?: string): Promise<Catalog>;
  connection(model: string): Promise<Connection>;
}

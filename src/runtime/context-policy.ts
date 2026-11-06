import { z } from "zod";
import type { EngineName } from "./engine.js";
import { RequestError } from "../errors.js";

const tokens = z.number().int().positive();
export const contextPolicySchema = z.object({
  window_tokens: tokens.optional().describe("The model's real context capacity. This metadata cannot increase the endpoint's limit."),
  max_output_tokens: tokens.optional().describe("Maximum tokens requested for a model response."),
  compaction: z.object({
    enabled: z.boolean().optional(),
    trigger_tokens: tokens.optional().describe("Compact automatically when context usage exceeds this threshold."),
    keep_recent_tokens: z.number().int().nonnegative().optional().describe("Recent history to retain through native compaction."),
  }).strict().optional(),
}).strict();

export type ContextPolicy = z.infer<typeof contextPolicySchema>;
type PiContextPolicy = Required<Omit<ContextPolicy, "compaction">> & {
  compaction: Required<NonNullable<ContextPolicy["compaction"]>>;
};

export const CONTEXT_CONTROLS: Record<EngineName, readonly string[]> = {
  claude: ["window_tokens", "max_output_tokens", "compaction.enabled"],
  codex: ["window_tokens", "compaction.trigger_tokens"],
  pi: ["window_tokens", "max_output_tokens", "compaction.enabled", "compaction.trigger_tokens", "compaction.keep_recent_tokens"],
};

export class ContextPolicyError extends RequestError {
  constructor(readonly code: "INVALID_ARGUMENT" | "UNSUPPORTED_OPERATION", message: string) {
    super(code, message);
    this.name = "ContextPolicyError";
  }
}

export function parseContextPolicy(value: unknown): ContextPolicy | undefined {
  if (value === undefined) return undefined;
  const parsed = contextPolicySchema.safeParse(value);
  if (!parsed.success) throw new ContextPolicyError("INVALID_ARGUMENT", parsed.error.message);
  return parsed.data;
}

export function resolveContextPolicy(engine: "pi", requested?: ContextPolicy): PiContextPolicy;
export function resolveContextPolicy(engine: EngineName, requested?: ContextPolicy): ContextPolicy | undefined;
export function resolveContextPolicy(engine: EngineName, requested?: ContextPolicy): ContextPolicy | undefined {
  const policy = parseContextPolicy(requested) ?? {};
  const controls = new Set(CONTEXT_CONTROLS[engine]);
  const fields = [
    ["window_tokens", policy.window_tokens], ["max_output_tokens", policy.max_output_tokens],
    ["compaction.enabled", policy.compaction?.enabled], ["compaction.trigger_tokens", policy.compaction?.trigger_tokens],
    ["compaction.keep_recent_tokens", policy.compaction?.keep_recent_tokens],
  ] as const;
  const unsupported = fields.filter(([name, value]) => value !== undefined && !controls.has(name));
  if (unsupported.length) throw new ContextPolicyError("UNSUPPORTED_OPERATION", `${engine} does not expose context controls: ${unsupported.map(([name]) => name).join(", ")}`);
  if (engine !== "pi") {
    if (policy.window_tokens !== undefined && policy.max_output_tokens !== undefined && policy.max_output_tokens >= policy.window_tokens) {
      throw new ContextPolicyError("INVALID_ARGUMENT", "max_output_tokens must be smaller than window_tokens");
    }
    if (policy.window_tokens !== undefined && policy.compaction?.trigger_tokens !== undefined && policy.compaction.trigger_tokens >= policy.window_tokens) {
      throw new ContextPolicyError("INVALID_ARGUMENT", "compaction.trigger_tokens must be smaller than window_tokens");
    }
    return fields.some(([, value]) => value !== undefined) ? policy : undefined;
  }
  const window = policy.window_tokens ?? 128000;
  const output = policy.max_output_tokens ?? Math.min(8192, Math.max(1, Math.floor(window / 4)));
  const trigger = policy.compaction?.trigger_tokens ?? window - Math.max(output, Math.min(16384, Math.floor(window / 4)));
  const keep = policy.compaction?.keep_recent_tokens ?? Math.min(20000, Math.floor(trigger / 2));
  if (output >= window || trigger <= 0 || trigger > window - output || keep >= trigger) {
    throw new ContextPolicyError("INVALID_ARGUMENT", "Require max_output_tokens < window_tokens, trigger_tokens <= window_tokens - max_output_tokens, and keep_recent_tokens < trigger_tokens");
  }
  return { window_tokens: window, max_output_tokens: output, compaction: {
    enabled: policy.compaction?.enabled ?? true, trigger_tokens: trigger, keep_recent_tokens: keep,
  } };
}

export function mergeContextPolicy(base?: ContextPolicy, override?: ContextPolicy): ContextPolicy | undefined {
  if (!override) return base;
  return { ...base, ...override, ...(base?.compaction || override.compaction ? { compaction: { ...base?.compaction, ...override.compaction } } : {}) };
}

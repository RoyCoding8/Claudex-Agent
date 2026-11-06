import { resolve } from "node:path";
import { z } from "zod";
import type { EngineName } from "./runtime/engine.js";
import { RequestError } from "./errors.js";

export const accessPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("read-only"), report_path: z.string().trim().min(1).optional() }).strict(),
  z.object({ mode: z.literal("workspace-write") }).strict(),
]);

export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

export function resolveAccessPolicy(engine: EngineName, requested: unknown, cwd: string): AccessPolicy {
  const parsed = accessPolicySchema.safeParse(requested === undefined ? { mode: "workspace-write" } : requested);
  if (!parsed.success) throw new RequestError("INVALID_ARGUMENT", "access must be read-only with an optional report_path, or workspace-write without a report path.");
  const policy = parsed.data;
  switch (engine) {
    case "claude":
    case "codex":
    case "pi":
      return policy.mode === "read-only" && policy.report_path !== undefined
        ? { ...policy, report_path: resolve(cwd, policy.report_path) }
        : policy;
    default: {
      const exhaustive: never = engine;
      throw new Error(`Unknown access policy engine: ${exhaustive}`);
    }
  }
}

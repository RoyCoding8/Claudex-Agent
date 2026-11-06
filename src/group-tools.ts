import { z } from "zod";
import type { GroupCoordinator } from "./group-coordinator.js";
import { completionDelivery } from "./completion.js";
import { RequestError, structured } from "./errors.js";
import { runInputSchema, toStoreInput } from "./tools.js";

export const groupInputSchema = {
  action: z.enum(["create", "status", "wait_any"]),
  group_id: z.string().regex(/^g_[a-f0-9-]+$/).optional(),
  name: z.string().min(1).max(64).optional(),
  tasks: z.array(z.object({
    ...runInputSchema,
    name: z.string().min(1).max(64),
    depends_on: z.array(z.string().min(1).max(64)).max(64).optional(),
  }).omit({ background: true }).strict()).min(1).max(64).optional(),
  max_parallel: z.number().int().min(1).max(16).optional(),
  after_cursor: z.number().int().min(0).optional(),
  timeout_ms: z.number().int().min(0).max(30000).optional(),
};

export async function handleGroup(
  args: z.infer<z.ZodObject<typeof groupInputSchema>>,
  groups: GroupCoordinator, signal?: AbortSignal, hostAdapter = false,
) {
  try {
    let snapshot;
    if (args.action === "create") {
      if (!args.name || !args.tasks) throw new RequestError("INVALID_ARGUMENT", "create requires name and tasks.");
      snapshot = groups.create({ name: args.name, max_parallel: args.max_parallel,
        tasks: args.tasks.map((task) => ({ name: task.name, depends_on: task.depends_on, input: { prompt: task.prompt, ...toStoreInput(task) } })) });
    } else {
      if (!args.group_id) throw new RequestError("INVALID_ARGUMENT", "group_id is required.");
      snapshot = args.action === "wait_any"
        ? await groups.waitAny(args.group_id, args.after_cursor ?? 0, args.timeout_ms ?? 1000, signal)
        : groups.snapshot(args.group_id);
    }
    if (!snapshot) throw new RequestError("SESSION_NOT_FOUND", "No group with that ID.");
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...snapshot, completion_delivery: completionDelivery(hostAdapter) }) }] };
  } catch (error) {
    const code = error instanceof RequestError ? error.code : "INVALID_ARGUMENT";
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: structured(code, error instanceof Error ? error.message : String(error)) }) }], isError: true };
  }
}

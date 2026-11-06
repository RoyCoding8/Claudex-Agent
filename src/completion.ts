import type { SessionStore, Settlement } from "./session-store.js";
import type { JobOutput } from "./output.js";

export interface CompletionNotice {
  event_id: string;
  job_id: string;
  status: Settlement["result"]["status"];
  summary: string;
  needs_help: boolean;
  resumable: boolean;
  transcript_path: string;
  output?: JobOutput;
}

export function completionDelivery(hostAdapter = false) {
  return {
    parent_resume: hostAdapter,
    mode: hostAdapter ? "host-adapter" : "wait-only",
    fallback: "cx_agent_group action:wait_any or cx_agent_wait",
    limitation: hostAdapter
      ? "The host adapter must enqueue the parent continuation. Delivery is attempted once in this process; persisted job and group records remain authoritative."
      : "This MCP connection cannot enqueue a parent model turn. A background completion does not automatically resume the parent.",
  };
}

export function observeCompletions(
  store: SessionStore,
  enqueue: (notice: CompletionNotice) => void | Promise<void>,
  onError: () => void = () => {},
): () => void {
  return store.subscribe(async ({ job_id, result, background }) => {
    if (!background) return;
    try {
      await enqueue({
        event_id: `${job_id}:terminal`, job_id, status: result.status,
        summary: (result.result || result.error || result.status).slice(0, 1024),
        needs_help: result.status !== "completed", resumable: result.resumable,
        transcript_path: result.transcript_path,
        ...(result.output ? { output: result.output } : {}),
      });
    } catch { onError(); }
  });
}

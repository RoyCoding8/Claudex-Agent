// cx-agent progress — counter, heartbeat, event→summary.

export interface ProgressNotification {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export type ProgressSender = (n: ProgressNotification) => void;

export const HEARTBEAT_MS = 10_000;

export interface SdkMessageLike {
  type: string;
  subtype?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown; thinking?: string }>;
  summary?: string;
  status?: string | null;
  result?: string;
  errors?: string[];
}


export function describeToolTarget(_toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = obj[key];
    if (typeof v === "string") {
      const parts = v.replace(/\\/g, "/").split("/").filter(Boolean);
      return parts[parts.length - 1] ?? v;
    }
  }
  if (typeof obj.command === "string") {
    const first = obj.command.split("\n")[0]?.trim() ?? "";
    return first.slice(0, 40);
  }
  if (typeof obj.pattern === "string") return obj.pattern.slice(0, 30);
  return "";
}

export interface MessageSummary {
  text: string;
  turnInc: boolean;
}

/** Size only, never the words: progress notifications land directly in the caller's context,
 *  and reasoning is exactly the bulk that cx-agent exists to keep out of it. */
export function summarizeThinking(blocks: SdkMessageLike["content"]): string | null {
  const think = (blocks ?? []).filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
  if (think.length === 0) return null;
  const chars = think.reduce((n, b) => n + (b.thinking?.length ?? 0), 0);
  const redacted = think.filter((b) => b.type === "redacted_thinking").length;
  return `thinking · ${chars} chars${redacted > 0 ? ` · ${redacted} redacted` : ""}`;
}


export function summarizeMessage(msg: SdkMessageLike, turns: number): MessageSummary {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") return { text: "session started", turnInc: false };
      if (msg.subtype === "status") {
        if (msg.status === "compacting") return { text: "compacting context", turnInc: false };
        if (msg.status === "requesting") return { text: "requesting model", turnInc: false };
        return { text: "idle", turnInc: false };
      }
      if (msg.subtype === "api_retry") return { text: "api retry", turnInc: false };
      return { text: `system: ${msg.subtype ?? "unknown"}`, turnInc: false };

    case "assistant": {
      const blocks = msg.content ?? [];
      const think = summarizeThinking(blocks);
      const prefix = think ? `${think} · ` : "";
      const toolUse = blocks.find((b) => b.type === "tool_use");
      if (toolUse) {
        const name = toolUse.name ?? "tool";
        const target = describeToolTarget(name, toolUse.input);
        return {
          text: `turn ${turns + 1} · ${prefix}${name}${target ? " " + target : ""}`,
          turnInc: true,
        };
      }
      const text = blocks.find((b) => b.type === "text")?.text;
      if (text) return { text: `${prefix}assistant: ${text.slice(0, 60)}`, turnInc: false };
      return { text: think ?? "assistant turn", turnInc: false };
    }

    case "user":
      return { text: "tool result", turnInc: false };

    case "result": {
      if (msg.subtype === "success") return { text: "completed", turnInc: false };
      const errList = (msg.errors ?? []).join("; ");
      return { text: `failed: ${errList || msg.subtype || "error"}`, turnInc: false };
    }

    case "tool_use_summary":
      return { text: msg.summary ?? "tool summary", turnInc: false };

    default:
      return { text: msg.type, turnInc: false };
  }
}

/** Monotonic progress emitter with heartbeat. Bracket query loop with start/stopHeartbeat. */
export class ProgressEmitter {
  readonly progressToken: string | number;
  private readonly sender: ProgressSender;
  private counter = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSummary = "starting";
  private turns = 0;

  constructor(progressToken: string | number, sender: ProgressSender) {
    this.progressToken = progressToken;
    this.sender = sender;
  }

  /** Emit a progress notification with a strictly-increasing value. */
  emit(message: string): void {
    this.emitInternal(message, true);
  }

  private emitInternal(message: string, remember: boolean): void {
    this.counter += 1;
    if (remember) this.lastSummary = message;
    this.sender({ progressToken: this.progressToken, progress: this.counter, message });
  }

  /** Map an SDK message to a summary and emit it. */
  emitEvent(msg: SdkMessageLike): string {
    const { text, turnInc } = summarizeMessage(msg, this.turns);
    if (turnInc) this.turns += 1;
    this.emit(text);
    return text;
  }

  /** Start the heartbeat timer. */
  startHeartbeat(intervalMs: number = HEARTBEAT_MS): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.emitInternal(`still working · ${this.lastSummary}`, false);
    }, intervalMs);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }

  /** Stop the heartbeat. Safe to call multiple times. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  get turnCount(): number {
    return this.turns;
  }
}

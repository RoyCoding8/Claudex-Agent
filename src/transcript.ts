// cx-agent transcript — append-only JSONL + meta sidecar.

import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import type { ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { joinPath, resolveFs, jobStoreDir } from "./paths.js";
import { redactPayload } from "./retention.js";
import type { EffortLevel } from "./runtime/claude-sdk.js";

export type RecordKind =
  | "system"
  | "assistant"
  | "user"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "progress";

export interface TranscriptRecord {
  ts: string;
  job_id: string;
  seq: number;
  kind: RecordKind;
  payload: unknown;
}

export type JobStatus = "running" | "completed" | "failed" | "interrupted" | "incomplete";

export interface JobMeta {
  job_id: string;
  status: JobStatus;
  pool: string;
  pool_resolved: string[];
  cwd: string;
  started_at: string;
  ended_at: string | null;
  turns: number;
  error: string | null;
  result?: string | null;
  cx_agent_version?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  session_id?: string | null;
  files_changed?: string[];
  
  resumable?: boolean;
  
  resumed_from?: string | null;
  
  continuations?: number;
  
  agent?: string | null;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  max_turns?: number;
  timeout_ms?: number;
  max_budget_usd?: number;

  /** Reasoning config as sent to the SDK. Reasoning *text* stays in the JSONL — the sidecar is
   *  parsed for every job by cx_agent_list, so it must stay small. */
  thinking?: ThinkingConfig | null;
  effort?: EffortLevel | null;
}

export interface TranscriptOptions {
  root?: string;
}


export class Transcript {
  readonly jobId: string;
  readonly path: string;
  readonly metaPath: string;
  readonly dir: string;
  private readonly root: string;
  private readonly fsPath: string;
  private readonly fsMetaPath: string;
  private seq = 0;

  constructor(jobId: string, opts: TranscriptOptions = {}) {
    this.jobId = jobId;
    this.root = opts.root ?? jobStoreDir();
    this.path = joinPath(this.root, `${jobId}.jsonl`);
    this.metaPath = joinPath(this.root, `${jobId}.meta.json`);
    this.dir = this.root;
    this.fsPath = resolveFs(this.root, `${jobId}.jsonl`);
    this.fsMetaPath = resolveFs(this.root, `${jobId}.meta.json`);
    mkdirSync(resolveFs(this.root), { recursive: true });
  }

  /** Append one record. ENOENT is swallowed (teardown race). */
  append(kind: RecordKind, payload: unknown, ts: string = new Date().toISOString()): TranscriptRecord {
    this.seq += 1;
    const record: TranscriptRecord = {
      ts,
      job_id: this.jobId,
      seq: this.seq,
      kind,
      payload: redactPayload(payload),
    };
    try {
      appendFileSync(this.fsPath, JSON.stringify(record) + "\n", "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return record;
  }

  /** Write/overwrite the meta sidecar. */
  writeMeta(meta: JobMeta): void {
    try {
      writeFileSync(this.fsMetaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** Read the meta sidecar, or null if none exists. */
  readMeta(): JobMeta | null {
    if (!existsSync(this.fsMetaPath)) return null;
    try { return JSON.parse(readFileSync(this.fsMetaPath, "utf8")) as JobMeta; } catch { return null; }
  }

  /** Read all transcript records in order. */
  records(): TranscriptRecord[] {
    if (!existsSync(this.fsPath)) return [];
    const raw = readFileSync(this.fsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    return raw.map((l) => JSON.parse(l) as TranscriptRecord);
  }
}

/** Generate a timestamp-ish job id with random suffix. */
export function newJobId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { RequestError } from "./errors.js";
import type { JobStatus } from "./transcript.js";

export interface JobOutput {
  source_revision: string | null;
  source_dirty: boolean | null;
  outcome: Exclude<JobStatus, "running">;
  artifacts: { path: string; exists: boolean; bytes?: number; sha256?: string }[];
  unresolved_questions: string[] | null;
}

export function sourceRevision(cwd: string): Pick<JobOutput, "source_revision" | "source_dirty"> {
  const unknown = { source_revision: null, source_dirty: null };
  let dir = resolve(cwd);
  while (!existsSync(resolve(dir, ".git"))) {
    const parent = dirname(dir);
    if (parent === dir) return unknown;
    dir = parent;
  }
  try {
    const opts = { cwd, encoding: "utf8" as const, timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    const lines = execFileSync("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], opts).trim().split("\n");
    const revision = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13).trim();
    return { source_revision: revision && /^[a-f0-9]{40,64}$/.test(revision) ? revision : null,
      source_dirty: lines.some((line) => line.length > 0 && !line.startsWith("#")) };
  } catch { return unknown; }
}

export function pathKey(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

export function reportDestination(path: string, cwd: string, jobRoot: string): string {
  if (!path.trim()) throw new RequestError("INVALID_ARGUMENT", "report_path must be a file path.");
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const root = resolve(jobRoot);
  const inside = relative(root, target);
  if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    throw new RequestError("INVALID_ARGUMENT", "report_path cannot overlap job storage.");
  }
  if (existsSync(target)) throw new RequestError("INVALID_ARGUMENT", "report_path must name a new file; existing files are never overwritten.");
  let current = dirname(target);
  while (current !== parse(current).root) {
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      throw new RequestError("INVALID_ARGUMENT", "report_path requires existing directories without symlinks or junctions.");
    }
    current = dirname(current);
  }
  if (pathKey(realpathSync(dirname(target))) !== pathKey(dirname(target))) {
    throw new RequestError("INVALID_ARGUMENT", "report_path cannot traverse a redirected directory.");
  }
  return target;
}

export function publishReport(path: string, text: string, cwd: string, jobRoot: string): void {
  const target = reportDestination(path, cwd, jobRoot);
  const fd = openSync(target, "wx", 0o600);
  try { writeFileSync(fd, text, "utf8"); }
  finally { closeSync(fd); }
}

export function collectOutput(
  source: Pick<JobOutput, "source_revision" | "source_dirty">,
  outcome: JobOutput["outcome"], text: string, paths: string[], cwd: string,
): JobOutput {
  let questions: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "unresolved_questions" in parsed) {
      const value = parsed.unresolved_questions;
      if (Array.isArray(value) && value.length <= 32 && value.every((q): q is string => typeof q === "string" && q.length <= 1024)) questions = value;
    }
  } catch { }
  return {
    ...source, outcome, unresolved_questions: questions,
    artifacts: [...new Set(paths.map((path) => resolve(cwd, path)))].map((path) => {
      try {
        const info = statSync(path);
        if (!info.isFile()) return { path, exists: false };
        return { path, exists: true, bytes: info.size,
          ...(info.size <= 8 * 1024 * 1024 ? { sha256: createHash("sha256").update(readFileSync(path)).digest("hex") } : {}) };
      } catch { return { path, exists: false }; }
    }),
  };
}

// cx-agent Windows path helpers — display vs fs-safe.

import { resolve, normalize } from "node:path";
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, statSync } from "node:fs";

function statsOptional(p: string): boolean {
  try { return !!statSync(p); } catch { return false; }
}


export function toForward(p: string): string {
  return p.replace(/\\/g, "/");
}


export function joinPath(...segments: string[]): string {
  const norm = segments
    .filter((s) => s != null && s !== "")
    .map((s) => s.replace(/\\/g, "/"));
  let joined = norm.join("/");
  const isUnc = joined.startsWith("//");
  joined = joined.replace(/\/+/g, "/");
  if (isUnc && !joined.startsWith("//")) joined = "/" + joined;
  if (joined.startsWith("./")) joined = joined.slice(2);
  return joined;
}


export function resolveUnder(root: string, ...segments: string[]): string {
  return joinPath(root, ...segments);
}


export function joinFs(...segments: string[]): string {
  if (segments.length === 0) return ".";
  const root = segments[0]!.replace(/\\/g, "/");
  const rest = segments.slice(1).filter((s) => s != null && s !== "").map((s) => s.replace(/\\/g, "/"));
  const joined = [root, ...rest].join("/");
  return normalize(joined).replace(/\\/g, "/");
}


export function resolveFs(root: string, ...segments: string[]): string {
  const args = [root, ...segments.filter((s) => s != null && s !== "")];
  return resolve(...args).replace(/\\/g, "/");
}

const DATA_DIR_ENV = "CX_AGENT_DATA_DIR";
const APP_NAME = "cx-agent";
const AGENTS_SUBDIR = "agents";

function platformDataRoot(): string {
  if (process.env[DATA_DIR_ENV] && process.env[DATA_DIR_ENV]!.length > 0) {
    return resolveFs(process.env[DATA_DIR_ENV]!);
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local && local.length > 0) return resolveFs(local, APP_NAME);
    const userProfile = process.env.USERPROFILE;
    if (userProfile && userProfile.length > 0) return resolveFs(userProfile, "AppData", "Local", APP_NAME);
    return resolveFs(process.cwd(), "data");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return resolveFs(xdg, APP_NAME);
  const home = process.env.HOME;
  if (home && home.length > 0) return resolveFs(home, ".local", "share", APP_NAME);
  return resolveFs(process.cwd(), "data");
}


export function dataDir(): string {
  return platformDataRoot();
}


export function jobStoreDir(): string {
  return resolveFs(dataDir(), AGENTS_SUBDIR);
}

const MIGRATION_SENTINEL_ENV = "CX_AGENT_DATA_MIGRATED";
const MIGRATE_SUFFIXES = [".meta.json", ".jsonl"] as const;


function copyDirEntries(src: string, dst: string, suffixes: readonly string[]): string[] {
  if (!existsSync(src)) return [];
  mkdirSync(dst, { recursive: true });
  const copied: string[] = [];
  for (const f of readdirSync(src)) {
    if (!suffixes.some((s) => f.endsWith(s))) continue;
    const from = joinFs(src, f);
    const to = joinFs(dst, f);
    if (statsOptional(to)) { copied.push(f); continue; }
    try { copyFileSync(from, to); copied.push(f); } catch {  }
  }
  return copied;
}


let migratedThisProcess = false;


export function migrateLegacyJobStore(
  legacyRoot: string,
  opts: { force?: boolean; sentinelDir?: string; now?: number } = {},
): string[] | null {
  if (!opts.force && migratedThisProcess) return null;
  const target = jobStoreDir();
  const legacyAgents = joinFs(legacyRoot, "agents");
  if (!existsSync(legacyAgents)) {
    if (!opts.force) migratedThisProcess = true;
    return null;
  }
  const sentinelDir = opts.sentinelDir ?? target;
  mkdirSync(sentinelDir, { recursive: true });
  const sentinel = joinFs(sentinelDir, ".migrated");
  if (!opts.force && statsOptional(sentinel)) {
    migratedThisProcess = true;
    return null;
  }
  if (process.env[MIGRATION_SENTINEL_ENV] !== "1" && !opts.force) {
    const copied = copyDirEntries(legacyAgents, target, MIGRATE_SUFFIXES);
    try { writeFileSync(sentinel, String(opts.now ?? 0)); } catch {  }
    migratedThisProcess = true;
    return copied.length > 0 ? copied : [];
  }
  return null;
}

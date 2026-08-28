// cx-agent interrupt — AbortController + process-tree kill.

import { spawn } from "node:child_process";

export class InterruptError extends Error {
  constructor(
    message: string,
    readonly kind: "kill_failed" | "aborted" | "no_pid",
  ) {
    super(message);
    this.name = "InterruptError";
  }
}

export type TreeKiller = (pid: number) => Promise<void>;


export class InterruptHandle {
  readonly abortController: AbortController;
  readonly signal: AbortSignal;
  private pid: number | null = null;
  private killed = false;
  private killPromise: Promise<void> | null = null;
  private readonly killer: TreeKiller;
  private _reason: string | null = null;

  constructor(killer: TreeKiller = killProcessTree) {
    this.killer = killer;
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
  }

  
  setPid(pid: number): void {
    this.pid = pid;
  }

  get isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  get reason(): string | null {
    return this._reason;
  }

  
  cancel(reason = "interrupted"): Promise<void> {
    if (!this.abortController.signal.aborted) {
      this._reason = reason;
      this.abortController.abort(new InterruptError(reason, "aborted"));
    }
    if (this.pid == null || this.killed) return this.killPromise ?? Promise.resolve();
    this.killed = true;
    this.killPromise = this.killer(this.pid).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cx-agent] tree-kill failed for pid ${this.pid}: ${msg}`);
      return undefined;
    });
    return this.killPromise;
  }
}

/** Kill a process tree: taskkill /T /F on Windows, process-group SIGTERM→SIGKILL on POSIX.
 *  Resolves if the process is already gone. Never rejects — a kill failure is logged, not thrown. */
export function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") return killTreeWindows(pid);
  return killTreePosix(pid);
}

function killTreeWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", () => resolve());
    child.on("close", (code) => {
      if (code === 0 || /not found|no such|not running/i.test(stderr) || code == null) resolve();
      else resolve();
    });
  });
}

function killTreePosix(pid: number): Promise<void> {
  const GRACE_MS = 2000;
  return new Promise((resolve) => {
    const tryKill = (sig: NodeJS.Signals): boolean => {
      try { process.kill(-pid, sig); return true; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") { resolve(); return false; }
        try { process.kill(pid, sig); return true; }
        catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === "ESRCH") resolve();
          else resolve();
          return false;
        }
      }
    };
    if (!tryKill("SIGTERM")) return;
    const escalate = setTimeout(() => { tryKill("SIGKILL"); resolve(); }, GRACE_MS);
    if (typeof escalate.unref === "function") escalate.unref();
    const poll = setInterval(() => {
      try { process.kill(-pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          clearInterval(poll); clearTimeout(escalate); resolve();
        }
      }
    }, 200);
    if (typeof poll.unref === "function") poll.unref();
  });
}

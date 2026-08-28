import { describe, it, expect, vi } from "vitest";
import { InterruptHandle, InterruptError, killProcessTree } from "../src/interrupt.js";
import { spawn } from "node:child_process";

describe("InterruptHandle", () => {
  it("aborts the signal on cancel()", async () => {
    const h = new InterruptHandle(vi.fn().mockResolvedValue(undefined));
    expect(h.isAborted).toBe(false);
    await h.cancel("user stopped");
    expect(h.isAborted).toBe(true);
  });

        it("preserves the first cancellation reason", async () => {
    const h = new InterruptHandle(vi.fn().mockResolvedValue(undefined));
    expect(h.reason).toBeNull();
    await h.cancel("timeout");
    expect(h.reason).toBe("timeout");
    await h.cancel("later interrupt must not overwrite the terminal reason");
    expect(h.reason).toBe("timeout");
  });

  it("kills the registered pid via the injected killer", async () => {
    const killer = vi.fn().mockResolvedValue(undefined);
    const h = new InterruptHandle(killer);
    h.setPid(1234);
    await h.cancel();
    expect(killer).toHaveBeenCalledWith(1234);
  });

  it("does NOT kill if no pid was set", async () => {
    const killer = vi.fn().mockResolvedValue(undefined);
    const h = new InterruptHandle(killer);
    await h.cancel();
    expect(killer).not.toHaveBeenCalled();
  });

  it("is idempotent: second cancel returns the same promise, one kill", async () => {
    const killer = vi.fn().mockResolvedValue(undefined);
    const h = new InterruptHandle(killer);
    h.setPid(99);
    const p1 = h.cancel();
    const p2 = h.cancel();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(killer).toHaveBeenCalledTimes(1);
  });

  it("never throws even if the killer rejects", async () => {
    const killer = vi.fn().mockRejectedValue(new Error("access denied"));
    const h = new InterruptHandle(killer);
    h.setPid(7);
    await expect(h.cancel()).resolves.toBeUndefined();
    expect(h.isAborted).toBe(true);
  });

  it("setPid can update before cancel; last pid wins", async () => {
    const killer = vi.fn().mockResolvedValue(undefined);
    const h = new InterruptHandle(killer);
    h.setPid(1);
    h.setPid(2);
    await h.cancel();
    expect(killer).toHaveBeenCalledWith(2);
  });

  it("signal is usable as AbortSignal (e.g. for a fetch/abortable loop)", () => {
    const h = new InterruptHandle(vi.fn().mockResolvedValue(undefined));
    expect(h.signal.aborted).toBe(false);
        expect(h.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("InterruptError", () => {
  it("carries a kind", () => {
    const e = new InterruptError("boom", "kill_failed");
    expect(e.kind).toBe("kill_failed");
    expect(e.message).toBe("boom");
    expect(e.name).toBe("InterruptError");
  });
});

describe("killProcessTree", () => {
  it("resolves without throwing when the pid does not exist (ESRCH)", async () => {
    const bogusPid = 999999;
    await expect(killProcessTree(bogusPid)).resolves.toBeUndefined();
  });

  it("kills a real spawned child process", async () => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd" : "sleep", isWin ? ["/c", "ping -n 30 127.0.0.1 > nul"] : ["30"], {
      detached: !isWin,
      stdio: "ignore",
      windowsHide: true,
    });
    if (typeof child.pid !== "number") { child.kill(); return; }
    const pid = child.pid;
    await new Promise((r) => setTimeout(r, 300));
    await expect(killProcessTree(pid)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });
});

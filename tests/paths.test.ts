import { describe, it, expect } from "vitest";
import { toForward, joinPath, resolveUnder, joinFs, resolveFs } from "../src/paths.js";


describe("paths", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toForward("C:\\CLI\\cx\\data")).toBe("C:/CLI/cx/data");
    expect(toForward("C:/CLI/cx")).toBe("C:/CLI/cx");
  });

  it("joins segments without collapsing drive-letter separators", () => {
            expect(joinPath("C:\\CLI\\cx", ".venv", "Scripts", "python.exe")).toBe(
      "C:/CLI/cx/.venv/Scripts/python.exe",
    );
    expect(joinPath("C:/CLI/cx", "data", "agents")).toBe("C:/CLI/cx/data/agents");
  });

  it("resolves under a backslash root", () => {
    expect(resolveUnder("C:\\CLI\\cx", ".venv", "Scripts", "python.exe")).toBe(
      "C:/CLI/cx/.venv/Scripts/python.exe",
    );
  });

  it("collapses duplicate slashes and drops empty segments", () => {
    expect(joinPath("C:/CLI/cx/", "/", "data")).toBe("C:/CLI/cx/data");
    expect(joinPath("", "C:/CLI/cx", "data")).toBe("C:/CLI/cx/data");
  });

        it("joinPath keeps relative roots relative (does not promote ./data to /data)", () => {
    expect(joinPath("./data", "agents")).toBe("data/agents");
    expect(joinPath("data", "agents")).toBe("data/agents");
  });

  it("joinPath preserves a UNC share prefix", () => {
    expect(joinPath("\\\\server\\share", "x")).toBe("//server/share/x");
  });
});

describe("joinFs / resolveFs (filesystem-safe", () => {
      const cases: { name: string; args: string[]; wantContains: string; wantNot?: string }[] = [
    { name: "relative root stays relative", args: ["./data", "agents"], wantContains: "data/agents", wantNot: "/data" },
    { name: "relative root without marker", args: ["data", "agents"], wantContains: "data/agents" },
    { name: "drive root preserves separator", args: ["C:\\a", "b", "c"], wantContains: "C:/a/b/c" },
    { name: "UNC share preserved", args: ["\\\\server\\share", "x"], wantContains: "server/share/x" },
    { name: "normalize .. under drive root", args: ["C:\\a", "..", "b"], wantContains: "C:/b", wantNot: ".." },
    { name: "normalize ./ under relative root", args: ["./data", "./agents"], wantContains: "data/agents", wantNot: "./" },
    { name: "duplicate slashes collapse", args: ["C:/a/", "/", "b"], wantContains: "C:/a/b" },
    { name: "empty segments dropped", args: ["", "C:/a", "b"], wantContains: "C:/a/b" },
  ];

  for (const c of cases) {
    it(`joinFs: ${c.name}`, () => {
      const got = joinFs(...c.args);
      expect(got).toContain(c.wantContains);
      if (c.wantNot) expect(got).not.toContain(c.wantNot);
    });
  }

  it("resolveFs resolves a relative root against cwd to an absolute drive path", () => {
    const got = resolveFs("data", "agents");
    // On Windows this is <drive>:/.../data/agents; on POSIX /.../data/agents.
    // We only assert the tail + that it is absolute (starts with / or a drive).
    expect(got).toMatch(/[/:]/);
    expect(got.endsWith("data/agents") || got.endsWith("data\\agents")).toBe(true);
  });

  it("resolveFs preserves a drive root", () => {
    const got = resolveFs("C:\\CLI\\cx", ".venv", "Scripts", "python.exe");
    expect(got).toContain("C:/CLI/cx/.venv/Scripts/python.exe");
  });
});

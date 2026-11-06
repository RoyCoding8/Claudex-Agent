import { defineConfig } from "tsup";

// Match claude-code-mcp's build: single bundled ESM file at dist/index.js
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  // tsup preserves src/index.ts's shebang; do not add a duplicate banner.
  // Bundle everything except native node built-ins
  noExternal: [],
  splitting: false,
  sourcemap: false,
  clean: true,
  // The Claude Agent SDK ships its own types; don't try to typecheck during build
  // (tsc --noEmit is the dedicated typecheck script)
  dts: false,
});

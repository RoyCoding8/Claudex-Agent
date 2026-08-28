import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const required = ["CX_AGENT_BASE_URL", "CX_AGENT_API_KEY", "CX_AGENT_MODEL"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment: ${missing.join(", ")}`);
const root = mkdtempSync(join(tmpdir(), "cxagent-live-"));
const env = Object.fromEntries(Object.entries({ ...process.env, CX_AGENT_DATA_DIR: root }).filter((entry) => typeof entry[1] === "string"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  cwd: process.cwd(),
  env,
  stderr: "pipe",
});
const client = new Client({ name: "cx-agent-live-smoke", version: "1.0.0" });
const errors = [];
transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "cx_agent_run",
    arguments: {
      prompt: "Reply with exactly CX_AGENT_LIVE_OK. Do not use tools.",
      model: process.env.CX_AGENT_MODEL,
      allowed_tools: ["Read"],
      max_turns: 3,
      timeout_ms: 120000,
      auto_continue: 0,
    },
  });
  const block = response.content.find((item) => item.type === "text");
  const payload = block?.type === "text" ? JSON.parse(block.text) : null;
  if (payload?.result?.trim() !== "CX_AGENT_LIVE_OK") throw new Error(`Unexpected live result: ${JSON.stringify(payload)}`);
  process.stdout.write("Live endpoint smoke passed\n");
} catch (error) {
  if (errors.length) process.stderr.write(errors.join(""));
  throw error;
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const expected = [
  "cx_agent_check", "cx_agent_compact", "cx_agent_fetch", "cx_agent_interrupt", "cx_agent_list",
  "cx_agent_reply", "cx_agent_run", "cx_agent_session", "cx_agent_setup", "cx_agent_wait",
];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "cx-agent-smoke", version: "1.0.0" });
const errors = [];
transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
try {
  await client.connect(transport);
  const actual = (await client.listTools()).tools.map(({ name }) => name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${actual.join(", ")}`);
  process.stdout.write(`MCP smoke passed: ${actual.length} tools\n`);
} catch (error) {
  if (errors.length) process.stderr.write(errors.join(""));
  throw error;
} finally {
  await client.close();
}

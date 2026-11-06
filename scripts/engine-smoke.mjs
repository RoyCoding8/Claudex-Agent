import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await mkdtemp(join(tmpdir(), "cx-agent-engine-smoke-"));
const requests = [];
const sockets = new Set();
let release;
let requestArrived;
let requested = new Promise((resolve) => { requestArrived = resolve; });
let gate = new Promise((resolve) => { release = resolve; });
const gateway = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "cx-agent-smoke" }] }));
      return;
    }
    requests.push({ path: req.url, body, authenticated: req.headers.authorization === "Bearer local-smoke-key" });
    if (raw.includes("FORCE_GATEWAY_ERROR")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "deliberate authentication failure", type: "authentication_error" } }));
      return;
    }
    requestArrived();
    await gate;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (req.url === "/v1/responses") {
      const item = { id: "msg_smoke", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "engine-smoke-ok", annotations: [] }] };
      send({ type: "response.created", response: { id: "resp_smoke", status: "in_progress", output: [] } });
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "engine-smoke-ok" });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id: "resp_smoke", object: "response", status: "completed", model: "cx-agent-smoke", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    } else if (req.url === "/v1/chat/completions") {
      const base = { id: "chatcmpl_smoke", object: "chat.completion.chunk", created: 1, model: "cx-agent-smoke" };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "engine-smoke-ok" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: raw.includes("FORCE_TOKEN_LIMIT") ? "length" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.write("data: [DONE]\n\n");
    } else {
      throw new Error(`Unexpected gateway path ${req.url}`);
    }
    res.end();
  } catch (error) { res.destroy(error); }
});
gateway.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const address = gateway.address();
assert.ok(address && typeof address !== "string");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("CX_AGENT_"))),
    ...(process.env.CX_AGENT_CODEX_PATH ? { CX_AGENT_CODEX_PATH: process.env.CX_AGENT_CODEX_PATH } : {}),
    CX_AGENT_BASE_URL: `http://127.0.0.1:${address.port}`,
    CX_AGENT_API_KEY: "local-smoke-key",
    CX_AGENT_AUTH_MODE: "bearer",
    CX_AGENT_MODEL: "cx-agent-smoke",
    CX_AGENT_DISCOVERY: "none",
    CX_AGENT_DATA_DIR: root,
    CX_AGENT_TIMEOUT_MS: "25000",
  },
  stderr: "pipe",
});
const errors = [];
transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
const client = new Client({ name: "engine-smoke", version: "1" });
const jobIds = new Set();
async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 35_000 });
  const block = result.content.find((item) => item.type === "text");
  assert.equal(block?.type, "text");
  const envelope = JSON.parse(block.text);
  if (["cx_agent_run", "cx_agent_reply", "cx_agent_compact"].includes(name) && envelope.job_id) jobIds.add(envelope.job_id);
  assert.equal(Boolean(result.isError), expectError, JSON.stringify(envelope));
  return envelope;
}
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No gateway request arrived")), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  await client.connect(transport);
  const engines = process.argv.slice(2);
  for (const engine of engines.length ? engines : ["codex", "pi"]) {
    const count = requests.length;
    gate = new Promise((resolve) => { release = resolve; });
    requested = new Promise((resolve) => { requestArrived = resolve; });
    const context = engine === "pi"
      ? { window_tokens: 65536, max_output_tokens: 1024, compaction: { enabled: true, trigger_tokens: 50000, keep_recent_tokens: 10000 } }
      : { window_tokens: 64000, compaction: { trigger_tokens: 48000 } };
    const started = await call("cx_agent_run", { engine, context, prompt: "Return engine-smoke-ok without using tools.", background: true, cwd: root });
    assert.equal(started.status, "running");
    await within(requested, 15000);
    const pending = await call("cx_agent_wait", { job_id: started.job_id, timeout_ms: 0 });
    assert.equal(pending.status, "running");
    release();
    const completed = await call("cx_agent_wait", { job_id: started.job_id, timeout_ms: 30000 });
    assert.equal(completed.result, "engine-smoke-ok");
    const resumed = await call("cx_agent_reply", { job_id: started.job_id, prompt: "Return engine-smoke-ok again without using tools." + (engine === "pi" ? " context to summarize".repeat(5000) : ""), background: true });
    const result = await call("cx_agent_wait", { job_id: resumed.job_id, timeout_ms: 30000 });
    assert.equal(result.result, "engine-smoke-ok");
    const settings = await call("cx_agent_fetch", { job_id: resumed.job_id, fields: ["context"] });
    assert.deepEqual(settings.context, context, `${engine} resume must inherit context controls`);
    const sent = requests.slice(count);
    assert.ok(sent.length >= 2, `${engine} must make fresh and resumed requests`);
    assert.ok(sent.every(({ body, authenticated }) => body.model === "cx-agent-smoke" && authenticated), `${engine} must use the configured model and credential`);
    assert.ok(JSON.stringify(sent.at(-1).body).includes("Return engine-smoke-ok without using tools."), `${engine} resume must retain the first user turn`);
    if (engine === "pi") {
      assert.ok(sent.every(({ body }) => (body.max_tokens ?? body.max_completion_tokens) === 1024), "Pi must apply the configured output limit to native SDK requests");
      const source = await call("cx_agent_fetch", { job_id: resumed.job_id, fields: ["session_id"] });
      const fork = await call("cx_agent_reply", { job_id: resumed.job_id, prompt: "Return engine-smoke-ok on this fork.", fork: true, background: true });
      const forked = await call("cx_agent_wait", { job_id: fork.job_id, timeout_ms: 30000 });
      assert.equal(forked.result, "engine-smoke-ok");
      const forkSession = await call("cx_agent_fetch", { job_id: fork.job_id, fields: ["session_id"] });
      assert.notEqual(forkSession.session_id, source.session_id, "Pi fork must create a distinct native session");
      const compacting = await call("cx_agent_compact", { job_id: resumed.job_id, background: true });
      const compacted = await call("cx_agent_wait", { job_id: compacting.job_id, timeout_ms: 30000 });
      assert.equal(compacted.result, "engine-smoke-ok");
      const limited = await call("cx_agent_run", { engine, prompt: "FORCE_TOKEN_LIMIT", background: true, cwd: root });
      const partial = await call("cx_agent_wait", { job_id: limited.job_id, timeout_ms: 30000 }, true);
      assert.equal(partial.status, "incomplete");
      assert.equal(partial.resumable, true);
      assert.equal(partial.result, "engine-smoke-ok");
    }
    const failing = await call("cx_agent_run", { engine, prompt: "FORCE_GATEWAY_ERROR", background: true, cwd: root });
    const failed = await call("cx_agent_wait", { job_id: failing.job_id, timeout_ms: 30000 }, true);
    assert.equal(failed.status, "failed");
    console.log(`${engine} SDK smoke passed: background return, bounded wait, custom gateway, model, credential, native resume${engine === "pi" ? ", fork, compaction, resumable token limit" : ""}, gateway failure.`);
  }
} catch (error) {
  if (errors.length) process.stderr.write(errors.join(""));
  throw error;
} finally {
  release();
  await Promise.allSettled([...jobIds].map((job_id) => client.callTool({ name: "cx_agent_session", arguments: { action: "cancel", job_id } }, undefined, { timeout: 5000 })));
  await client.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => gateway.close(resolve));
  await rm(root, { recursive: true, force: true });
}

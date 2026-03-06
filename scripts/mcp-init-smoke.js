const { spawn } = require("child_process");
const path = require("path");

const SERVER_PATH = path.resolve(__dirname, "..", "mcp-server.js");
const TIMEOUT_MS = 8000;
const EXPECTED_TOOLS = ["ancestor_stats", "find_ancestors"];

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function pass(message) {
  console.log(`OK ${message}`);
  process.exit(0);
}

const child = spawn(process.execPath, [SERVER_PATH], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = Buffer.alloc(0);
let stderrText = "";
let settled = false;
let initialized = false;

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill("SIGKILL");
  fail("Timed out waiting for MCP initialize response", stderrText.trim());
}, TIMEOUT_MS);

function cleanup() {
  clearTimeout(timeout);
  if (!child.killed) child.kill("SIGTERM");
}

function sendRequest(id, method, params = {}) {
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const framed = `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`;
  child.stdin.write(framed);
}

function handleRpcMessage(msg, rawPayload) {
  if (msg?.jsonrpc !== "2.0") {
    settled = true;
    cleanup();
    fail("Invalid JSON-RPC version in response", rawPayload);
    return;
  }

  if (msg?.error) {
    settled = true;
    cleanup();
    fail("Server returned JSON-RPC error", JSON.stringify(msg.error));
    return;
  }

  if (msg.id === 1) {
    const protocolVersion = msg?.result?.protocolVersion;
    const serverName = msg?.result?.serverInfo?.name;
    if (!protocolVersion || !serverName) {
      settled = true;
      cleanup();
      fail("Initialize response missing expected fields", rawPayload);
      return;
    }

    initialized = true;
    sendRequest(2, "tools/list", {});
    return;
  }

  if (msg.id === 2) {
    if (!initialized) {
      settled = true;
      cleanup();
      fail("Received tools/list response before initialize completed", rawPayload);
      return;
    }

    const tools = msg?.result?.tools;
    if (!Array.isArray(tools)) {
      settled = true;
      cleanup();
      fail("tools/list response missing tools array", rawPayload);
      return;
    }

    const names = new Set(tools.map((tool) => tool?.name).filter(Boolean));
    const missing = EXPECTED_TOOLS.filter((toolName) => !names.has(toolName));
    if (missing.length) {
      settled = true;
      cleanup();
      fail(`tools/list missing expected tools: ${missing.join(", ")}`, rawPayload);
      return;
    }

    settled = true;
    cleanup();
    pass(`MCP handshake + tools/list OK (${tools.length} tools)`);
  }
}

function tryParseResponses() {
  while (true) {
    const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = stdoutBuffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/content-length\s*:\s*(\d+)/i);
    if (!match) {
      settled = true;
      cleanup();
      fail("Response missing Content-Length header", header);
      return;
    }

    const len = parseInt(match[1], 10);
    const payloadStart = headerEnd + 4;
    const payloadEnd = payloadStart + len;
    if (stdoutBuffer.length < payloadEnd) return;

    const payload = stdoutBuffer.slice(payloadStart, payloadEnd).toString("utf8");
    stdoutBuffer = stdoutBuffer.slice(payloadEnd);

    let msg;
    try {
      msg = JSON.parse(payload);
    } catch (err) {
      settled = true;
      cleanup();
      fail("Response payload is not valid JSON", String(err));
      return;
    }

    handleRpcMessage(msg, payload);
    if (settled) return;
  }
}

child.stdout.on("data", (chunk) => {
  if (settled) return;
  stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
  tryParseResponses();
});

child.stderr.on("data", (chunk) => {
  stderrText += chunk.toString("utf8");
});

child.on("error", (err) => {
  if (settled) return;
  settled = true;
  cleanup();
  fail("Failed to launch MCP server", String(err));
});

child.on("exit", (code) => {
  if (settled) return;
  settled = true;
  cleanup();
  fail(`MCP server exited before handshake (code ${code})`, stderrText.trim());
});

const initMessage = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {},
});

const framed = `Content-Length: ${Buffer.byteLength(initMessage, "utf8")}\r\n\r\n${initMessage}`;
child.stdin.write(framed);

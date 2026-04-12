#!/usr/bin/env node
/**
 * Test script for --tunnel feature.
 *
 * Phase 1: Local-only test (no auth required)
 *   - Starts stdio-to-ws with a simple echo process
 *   - Connects via local WebSocket
 *   - Verifies round-trip messaging
 *
 * Phase 2: Tunnel test (requires GitHub auth)
 *   - Starts stdio-to-ws with --tunnel
 *   - Waits for tunnel URL to appear in output
 *   - Connects to the tunnel URL via wss://
 *   - Verifies round-trip messaging through the tunnel
 *
 * Usage:
 *   node test-tunnel.mjs              # Run both phases
 *   node test-tunnel.mjs --local-only # Run Phase 1 only (no auth needed)
 *   node test-tunnel.mjs --tunnel-only # Run Phase 2 only
 */

import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 9877;
const localOnly = process.argv.includes("--local-only");
const tunnelOnly = process.argv.includes("--tunnel-only");

function waitForOutput(proc, pattern, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for pattern: ${pattern}\nOutput so far:\n${output}`));
    }, timeoutMs);

    const onData = (data) => {
      const text = data.toString();
      output += text;
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        proc.stdout.removeListener("data", onData);
        proc.stderr.removeListener("data", onData);
        resolve(match);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
  });
}

function connectWs(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout connecting to ${url}`));
    }, timeoutMs);

    const ws = new WebSocket(url);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendAndExpectEcho(ws, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for echo of: ${message}`));
    }, timeoutMs);

    const handler = (data) => {
      const text = data.toString();
      if (text.includes(message)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(text);
      }
    };
    ws.on("message", handler);
    ws.send(message);
  });
}

// ─── Phase 1: Local WebSocket test ───

async function testLocal() {
  console.log("═══════════════════════════════════════");
  console.log("Phase 1: Local WebSocket (no tunnel)");
  console.log("═══════════════════════════════════════\n");

  const server = spawn("node", ["dist/main.js", "-p", String(PORT), "cat"], {
    stdio: "pipe",
  });
  server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

  try {
    // Wait for server to start
    await waitForOutput(server, /WebSocket server listening/);
    console.log("  ✓ Server started on port", PORT);

    // Connect
    const ws = await connectWs(`ws://localhost:${PORT}`);
    console.log("  ✓ WebSocket connected");

    // Echo test
    const echo = await sendAndExpectEcho(ws, "hello from test");
    console.log("  ✓ Echo received:", JSON.stringify(echo));

    // JSON-RPC style message (like ACP)
    const rpcMsg = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
    const rpcEcho = await sendAndExpectEcho(ws, rpcMsg);
    const parsed = JSON.parse(rpcEcho);
    if (parsed.method === "initialize") {
      console.log("  ✓ JSON-RPC message round-trip works");
    }

    ws.close();
    console.log("\n  Phase 1: PASSED ✓\n");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── Phase 2: Tunnel test ───

async function testTunnel() {
  console.log("═══════════════════════════════════════");
  console.log("Phase 2: Dev Tunnel (wss://)");
  console.log("═══════════════════════════════════════\n");

  const server = spawn(
    "node",
    ["dist/main.js", "-p", String(PORT), "--tunnel", "cat"],
    { stdio: "pipe" },
  );

  let allOutput = "";
  server.stdout.on("data", (d) => {
    allOutput += d.toString();
    process.stdout.write(`  [server] ${d}`);
  });
  server.stderr.on("data", (d) => {
    allOutput += d.toString();
    process.stderr.write(`  [server] ${d}`);
  });

  try {
    // Wait for tunnel URL
    console.log("  Waiting for tunnel URL (may require GitHub auth)...\n");
    const match = await waitForOutput(
      server,
      /Tunnel URL: (https:\/\/[^\s]+)/,
      120000, // 2 min timeout for auth
    );
    const tunnelUrl = match[1];
    console.log(`\n  ✓ Tunnel URL: ${tunnelUrl}`);

    // Convert https:// to wss:// for WebSocket
    const wsUrl = tunnelUrl.replace(/^https:/, "wss:");
    console.log(`  Connecting to ${wsUrl} ...`);

    // Connect via tunnel
    const ws = await connectWs(wsUrl, 30000);
    console.log("  ✓ WebSocket connected through tunnel");

    // Echo test through tunnel
    const echo = await sendAndExpectEcho(ws, "hello via tunnel", 10000);
    console.log("  ✓ Echo received through tunnel:", JSON.stringify(echo));

    // JSON-RPC test through tunnel
    const rpcMsg = JSON.stringify({ jsonrpc: "2.0", method: "test/ping", id: 42 });
    const rpcEcho = await sendAndExpectEcho(ws, rpcMsg, 10000);
    const parsed = JSON.parse(rpcEcho);
    if (parsed.method === "test/ping" && parsed.id === 42) {
      console.log("  ✓ JSON-RPC round-trip through tunnel works");
    }

    ws.close();
    console.log("\n  Phase 2: PASSED ✓\n");
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Main ───

async function main() {
  try {
    if (!tunnelOnly) {
      await testLocal();
    }
    if (!localOnly) {
      await testTunnel();
    }
    console.log("═══════════════════════════════════════");
    console.log("All tests passed! ✓");
    console.log("═══════════════════════════════════════");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ Test failed:", err.message);
    process.exit(1);
  }
}

main();

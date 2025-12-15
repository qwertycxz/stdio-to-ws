#!/usr/bin/env node
/**
 * Manual test script for persistence feature.
 * Run: node test-persistence.mjs
 */

import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 3457;

console.log("Starting server with persistence...");
const server = spawn("node", ["dist/main.js", "-p", String(PORT), "--persist", "--grace-period", "5000", "cat"], {
  stdio: "pipe",
});

server.stdout.on("data", (d) => process.stdout.write(d));
server.stderr.on("data", (d) => process.stderr.write(d));

// Wait for server to start
await new Promise((r) => setTimeout(r, 1500));

let clientId = null;

// Test 1: New connection
console.log("\n--- Test 1: New connection ---");
const ws1 = new WebSocket(`ws://localhost:${PORT}`);

await new Promise((resolve, reject) => {
  ws1.on("open", () => console.log("Connected"));
  ws1.on("message", (data) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      console.log("Received:", msg);
      if (msg.type === "connected") {
        clientId = msg.clientId;
        console.log("✓ Got clientId:", clientId);
        resolve();
      }
    } catch {
      // Not JSON, ignore
    }
  });
  ws1.on("error", reject);
  setTimeout(() => reject(new Error("Timeout waiting for connection")), 5000);
});

// Test 2: Send a message
console.log("\n--- Test 2: Echo test ---");
ws1.send("hello");
await new Promise((resolve, reject) => {
  ws1.once("message", (data) => {
    const text = data.toString();
    console.log("Echo received:", text);
    console.log("✓ Echo works");
    resolve();
  });
  setTimeout(() => reject(new Error("Timeout waiting for echo")), 5000);
});

// Test 3: Disconnect and reconnect
console.log("\n--- Test 3: Reconnection ---");
ws1.close();
console.log("Disconnected, waiting 2s...");
await new Promise((r) => setTimeout(r, 2000));

const ws2 = new WebSocket(`ws://localhost:${PORT}`, {
  headers: { "X-Client-Id": clientId },
});

await new Promise((resolve, reject) => {
  ws2.on("open", () => console.log("Reconnected"));
  ws2.on("message", (data) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      console.log("Received:", msg);
      if (msg.type === "reconnect" && msg.clientId === clientId) {
        console.log("✓ Reconnected to same session");
        resolve();
      }
    } catch {
      // Not JSON, ignore
    }
  });
  ws2.on("error", reject);
  setTimeout(() => reject(new Error("Timeout waiting for reconnect")), 5000);
});

// Cleanup
ws2.close();
server.kill();
console.log("\n✓ All tests passed!");
process.exit(0);

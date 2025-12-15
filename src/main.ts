#!/usr/bin/env node
import minimist from "minimist";
import { parseArgsStringToArgv } from "string-argv";
import { startWebSocketServer } from "./stdio-to-ws.js";

const argv = minimist(process.argv.slice(2), {
  alias: { p: "port", h: "help", q: "quiet", g: "grace-period" },
  default: { port: 3000, "grace-period": 30000 },
  boolean: ["quiet", "persist"],
});

if (argv.help) {
  console.log(`
Usage: stdio-to-ws [options] <command>

Options:
  -p, --port <port>           Port to listen on (default: 3000)
  --persist                   Enable process persistence for reconnections
  -g, --grace-period <ms>     Grace period before killing child process on disconnect (default: 30000, requires --persist)
  -q, --quiet                 Suppress logging output
  -h, --help                  Show this help message

Example:
  stdio-to-ws -p 8080 "python my-script.py"
  stdio-to-ws --persist --grace-period 60000 "python my-script.py"
  stdio-to-ws --quiet "python my-script.py"
  `);
  process.exit(0);
}

const [cmd] = argv._;

if (!cmd) {
  console.error("No command provided.");
  process.exit(1);
}

void startWebSocketServer({
  command: parseArgsStringToArgv(cmd),
  port: argv.port,
  quiet: argv.quiet,
  persist: argv.persist,
  gracePeriodMs: argv["grace-period"],
});

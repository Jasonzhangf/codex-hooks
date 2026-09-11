#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { installFromSource } from "../src/install.js";

const options = parseArgs(process.argv.slice(2));
const record = installFromSource({
  sourceRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  codexHome: options.codexHome,
  binDir: options.binDir,
  endpoint: options.endpoint,
  stopHookEnabled: options.stopHookEnabled,
  supervisorEnabled: options.supervisorEnabled,
  codexappCommand: options.codexappCommand,
  codexappArgs: options.codexappArgs,
});
process.stdout.write(`${JSON.stringify({ initialized: true, ...record })}\n`);

function parseArgs(args) {
  const options = { stopHookEnabled: true };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (["--endpoint", "--codex-home", "--bin-dir", "--codexapp-command", "--codexapp-args"].includes(value)) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      const key = { "--endpoint": "endpoint", "--codex-home": "codexHome", "--bin-dir": "binDir", "--codexapp-command": "codexappCommand", "--codexapp-args": "codexappArgs" }[value];
      options[key] = value === "--codexapp-args" ? JSON.parse(next) : next;
      index += 1;
    } else if (value === "--disable-stop-hook") {
      options.stopHookEnabled = false;
    } else if (value === "--enable-stop-hook") {
      options.stopHookEnabled = true;
    } else if (value === "--enable-supervisor") {
      options.supervisorEnabled = true;
    } else if (value === "--disable-supervisor") {
      options.supervisorEnabled = false;
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return options;
}

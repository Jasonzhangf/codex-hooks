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
});
process.stdout.write(`${JSON.stringify({ initialized: true, ...record })}\n`);

function parseArgs(args) {
  const options = { stopHookEnabled: true };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (["--endpoint", "--codex-home", "--bin-dir"].includes(value)) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      options[{ "--endpoint": "endpoint", "--codex-home": "codexHome", "--bin-dir": "binDir" }[value]] = next;
      index += 1;
    } else if (value === "--disable-stop-hook") {
      options.stopHookEnabled = false;
    } else if (value === "--enable-stop-hook") {
      options.stopHookEnabled = true;
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return options;
}

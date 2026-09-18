import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("rccs command help exits without daemon access or mutation", async () => {
  const cases = [
    { args: ["--help"], expected: "rccs init" },
    { args: ["schedule", "--help"], expected: "rccs schedule add <id> <at> <body>" },
    { args: ["wait", "--help"], expected: "rccs wait <duration> [body]" },
    { args: ["subagent", "--help"], expected: "rccs subagent create <prompt>" },
    { args: ["mcp", "--help"], expected: "rccs mcp register" },
    { args: ["session", "--help"], expected: "rccs session bind" },
    { args: ["config", "--help"], expected: "rccs config set <key> <value>" },
    { args: ["hook", "--help"], expected: "rccs hook enable stop" },
    { args: ["supervisor", "--help"], expected: "rccs supervisor enable" },
    { args: ["operator", "--help"], expected: "rccs operator enable <name>" },
    { args: ["longhorizon", "--help"], expected: "rccs longhorizon register <id>" },
    { args: ["snapshot", "--help"], expected: "rccs snapshot backup" },
  ];

  for (const entry of cases) {
    const result = await runCli(entry.args, {
      ROUTECODEX_HOOKS_ENDPOINT: "http://127.0.0.1:1",
    });
    assert.equal(result.code, 0, `${entry.args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(escapeRegExp(entry.expected)));
    assert.equal(result.stderr, "");
  }
});

test("rccs help documents defaults and state semantics", async () => {
  const schedule = await runCli(["schedule", "--help"]);
  assert.equal(schedule.code, 0, schedule.stderr);
  for (const expected of [
    "notify schedules require --session and reject --target",
    "subagent schedules require --target and --action subagent",
    "default idle_only",
    "default defer",
    "default notify",
    "optional assertion; subagent schedules always use an ephemeral thread",
    "--once and --every are mutually exclusive",
    "stop is terminal",
  ]) {
    assert.match(schedule.stdout, new RegExp(escapeRegExp(expected)));
  }

  const wait = await runCli(["wait", "--help"]);
  assert.equal(wait.code, 0, wait.stderr);
  assert.match(wait.stdout, /async default idle_only/);
  assert.match(wait.stdout, /blocking default working_allowed/);
  assert.match(wait.stdout, /wait is one-shot/);

  const subagent = await runCli(["subagent", "--help"]);
  assert.equal(subagent.code, 0, subagent.stderr);
  assert.doesNotMatch(subagent.stdout, /--profile/);
  assert.match(subagent.stdout, /turn\/interrupt only/);

  const mcp = await runCli(["mcp", "--help"]);
  assert.equal(mcp.code, 0, mcp.stderr);
  assert.match(mcp.stdout, /MCP is read-only/);

  const longhorizon = await runCli(["longhorizon", "--help"]);
  assert.equal(longhorizon.code, 0, longhorizon.stderr);
  assert.match(longhorizon.stdout, /--mode periodic\|goal/);
  assert.match(longhorizon.stdout, /--review-budget/);
  assert.match(longhorizon.stdout, /active on registration/);
  assert.match(longhorizon.stdout, /liveness check after 60 seconds/);

  const snapshot = await runCli(["snapshot", "--help"]);
  assert.equal(snapshot.code, 0, snapshot.stderr);
  assert.match(snapshot.stdout, /rccs-recover/);
  assert.match(snapshot.stdout, /config\.toml/);
});

test("rccs validates action-specific schedule selectors before mutation", async () => {
  const targetOnlyNotify = await runCli([
    "schedule",
    "add",
    "bad-notify",
    "2026-09-16T12:00:00Z",
    "body",
    "--target",
    "codex_tui/tui-appserver",
  ], {
    ROUTECODEX_HOOKS_ENDPOINT: "http://127.0.0.1:1",
  });
  assert.notEqual(targetOnlyNotify.code, 0);
  assert.match(targetOnlyNotify.stderr, /--session is required for action=notify/);

  const sessionSubagent = await runCli([
    "schedule",
    "add",
    "bad-subagent",
    "2026-09-16T12:00:00Z",
    "body",
    "--action",
    "subagent",
    "--session",
    "work",
  ], {
    ROUTECODEX_HOOKS_ENDPOINT: "http://127.0.0.1:1",
  });
  assert.notEqual(sessionSubagent.code, 0);
  assert.match(sessionSubagent.stderr, /--target is required when --action subagent/);
});

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

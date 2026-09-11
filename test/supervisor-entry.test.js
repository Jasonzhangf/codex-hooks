import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const codexappSource = [
  "const fs=require('fs'),net=require('net');",
  "const socket=process.argv[1];",
  "try{fs.unlinkSync(socket)}catch{}",
  "const server=net.createServer((client)=>{let buffer='';client.setEncoding('utf8');client.on('data',(chunk)=>{buffer+=chunk;const i=buffer.indexOf('\\n');if(i<0)return;const request=JSON.parse(buffer.slice(0,i));let result;",
  "if(request.method==='capabilities')result={protocol:'codex-comm/v1',query:['session_status'],execution:['send'],namespaces:['codex_tui']};",
  "else if(request.method==='status')result={protocol:'codex-comm/v1',bridge:'up',scopes:[{scopeId:'local:hooks',appserverId:'hooks-appserver',namespace:'codex_tui',sessions:[{id:'hooksd'}],agents:[{sessionId:'hooksd',live:true}],capabilities:['send_message_to_thread']},{scopeId:'local:tui',appserverId:'tui-appserver',namespace:'codex_tui',sessions:[{id:'target'}],agents:[],capabilities:['send_message_to_thread']}]};",
  "else if(request.method==='session_status')result={status:{state:'idle'},scopeId:request.params.address.scopeId,namespace:'codex_tui',appserverId:'tui-appserver',address:request.params.address};",
  "else result={messageId:request.params.messageId,attemptId:request.params.attemptId,from:request.params.from,to:request.params.to,routing:{requestedTo:request.params.to,routedTo:request.params.to},state:'accepted'};",
  "client.write(JSON.stringify({id:request.id,result})+'\\n');});});",
  "server.listen(socket,()=>console.log(JSON.stringify({ready:true})));",
  "process.once('SIGTERM',()=>server.close(()=>process.exit(0)));",
].join("");

test("installed supervisor starts codexapp before hooksd and exits cleanly in reverse order", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-hooks-supervisor-"));
  const socket = join(root, "codexapp.sock");
  const configPath = join(root, "hooksd.json");
  const idleChild = "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000);";
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: join(root, "state") },
    codexapp: {
      socket,
      required_capabilities: ["session_status", "send_message_to_thread"],
      source_address: { scopeId: "local:hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    },
    policies: [],
    supervisor: {
      enabled: true,
      startup_timeout_ms: 5000,
      codexapp: { command: process.execPath, args: ["-e", codexappSource, socket] },
      hooksd: { command: process.execPath, args: ["-e", idleChild] },
    },
  }) + "\n");
  const child = spawn(process.execPath, ["src/supervisor-entry.js", "--config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const ready = JSON.parse(await readLine(child.stdout));
    assert.deepEqual(ready, { protocol: "routecodex-hooks-supervisor/v1", ready: true, state: "ready" });
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("installed supervisor cleans a child that fails readiness before handle registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-hooks-supervisor-failed-ready-"));
  const pidFile = join(root, "codexapp.pid");
  const configPath = join(root, "hooksd.json");
  const codexappSource = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));console.log(JSON.stringify({ready:false}));setInterval(()=>{},1000);`;
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: join(root, "state") },
    codexapp: {
      socket: join(root, "codexapp.sock"),
      required_capabilities: ["session_status", "send_message_to_thread"],
      source_address: { scopeId: "local:hooks", sessionId: "hooksd" },
      target_scopes: {},
    },
    policies: [],
    supervisor: {
      enabled: true,
      startup_timeout_ms: 5000,
      codexapp: { command: process.execPath, args: ["-e", codexappSource] },
      hooksd: { command: process.execPath, args: ["-e", "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000);"] },
    },
  }) + "\n");
  const child = spawn(process.execPath, ["src/supervisor-entry.js", "--config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      stream.off("data", onData);
      resolve(buffer.slice(0, index));
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

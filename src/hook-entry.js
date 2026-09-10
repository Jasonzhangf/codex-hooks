#!/usr/bin/env node

const input = await readStdin();
const endpoint = process.env.ROUTECODEX_HOOKS_ENDPOINT || "http://127.0.0.1:8787";
const kindIndex = process.argv.indexOf("--kind");
const kind = kindIndex >= 0 ? process.argv[kindIndex + 1] : null;
const response = await fetch(`${endpoint}/v1/hooks/dispatch`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ event: input, kind }),
});
const body = await response.text();
if (!response.ok) throw new Error(`hooks daemon rejected event: ${response.status} ${body}`);
const result = JSON.parse(body);
process.stdout.write(`${JSON.stringify(result.hook_output || {})}\n`);

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(text)); } catch { reject(new Error("hook stdin is not valid JSON")); }
    });
    process.stdin.on("error", reject);
  });
}

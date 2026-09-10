import http from "node:http";

export class DaemonHttpServer {
  constructor(daemon) {
    this.daemon = daemon;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async listen(host = "127.0.0.1", port = 0) {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    return `http://${address.address}:${address.port}`;
  }

  async close() {
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  async handle(request, response) {
    if (request.method !== "POST" || request.url !== "/v1/hooks/dispatch") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      const body = await readJson(request);
      const result = await this.daemon.handleHook(body.event, { intent: body.intent || null, kind: body.kind || null });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", error: error.message }));
    }
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > 1_000_000) request.destroy(new Error("request too large"));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid JSON")); }
    });
    request.on("error", reject);
  });
}

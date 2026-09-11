import http from "node:http";
import { FrameworkControlPlane } from "./control.js";

export class DaemonHttpServer {
  constructor(daemon, { control = new FrameworkControlPlane({ store: daemon.store }) } = {}) {
    this.daemon = daemon;
    this.control = control;
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
    const formattedHost = address.address.includes(":") ? `[${address.address}]` : address.address;
    return `http://${formattedHost}:${address.port}`;
  }

  async close() {
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  async handle(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      this.writeJson(response, 200, { protocol: "routecodex-hooks/v1", ready: true });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/state") {
      this.writeJson(response, 200, { protocol: "routecodex-hooks/v1", state: this.daemon.store.snapshot?.() || {} });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/control/state") {
      this.writeJson(response, 200, { protocol: "routecodex-hooks/v1", state: this.control.query() });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/control/mutate") {
      try {
        const body = await readJson(request);
        this.writeJson(response, 200, { protocol: "routecodex-hooks/v1", result: this.control.mutate(body) });
      } catch (error) {
        this.writeJson(response, 400, { protocol: "routecodex-hooks/v1", error: error.message });
      }
      return;
    }
    if (request.method === "POST" && request.url === "/v1/delivery/evidence") {
      try {
        const body = await readJson(request);
        if (body.reconcile !== true) throw Object.assign(new Error("delivery evidence is CodexApp-owned; use reconcile:true"), { code: "client_evidence_forbidden" });
        const result = await this.daemon.reconcileDeliveryEvidence(body.intent_id);
        this.writeJson(response, 200, { protocol: "routecodex-hooks/v1", result });
      } catch (error) {
        this.writeJson(response, 400, { protocol: "routecodex-hooks/v1", error: error.message, code: error.code || "invalid_delivery_evidence" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/hooks/dispatch") {
      this.writeJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readJson(request);
      const result = await this.daemon.handleHook(body.event, { intent: body.intent || null, kind: body.kind || null });
      this.writeJson(response, 200, result);
    } catch (error) {
      this.writeJson(response, 400, { protocol: "routecodex-hooks/v1", error: error.message });
    }
  }

  writeJson(response, status, value) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
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

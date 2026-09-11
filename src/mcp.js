export class McpStateClient {
  constructor(endpoint) {
    if (typeof endpoint !== "string" || endpoint.trim() === "") throw new Error("daemon endpoint is required");
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  async queryState() {
    return this.get("/v1/control/state");
  }

  async queryStatus() {
    const [health, control] = await Promise.all([this.get("/health"), this.queryState()]);
    return { health, control };
  }

  async get(path) {
    const response = await fetch(`${this.endpoint}${path}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `daemon query failed: ${response.status}`);
    return body;
  }
}

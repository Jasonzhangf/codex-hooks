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

  async queryStatusForScope({ scope = "current", sessionId = null, env = process.env } = {}) {
    if (!["current", "global"].includes(scope)) throw new Error(`unsupported MCP status scope: ${scope}`);
    const status = await this.queryStatus();
    if (scope === "global") return status;
    const resolvedSessionId = sessionId || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || null;
    if (!resolvedSessionId) {
      throw new Error("current MCP status scope requires CODEX_SESSION_ID, CODEX_THREAD_ID, or session_id");
    }
    const state = status.control?.state || {};
    const binding = Object.values(state.session_bindings || {}).find((entry) => {
      return entry?.target?.session_id === resolvedSessionId || entry?.target?.thread_id === resolvedSessionId;
    });
    const schedules = Object.values(state.schedules || {}).filter((schedule) => schedule.owner_session_id === resolvedSessionId);
    const subagents = Object.values(state.subagents || {}).filter((subagent) => subagent.owner_session_id === resolvedSessionId);
    const longhorizon = Object.values(state.longhorizon || {}).filter((record) => record.owner_session_id === resolvedSessionId);
    const goalReviews = Object.values(state.goal_reviews || {}).filter((review) => review.source_session_id === resolvedSessionId);
    const stopSuppression = Object.values(state.stop_suppression || {}).filter((entry) => entry.session_id === resolvedSessionId);
    const unresolved = Object.values(state.delivery_intents || {}).filter((record) => {
      return targetSessionId(record) === resolvedSessionId
        && ["unknown_delivery", "accepted", "delivered", "executed", "replied"].includes(record.state);
    });
    return {
      ...status,
      scope,
      session_id: resolvedSessionId,
      session_binding: binding || null,
      schedules,
      subagents,
      longhorizon,
      goal_reviews: goalReviews,
      stop_suppression: stopSuppression,
      unresolved_delivery: unresolved,
    };
  }

  async get(path) {
    const response = await fetch(`${this.endpoint}${path}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `daemon query failed: ${response.status}`);
    return body;
  }
}

function targetSessionId(record) {
  return record?.target?.session_id || record?.target?.thread_id || null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function normalizeLoopbackEndpoint(value, label = "daemon endpoint") {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an http(s) origin: ${error.message}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an http(s) origin`);
  }
  const host = normalizeLoopbackHost(url.hostname, label);
  return {
    endpoint: value.replace(/\/$/, ""),
    host,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

export function normalizeLoopbackHost(value, label = "runtime.host") {
  if (!LOOPBACK_HOSTS.has(value)) throw new Error(`${label} must be loopback-only`);
  return value === "[::1]" ? "::1" : value;
}

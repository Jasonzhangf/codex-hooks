import { Context } from "cordis";

const RUNTIME_STATES = Object.freeze(["down", "starting", "ready", "draining"]);

export class HooksRuntime {
  constructor({ plugins = [] } = {}) {
    this.context = new Context();
    this.plugins = plugins.map(normalizePluginEntry);
    this.state = "down";
  }

  async start() {
    if (this.state === "ready") return this.status();
    if (this.state !== "down") throw new Error(`runtime cannot start from ${this.state}`);
    this.state = "starting";
    try {
      for (const entry of this.plugins) {
        const fiber = this.context.plugin(entry.plugin, entry.config);
        await fiber;
      }
      this.state = "ready";
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (this.state === "down") return this.status();
    if (this.state === "draining") return this.status();
    this.state = "draining";
    await this.context.fiber.dispose();
    this.state = "down";
    return this.status();
  }

  status() {
    return {
      state: this.state,
      cordis_plugins: this.context.registry.size,
      valid_state: RUNTIME_STATES.includes(this.state),
    };
  }
}

function normalizePluginEntry(entry) {
  if (!entry || typeof entry !== "object" || (typeof entry.plugin !== "function" && typeof entry.plugin?.apply !== "function")) {
    throw new Error("Cordis plugin entry requires a plugin function or apply object");
  }
  return { plugin: entry.plugin, config: entry.config ?? {} };
}

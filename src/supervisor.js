import { verifyCodexAppPort } from "./codexapp-port.js";

const STATES = Object.freeze(["down", "starting_codexapp", "codexapp_ready", "starting_hooksd", "ready", "degraded", "draining", "stopping", "stopped", "crashed", "restarting", "failed"]);

export class HooksSupervisor {
  constructor({ startCodexapp, startHooksd }) {
    if (typeof startCodexapp !== "function" || typeof startHooksd !== "function") {
      throw new Error("supervisor requires codexapp and hooksd start functions");
    }
    this.startCodexapp = startCodexapp;
    this.startHooksd = startHooksd;
    this.codexapp = null;
    this.hooksd = null;
    this.state = "down";
  }

  async start() {
    if (this.state === "ready") return this.status();
    if (!["down", "stopped", "crashed", "restarting"].includes(this.state)) throw new Error(`supervisor cannot start from ${this.state}`);
    const recovering = this.state !== "down";
    this.state = recovering ? "restarting" : "starting_codexapp";
    try {
      if (recovering) await this.stopChildren();
      this.codexapp = await this.startCodexapp();
      if (!this.codexapp?.ready) throw new Error("codexapp did not become ready");
      await verifyCodexAppPort(this.codexapp);
      this.state = "codexapp_ready";
      this.state = "starting_hooksd";
      this.hooksd = await this.startHooksd({ codexapp: this.codexapp });
      if (!this.hooksd?.ready) throw new Error("hooksd did not become ready");
      this.state = "ready";
      return this.status();
    } catch (error) {
      this.state = "failed";
      try {
        await this.stopChildren();
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
      throw error;
    }
  }

  async stop() {
    if (["down", "stopped"].includes(this.state)) return this.status();
    this.state = "draining";
    this.state = "stopping";
    try {
      await this.stopChildren();
    } catch (error) {
      this.state = "failed";
      throw error;
    }
    this.state = "stopped";
    return this.status();
  }

  markDegraded() {
    if (this.state !== "ready") throw new Error(`supervisor cannot degrade from ${this.state}`);
    this.state = "degraded";
    return this.status();
  }

  restore() {
    if (this.state !== "degraded") throw new Error(`supervisor cannot restore from ${this.state}`);
    this.state = "ready";
    return this.status();
  }

  markCrashed() {
    if (!["ready", "degraded", "stopping"].includes(this.state)) throw new Error(`supervisor cannot mark crashed from ${this.state}`);
    this.state = "crashed";
    return this.status();
  }

  status() {
    return {
      state: this.state,
      codexapp: Boolean(this.codexapp),
      hooksd: Boolean(this.hooksd),
      valid_state: STATES.includes(this.state),
    };
  }

  async stopChildren() {
    const hooksd = this.hooksd;
    const codexapp = this.codexapp;
    let firstError = null;
    if (hooksd?.stop) {
      try {
        await hooksd.stop();
        if (this.hooksd === hooksd) this.hooksd = null;
      } catch (error) {
        firstError ||= error;
      }
    } else if (this.hooksd === hooksd) {
      this.hooksd = null;
    }
    if (codexapp?.stop) {
      try {
        await codexapp.stop();
        if (this.codexapp === codexapp) this.codexapp = null;
      } catch (error) {
        firstError ||= error;
      }
    } else if (this.codexapp === codexapp) {
      this.codexapp = null;
    }
    if (firstError) throw firstError;
  }
}

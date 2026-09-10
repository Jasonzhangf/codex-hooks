const STATES = Object.freeze(["down", "starting_codexapp", "starting_hooksd", "ready", "draining", "failed"]);

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
    if (this.state !== "down") throw new Error(`supervisor cannot start from ${this.state}`);
    this.state = "starting_codexapp";
    try {
      this.codexapp = await this.startCodexapp();
      if (!this.codexapp?.ready) throw new Error("codexapp did not become ready");
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
    if (this.state === "down") return this.status();
    this.state = "draining";
    try {
      await this.stopChildren();
    } catch (error) {
      this.state = "failed";
      throw error;
    }
    this.state = "down";
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

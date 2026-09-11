import fs from "node:fs";
import path from "node:path";
import { clone } from "./protocol.js";

export class JsonStateStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || filePath.trim() === "") throw new Error("state file path is required");
    this.filePath = filePath;
    this.state = { events: {}, intents: {}, transitions: [], controls: {} };
    this.load();
  }

  getEvent(key) { return clone(this.state.events[key]); }
  putEvent(key, value) { this.state.events[key] = clone(value); this.persist(); }
  getIntent(key) { return clone(this.state.intents[key]); }
  listIntents() { return Object.values(this.state.intents).map(clone); }
  putIntent(key, value) { this.state.intents[key] = clone(value); this.persist(); }
  recordTransition(value) { this.state.transitions.push(clone(value)); this.persist(); }
  getControl(key) { return clone(this.state.controls[key]); }
  putControl(key, value) { this.state.controls[key] = clone(value); this.persist(); }
  snapshot() { return clone(this.state); }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("state file must contain an object");
      this.state = {
        events: parsed.events && typeof parsed.events === "object" ? parsed.events : {},
        intents: parsed.intents && typeof parsed.intents === "object" ? parsed.intents : {},
        transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
        controls: parsed.controls && typeof parsed.controls === "object" ? parsed.controls : {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`cannot load state file: ${error.message}`);
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }
}

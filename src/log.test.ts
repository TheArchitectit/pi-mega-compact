import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "./log.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-log-"));
let counter = 0;
function logPath() {
  return join(baseTmp, `run-${counter++}`, "mega-compact.log");
}

test("logger appends one JSON line per entry", () => {
  const path = logPath();
  let clock = 1000;
  const log = new Logger({ path, now: () => clock++ });
  log.info("compact", { checkpointId: "chkpt_001" });
  log.warn("recall-empty", { query: "x" });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.level, "info");
  assert.equal(first.event, "compact");
  assert.equal(first.checkpointId, "chkpt_001");
  assert.equal(first.ts, 1000);
  const second = JSON.parse(lines[1]);
  assert.equal(second.level, "warn");
  assert.equal(second.ts, 1001);
});

test("disabled logger writes nothing", () => {
  const path = logPath();
  const log = new Logger({ path, enabled: false });
  log.info("compact", { a: 1 });
  assert.equal(existsSync(path), false);
});

test("logger never throws on a bad path", () => {
  // A path whose parent cannot be created (null byte) — must be swallowed.
  const log = new Logger({ path: "/\0/nope.log" });
  assert.doesNotThrow(() => log.error("boom", { x: 1 }));
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});

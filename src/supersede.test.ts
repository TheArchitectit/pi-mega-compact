import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineMessage } from "./types.js";
import { findSuperseded, supersede } from "./supersede.js";

function msg(role: EngineMessage["role"], text: string): EngineMessage { return { role, text }; }

test("read superseded by later write to same path is pruned", () => {
  const messages = [
    msg("assistant", "read src/server.ts"),
    msg("user", "now change it"),
    msg("assistant", "write src/server.ts with the fix"),
  ];
  assert.deepEqual(findSuperseded(messages), [0]);
});

test("older read superseded by newer read of same path (keep latest)", () => {
  const messages = [
    msg("assistant", "read src/a.ts"),
    msg("assistant", "read src/a.ts again"),
  ];
  assert.deepEqual(findSuperseded(messages), [0]);
});

test("unrelated reads are kept", () => {
  const messages = [
    msg("assistant", "read src/a.ts"),
    msg("assistant", "read src/b.ts"),
  ];
  assert.deepEqual(findSuperseded(messages), []);
});

test("supersede() drops the obsolete read and preserves order", () => {
  const messages = [
    msg("assistant", "read src/server.ts"),
    msg("user", "change it"),
    msg("assistant", "write src/server.ts done"),
  ];
  const out = supersede(messages);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "change it");
});

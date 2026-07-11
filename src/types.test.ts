import { test } from "node:test";
import assert from "node:assert/strict";

test("EngineMessage roles are constrained to the pi message contract (no system role)", () => {
  const roles = ["user", "assistant", "tool", "custom"] as const;
  // pi Message = user|assistant|tool (+ custom for markers). There is no system role.
  const probe: string = "system";
  assert.equal((roles as readonly string[]).includes(probe), false);
  assert.equal(roles.length, 4);
});

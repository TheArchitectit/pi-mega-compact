/**
 * heal/_vc6c-impl-fixture.ts — conformance fixture I/O for VC6C-IMPL
 * self-healing-controller rows.
 *
 * VC6C's base corpus lives under `healing-controller/` (read by
 * `_repair-fixture.ts`); VC6C-IMPL emits its six fixtures under
 * `self-healing/` per the sprint brief. Both share the one canonical
 * `healing-controller-fixture.schema.json`, so this loader reuses the
 * `RepairFx` envelope (`_repair-fixture.ts`) but resolves fixture paths from
 * the `self-healing/` directory. No mocks — the committed fixtures are fed
 * verbatim into the real heal / reconstruct production modules.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import { V2, readManifest } from "./_acceptance-fixture.js";
import type { RepairFx } from "./_repair-fixture.js";

const PREFIX = "self-healing";

/** Read one registered VC6C-IMPL fixture (asserting it IS registered). */
export function vc6cImplFixture(id: string): RepairFx {
  const m = readManifest();
  const row = m.fixtures.find(
    (f) => f.id === id && f.path.startsWith(`${PREFIX}/`),
  );
  assert.ok(
    row,
    `fixture ${id} registered under ${PREFIX}/ in manifest`,
  );
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as RepairFx;
}

/**
 * The six VC6C-IMPL fixture ids, in corpus order. The acceptance test drives
 * each through the real production seam and asserts its pinned verdict.
 */
export const VC6C_IMPL_IDS: readonly string[] = Array.from(
  { length: 6 },
  (_v, i) => `VC6C-IMPL-${String(i + 1).padStart(3, "0")}`,
);

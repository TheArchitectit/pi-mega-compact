/**
 * vector-cortex/cortex/rebuild-integrity.test.ts — VC3A rebuild integrity
 * coverage (Q01/Q02/Q06 from the VC3A code-quality review).
 *
 * Exercises the REAL cortex store against the integrity guarantees that the
 * CTX conformance suite pins by contract:
 *  - Q01: a generation write that does not persist (real `PRAGMA query_only`
 *    storage refusal) reports `CTX_REBUILD_FAILED` — never a fabricated ok:
 *    generation — and emits NO `vector_cortex_generation_rebuilt` event. The
 *    reader sees no generation. A later thaw lets a durable rebuild + event fire.
 *  - Q02: `rebuild(authorityHighWater)` rejects a derived frontier that outruns
 *    the durable authority high-water with `CTX_HIGH_WATER_EXCEEDED` and writes
 *    nothing; a bound at/above the frontier is accepted.
 *  - Q06: a `sourceHighWater` beyond `Number.MAX_SAFE_INTEGER` round-trips
 *    exactly through storage (never truncated through a `Number()` double).
 *
 * Real logic + fixtures, no mocks (no-mock-data/no-stubs memory). Held in its
 * own file so the VC3A acceptance aggregator stays under the 600-line test limit.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCortexStore, type CortexHandle } from "./store.js";
import { openCortexStore, setStoreReadOnly } from "./sqlite.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vc3a-integrity-"));
}

function withStore<T>(
  fn: (store: CortexHandle) => T,
  emit?: (ev: string, fields: Record<string, unknown>) => void,
): T {
  const dir = tempDir();
  const store = createCortexStore({ dbPath: join(dir, "cortex.db") }, emit);
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function appendOk(store: CortexHandle, hw: bigint, id: string, body: string): void {
  const r = store.writer().append({ sourceHighWater: hw, algorithmVersion: 1, id, kind: "semantic", payloadBytes: bytes(body) });
  assert.equal(r.ok, true, `append ${id} accepted`);
}

describe("VC3A rebuild integrity (Q01/Q02/Q06)", () => {
  test("a failed generation write returns CTX_REBUILD_FAILED and emits no generation_rebuilt", () => {
    process.env.MEGACOMPACT_VC3A = "1";
    try {
      const emitted: string[] = [];
      const dir = tempDir();
      const db = openCortexStore(join(dir, "cortex.db"));
      const store = createCortexStore({ db }, (ev) => emitted.push(ev));
      try {
        appendOk(store, 1n, "a", "A");
        // Freeze storage so the generation INSERT is refused by SQLite itself.
        setStoreReadOnly(db, true);
        emitted.length = 0;
        const rebuilt = store.admin().rebuild();
        assert.equal(rebuilt.ok, false, "rebuild must NOT report ok when nothing was persisted");
        if (rebuilt.ok) throw new Error("unreachable");
        assert.equal(rebuilt.code, "CTX_REBUILD_FAILED", "exact storage-failure code");
        // No durable generation, and no misleading generation_rebuilt event.
        assert.equal(store.reader().latestGeneration(), undefined, "no generation persisted");
        assert.equal(store.reader().topologySummary().generationId, null, "reader sees no generation");
        assert.equal(emitted.includes("vector_cortex_generation_rebuilt"), false, "no misleading rebuilt event");
        // Thaw and rebuild again -> durable generation + event, exactly once.
        setStoreReadOnly(db, false);
        const recovered = store.admin().rebuild();
        assert.equal(recovered.ok, true, "rebuild recovers after storage thaws");
        assert.equal(store.reader().latestGeneration()?.id, recovered.ok ? recovered.generation.id : undefined);
        assert.equal(emitted.includes("vector_cortex_generation_rebuilt"), true, "rebuilt event fires only on persistence");
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      delete process.env.MEGACOMPACT_VC3A;
    }
  });

  test("rebuild rejects a derived frontier that outruns the authority high-water", () => {
    withStore((store) => {
      appendOk(store, 1n, "a", "A");
      appendOk(store, 9n, "b", "B");
      // Authority frontier froze at 5: the derived frontier (9) must not exceed it.
      const rejected = store.admin().rebuild(5n);
      assert.equal(rejected.ok, false, "rebuild rejected when derived outruns authority high-water");
      if (rejected.ok) throw new Error("unreachable");
      assert.equal(rejected.code, "CTX_HIGH_WATER_EXCEEDED", "exact high-water code");
      assert.equal(store.reader().latestGeneration(), undefined, "nothing written on rejection");
      // A high-water at/above the derived frontier is accepted.
      const accepted = store.admin().rebuild(9n);
      assert.equal(accepted.ok, true, "rebuild accepted when frontier within authority high-water");
      if (accepted.ok) assert.equal(accepted.generation.sourceHighWater, 9n);
    });
  });

  test("sourceHighWater beyond 2^53 round-trips exactly through storage", () => {
    withStore((store) => {
      // 2^60 > Number.MAX_SAFE_INTEGER: must not be truncated through a Number().
      const big = 2n ** 60n;
      appendOk(store, big, "big", "big payload");
      const rebuilt = store.admin().rebuild();
      assert.ok(rebuilt.ok, "rebuild ok");
      if (!rebuilt.ok) throw new Error("unreachable");
      assert.equal(rebuilt.generation.sourceHighWater, big, "generation sourceHighWater round-trips exactly");
      assert.equal(store.reader().readRecord(big, 1, "big")?.sourceHighWater, big, "record sourceHighWater round-trips exactly");
    });
  });
});

/**
 * vectorIndex.test.ts — Slice 2 async PGlite/HNSW vector index.
 *
 * Proves: cross-repo nearest-neighbor recall, repoId scoping, the dimension
 * guard (non-512 vectors skipped, never corrupt the index), and graceful
 * degradation when the index is disabled (kill-switch) — all without touching
 * the synchronous node:sqlite store.
 *
 * The index is a WASM Postgres (PGlite) — fully local, zero network
 * (PREVENT-PI-004). Each test isolates state via MEGACOMPACT_VECTOR_INDEX_DIR.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_DIM,
  initVectorIndex,
  upsertEmbedding,
  searchAsync,
  closeVectorIndex,
  isVectorIndexDisabled,
} from "./vectorIndex.js";

/** A 512-dim unit-ish vector with a single spike at `idx` (deterministic NN). */
function spikeVec(idx: number, magnitude = 1): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[idx % EMBEDDING_DIM] = magnitude;
  return v;
}

function isolateIndexDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-vecidx-"));
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = dir;
  return dir;
}

test("cross-repo HNSW nearest-neighbor recall across repos + repoId scoping", async () => {
  delete process.env.MEGACOMPACT_PGLITE_DISABLED;
  const dir = isolateIndexDir();
  try {
    await closeVectorIndex(); // ensure a fresh singleton for this dir
    const pg = await initVectorIndex();
    assert.ok(pg, "index should initialize (PGlite WASM available)");

    // repoA: two checkpoints; repoB: one checkpoint. Distinct spike directions.
    await upsertEmbedding("/repoA/.pi/mega-compact", "sessA", "chkpt_001", spikeVec(0));
    await upsertEmbedding("/repoA/.pi/mega-compact", "sessA", "chkpt_002", spikeVec(5));
    await upsertEmbedding("/repoB/.pi/mega-compact", "sessB", "chkpt_001", spikeVec(0));

    // Cross-repo query near spike(0): nearest are the two spike(0) rows, one per repo.
    const cross = await searchAsync(spikeVec(0), { k: 2 });
    assert.equal(cross.length, 2, "cross-repo returns two nearest");
    const repos = new Set(cross.map((h) => h.repoId));
    assert.ok(repos.has("/repoA/.pi/mega-compact"), "hit from repoA");
    assert.ok(repos.has("/repoB/.pi/mega-compact"), "hit from repoB");
    assert.ok(cross[0].score > 0.99, "top hit is near-identical (cosine ~1)");

    // Scoped to repoA only: excludes repoB even though repoB has an identical vec.
    const scoped = await searchAsync(spikeVec(0), { k: 5, repoId: "/repoA/.pi/mega-compact" });
    assert.ok(scoped.length >= 1, "scoped returns repoA hits");
    assert.ok(
      scoped.every((h) => h.repoId === "/repoA/.pi/mega-compact"),
      "repoId filter excludes other repos",
    );
  } finally {
    await closeVectorIndex();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
  }
});

test("dimension guard: non-512 vectors are skipped, never corrupt the index", async () => {
  delete process.env.MEGACOMPACT_PGLITE_DISABLED;
  const dir = isolateIndexDir();
  try {
    await closeVectorIndex();
    await initVectorIndex();
    // Wrong-dimension vector (BYO embedder mismatch) must be silently skipped.
    await upsertEmbedding("/repoC/.pi/mega-compact", "sessC", "chkpt_001", [1, 2, 3]);
    const hits = await searchAsync(spikeVec(0), { k: 5 });
    assert.equal(hits.length, 0, "no rows stored for a mismatched-dim vector");

    // A correct-dim vector still stores fine afterward (index not corrupted).
    await upsertEmbedding("/repoC/.pi/mega-compact", "sessC", "chkpt_002", spikeVec(3));
    const ok = await searchAsync(spikeVec(3), { k: 1 });
    assert.equal(ok.length, 1, "valid vector stored after a skipped one");
    assert.equal(ok[0].checkpointId, "chkpt_002");
  } finally {
    await closeVectorIndex();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
  }
});

test("kill-switch: MEGACOMPACT_PGLITE_DISABLED disables the index gracefully", async () => {
  const dir = isolateIndexDir();
  process.env.MEGACOMPACT_PGLITE_DISABLED = "true";
  try {
    await closeVectorIndex();
    assert.equal(isVectorIndexDisabled(), true, "kill-switch reported disabled");
    const pg = await initVectorIndex();
    assert.equal(pg, undefined, "init returns undefined when disabled");
    // Upsert + search are no-ops that never throw and return empty.
    await upsertEmbedding("/repoD/.pi/mega-compact", "sessD", "chkpt_001", spikeVec(0));
    const hits = await searchAsync(spikeVec(0), { k: 3 });
    assert.deepEqual(hits, [], "search returns [] when disabled");
  } finally {
    delete process.env.MEGACOMPACT_PGLITE_DISABLED;
    await closeVectorIndex();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
  }
});

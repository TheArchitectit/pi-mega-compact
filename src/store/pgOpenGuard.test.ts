/**
 * pgOpenGuard.test.ts — the PGlite open must never hang a turn.
 *
 * Regression cover for the wedge: a stalled `await new PGlite(...)` was cached
 * in initPromise, so every later caller awaited a promise that could not settle
 * and the pi turn awaiting it never ended.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { withOpenTimeout, pgOpenTimeoutMs, DEFAULT_PG_OPEN_TIMEOUT_MS } from "./pgOpenGuard.js";

test("a never-settling open resolves to undefined instead of hanging", async () => {
  const never = new Promise<string>(() => {
    /* deliberately never settles — the wedge */
  });
  const reasons: string[] = [];
  const t0 = Date.now();

  const result = await withOpenTimeout(never, (r) => reasons.push(r), 50);

  assert.equal(result, undefined, "caller gets undefined and can fall back");
  assert.ok(Date.now() - t0 < 5_000, "returned promptly rather than hanging");
  assert.equal(reasons.length, 1, "onTimeout fired exactly once");
  assert.match(reasons[0], /timed out after 50ms/);
});

test("a successful open passes its value through untouched", async () => {
  const reasons: string[] = [];
  const result = await withOpenTimeout(Promise.resolve("pg"), (r) => reasons.push(r), 5_000);
  assert.equal(result, "pg");
  assert.deepEqual(reasons, [], "no timeout reported on the happy path");
});

test("a rejected open propagates so the corrupt-dir retry still runs", async () => {
  const reasons: string[] = [];
  await assert.rejects(
    () => withOpenTimeout(Promise.reject(new Error("Aborted()")), (r) => reasons.push(r), 5_000),
    /Aborted/,
    "rejection reaches the caller's catch, which owns the wipe-and-retry path",
  );
  assert.deepEqual(reasons, [], "a rejection is not reported as a timeout");
});

test("an abandoned open is closed if it settles after the timeout", async () => {
  let closed = false;
  let release: (v: { close: () => void }) => void = () => {};
  const late = new Promise<{ close: () => void }>((r) => {
    release = r;
  });

  const result = await withOpenTimeout(late, () => {}, 25);
  assert.equal(result, undefined, "timed out first");

  // The open finally completes, long after we stopped waiting for it.
  release({
    close: () => {
      closed = true;
    },
  });
  await late;
  await new Promise((r) => setImmediate(r));

  assert.ok(closed, "the orphaned instance was closed, not left holding the dataDir");
});

test("timeout of 0 disables the guard (unbounded, original behavior)", async () => {
  const result = await withOpenTimeout(Promise.resolve("pg"), () => {}, 0);
  assert.equal(result, "pg");
});

test("pgOpenTimeoutMs honors the env override and rejects junk", async () => {
  const prev = process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS;
  try {
    process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS = "1234";
    assert.equal(pgOpenTimeoutMs(), 1234);

    process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS = "0";
    assert.equal(pgOpenTimeoutMs(), 0, "0 is a valid opt-out, not junk");

    for (const junk of ["", "   ", "abc", "-5"]) {
      process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS = junk;
      assert.equal(pgOpenTimeoutMs(), DEFAULT_PG_OPEN_TIMEOUT_MS, `junk "${junk}" falls back`);
    }
  } finally {
    if (prev === undefined) delete process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS;
    else process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS = prev;
  }
});

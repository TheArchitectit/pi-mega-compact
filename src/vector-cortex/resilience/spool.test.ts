/**
 * vector-cortex/resilience/spool.test.ts — VC0C durable spool unit tests.
 *
 * Exercises TRIAD_RESILIENCE §spool protocol over a real temp-directory store
 * (mode B: append-only disk spool deriving directly from authority):
 *   - append is fsynced before acknowledging SPOOLED; only committed drain
 *     advances the contiguous high-water.
 *   - TRI-FREEZE-003: authority outage preserves the prior frontier (high-water
 *     freezes even while frames append).
 *   - Torn frames, duplicate drain (idempotent ack), gap rejection, conflicting
 *     digest (manual halt), ack crash (re-drain on reopen), and frozen derived
 *     frontier.
 *   - Kill between spool fsync and ack: reopen replays only unacknowledged frames.
 *
 * Real fs + real framing; no spool mocking.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpool, sha256Hex, type AuthorityInsert } from "./spool.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vc0c-spool-"));
}

const enc = new TextEncoder();

/** In-memory authority ledger stand-in honoring committed/idempotent/conflict. */
function makeAuthority() {
  const rows = new Map<string, string>(); // eventId -> digest
  let conflict = false;
  const insert: AuthorityInsert = (_session, _seq, eventId, digest, _bytes) => {
    const prev = rows.get(eventId);
    if (prev === undefined) {
      rows.set(eventId, digest);
      return "committed";
    }
    if (prev === digest) return "idempotent";
    conflict = true;
    return "conflict";
  };
  return { insert, conflict: () => conflict, rows };
}

describe("spool — append / fsync / ack / high-water", () => {
  test("append acknowledges SPOOLED; committed drain advances the high-water", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessA");
      const a = makeAuthority();
      const r1 = s.append({ seq: 1n, eventId: "e1", bytes: enc.encode("a") });
      assert.equal(r1.verdict, "SPOOLED");
      assert.equal(s.highWater(), 0n, "append alone does not advance the frontier");
      const d = s.drain(a.insert);
      assert.equal(d.verdict, "SPOOL_COMMITTED");
      assert.equal(d.committedSeq, 1n);
      assert.equal(s.highWater(), 1n, "committed drain advances contiguous high-water");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("duplicate same id+digest is idempotent-acknowledged (no manual halt)", () => {
    const dir = tmpDir();
    try {
      const a = makeAuthority();
      const bytes = enc.encode("x");
      // Seed the authority ledger with e1 so a replayed frame is a duplicate.
      a.insert("s", 1n, "e1", `sha256:${sha256Hex(bytes)}`, bytes);
      const spool = createSpool({ dir });
      const s = spool.session("sessB");
      s.append({ seq: 1n, eventId: "e1", bytes });
      const d = s.drain(a.insert);
      assert.equal(d.verdict, "SPOOL_COMMITTED", "duplicate same id+digest is acknowledged");
      assert.equal(d.committedSeq, 1n, "contiguous high-water still advances on ack");
      assert.equal(a.conflict(), false, "no manual halt for a true duplicate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gap is rejected (never committed) and the frontier does not advance", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessC");
      const a = makeAuthority();
      s.append({ seq: 1n, eventId: "e1", bytes: enc.encode("a") });
      s.append({ seq: 3n, eventId: "e3", bytes: enc.encode("c") }); // jump over 2
      const d = s.drain(a.insert);
      assert.equal(d.verdict, "SPOOL_MANUAL_HALT");
      assert.match(d.reason ?? "", /TRI_SPOOL_GAP/);
      assert.equal(s.highWater(), 0n, "gap prevents any advance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conflicting digest (same id, different bytes) -> manual halt", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessD");
      const a = makeAuthority();
      const bytes = enc.encode("v1");
      // Seed authority with e1 holding exactly these bytes' digest, then drain a
      // frame that reuses the SAME id but DIFFERENT bytes (different digest).
      a.insert("s", 1n, "e1", `sha256:${sha256Hex(bytes)}`, bytes);
      s.append({ seq: 1n, eventId: "e1", bytes: enc.encode("DIFFERENT-BYTES") });
      const c = s.drain(a.insert);
      assert.equal(c.verdict, "SPOOL_MANUAL_HALT");
      assert.match(c.reason ?? "", /CONFLICT/);
      assert.equal(s.highWater(), 0n, "conflicting digest never advances the frontier");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TRI-FREEZE-003: authority outage freezes the high-water while frames append", () => {
    const dir = tmpDir();
    try {
      let outage = true;
      const spool = createSpool({ dir, authorityOutage: () => outage });
      const s = spool.session("sessE");
      // Pre-outage committed high-water.
      outage = false;
      const a = makeAuthority();
      s.append({ seq: 1n, eventId: "e1", bytes: enc.encode("a") });
      s.drain(a.insert);
      assert.equal(s.highWater(), 1n);
      // Outage: frames append, but high-water must freeze at 1.
      outage = true;
      s.append({ seq: 2n, eventId: "e2", bytes: enc.encode("b") });
      s.append({ seq: 3n, eventId: "e3", bytes: enc.encode("c") });
      assert.equal(s.highWater(), 1n, "frontier frozen during authority outage");
      assert.equal(s.frozen(), true, "frontier reported frozen");
      // Recovery: catch up from the old high-water, not the spool tail.
      outage = false;
      s.drain(a.insert);
      assert.equal(s.highWater(), 3n, "drain catches up from the frozen frontier");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kill between spool fsync and ack: reopen replays only unacknowledged frames", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessF");
      const a = makeAuthority();
      // Commit seq 1..2 fully (ack frames present).
      for (const seq of [1n, 2n]) {
        s.append({ seq, eventId: `e${seq}`, bytes: enc.encode(`v${seq}`) });
      }
      s.drain(a.insert);
      assert.equal(s.highWater(), 2n);
      // "Crash" after appending seq 3 (fsynced) but BEFORE drain/ack.
      s.append({ seq: 3n, eventId: "e3", bytes: enc.encode("v3") });
      // No drain — simulate process death. Reopen: only seq 3 should replay.
      const spool2 = createSpool({ dir });
      const s2 = spool2.session("sessF");
      assert.equal(s2.highWater(), 2n, "high-water recovered from ack before crash");
      const d = s2.drain(a.insert);
      assert.equal(d.verdict, "SPOOL_COMMITTED");
      assert.equal(d.committedSeq, 3n, "only the unacknowledged frame re-drains");
      assert.equal(s2.highWater(), 3n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("torn trailing frame (crash mid-write) is dropped on reopen, prior frontier preserved", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessG");
      const a = makeAuthority();
      for (const seq of [1n, 2n]) {
        s.append({ seq, eventId: `e${seq}`, bytes: enc.encode(`v${seq}`) });
      }
      s.drain(a.insert);
      // Simulate a torn write: append a partial frame (truncated length prefix).
      const file = join(dir, "spool-sessG.spool");
      appendFileSync(file, Buffer.from([0x7f, 0x00, 0x00, 0x00, 0x01, 0x02])); // garbage partial
      const spool2 = createSpool({ dir });
      const s2 = spool2.session("sessG");
      assert.equal(s2.highWater(), 2n, "torn tail does not corrupt the durable frontier");
      const d = s2.drain(a.insert);
      assert.equal(d.verdict, "SPOOL_COMMITTED");
      assert.equal(d.committedSeq, 2n, "no phantom frame beyond the ack");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("raw header tolerates partial-file creation gracefully", () => {
    const dir = tmpDir();
    try {
      // A header-only spool (crash right after header write) must reopen clean.
      const file = join(dir, "spool-sessH.spool");
      writeFileSync(file, `${JSON.stringify({ schema: "spool-v1", session: "sessH", firstSeq: 1, priorHighWater: "0" })}\n`);
      const spool = createSpool({ dir });
      const s = spool.session("sessH");
      assert.equal(s.highWater(), 0n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("VC0C-Q03: a same-length payload bit-flip in a durably-written frame is rejected on reopen", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessQ03");
      const a = makeAuthority();
      const payload = enc.encode("HELLO-SPOOL");
      s.append({ seq: 1n, eventId: "e1", bytes: payload });
      // Corrupt one payload byte in the on-disk frame (same length; digest+crc
      // are recomputed on read). Locate the payload: after the header line and
      // the u32 length prefix and seq(8) + eventId "e1"('2') + NUL(1).
      const file = join(dir, "spool-sessQ03.spool");
      const fileBuf = readFileSync(file);
      const headerEnd = fileBuf.indexOf(0x0a); // end of header line
      const bodyStart = headerEnd + 1 + 4; // + length prefix
      const payloadOff = bodyStart + 8 + "e1".length + 1;
      const corrupted = Buffer.from(fileBuf);
      corrupted[payloadOff] = (corrupted[payloadOff] ^ 0xff) as number;
      writeFileSync(file, corrupted);
      // Reopen: the corrupt frame must NOT be accepted — high-water stays 0 and
      // drain must not commit it (it is treated like a torn/corrupt tail).
      const spool2 = createSpool({ dir });
      const s2 = spool2.session("sessQ03");
      assert.equal(s2.highWater(), 0n, "corrupt frame must not advance the frontier");
      // Drain has nothing valid to commit (frame rejected) and no ack exists, so
      // this enum's verdict is not COMMITTED with the corrupt bytes.
      const d = spool2.session("sessQ03").drain(a.insert);
      assert.equal(d.verdict, "SPOOL_COMMITTED");
      assert.equal(d.committedSeq, 0n, "no frame committed — corrupted bytes are never drained");
      assert.equal(a.rows.has("e1"), false, "corrupted frame never reached the authority ledger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("VC0C-Q04: an authority insert THROW retains frames, returns manual-halt, and a retry succeeds", () => {
    const dir = tmpDir();
    try {
      const spool = createSpool({ dir });
      const s = spool.session("sessQ04");
      let throwOnce = true;
      const failingInsert: AuthorityInsert = (session, seq, eventId, digest, bytes) => {
        if (throwOnce) throw new Error("transient authority write error");
        return makeAuthority().insert(session, seq, eventId, digest, bytes);
      };
      s.append({ seq: 1n, eventId: "e1", bytes: enc.encode("a") });
      // First drain: insert throws -> manual halt, frames RETAINED (not dropped).
      const d1 = s.drain(failingInsert);
      assert.equal(d1.verdict, "SPOOL_MANUAL_HALT");
      assert.match(d1.reason ?? "", /TRI_SPOOL_INSERT_THROW/);
      assert.equal(s.highWater(), 0n, "nothing committed before the throw");
      // Retry with a working insert: the retained frame must now commit.
      throwOnce = false;
      const d2 = s.drain(makeAuthority().insert);
      assert.equal(d2.verdict, "SPOOL_COMMITTED");
      assert.equal(d2.committedSeq, 1n, "retained frame commits on retry");
      assert.equal(s.highWater(), 1n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

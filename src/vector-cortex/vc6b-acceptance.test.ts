/**
 * vc6b-acceptance.test.ts — VC6B exact source restoration acceptance aggregator.
 *
 * Drives EVERY restoration fixture (HEAL-016..030 + named HEAL-SPAN-001 /
 * HEAL-LIMIT-002 / HEAL-DIGEST-003) through the REAL restore + verify modules —
 * no mocks/stubs. Also asserts: the byte-identity invariant (a restored span's
 * bytes equal the source bytes EXACTLY, and every insertion carries a verified
 * requested digest), the unique failure injection (swap an exact shard's bytes
 * after the lookup resolves → HEAL_RESTORE_DIGEST_MISMATCH, nothing inserted),
 * the forced A/B/C triad, the disjoint-span/limit boundary sweep, and flag-off
 * parity (restore+verify are pure; only the reporter is gated).
 *
 * The doc-mandated run command is:
 *   node --test dist/vector-cortex/vc6b-acceptance.test.js
 * (the publish-acceptance script mirrors the heal subtree to dist/vector-cortex/
 * so the ./heal/* relative imports resolve).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type {
  EventV2,
  ExactShardV1,
  RestoreReader,
  RestoreRequestV1,
  RestoreResultV1,
  ShardRange,
} from "./heal/restore-types.js";
import { RESTORE_IDS, RESTORE_LIMIT_SPANS, RESTORE_NAMED_IDS } from "./heal/restore-types.js";
import { restoreSources } from "./heal/restore.js";
import { verifyRestored, insertable } from "./heal/verify.js";
import { readManifest } from "./heal/_acceptance-fixture.js";
import {
  restorationFixture,
  decodeEvent,
  decodeRange,
  decodeShard,
  withVc6bFlagsOn,
  type RestoreFx,
} from "./heal/_restore-fixture.js";

const ALL_IDS = [...RESTORE_IDS, ...RESTORE_NAMED_IDS];

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));
const hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Decode a fixture into the REAL request + reader the production code consumes. */
function decodeFx(fx: RestoreFx): { request: RestoreRequestV1; reader: RestoreReader } {
  return {
    request: {
      schema: "restore-request-v1",
      sessionId: fx.input.sessionId,
      spans: fx.input.request.spans.map((s) => ({
        nodeId: s.nodeId,
        range: decodeRange(s.range),
        digest: s.digest,
      })),
    },
    reader: {
      exactShards: fx.input.exactShards.map(decodeShard),
      ledgerEvents: fx.input.ledgerEvents.map(decodeEvent),
    },
  };
}

/** Run the real pipeline: restore → verify. */
function runReal(fx: RestoreFx): {
  request: RestoreRequestV1;
  reader: RestoreReader;
  result: RestoreResultV1;
  verification: ReturnType<typeof verifyRestored>;
} {
  const { request, reader } = decodeFx(fx);
  const result = restoreSources(request, reader);
  return { request, reader, result, verification: verifyRestored(result, request) };
}

describe("VC6B conformance registration", () => {
  test("every RESTORE id is registered in the manifest under algorithm 'restoration'", () => {
    const m = readManifest();
    for (const id of ALL_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `manifest row present for ${id}`);
      assert.equal(row!.path.startsWith("restoration/"), true, `${id} under restoration/`);
      assert.equal(row!.algorithm, "restoration", `${id} algorithm=restoration`);
    }
  });

  test("the VC6B id range is HEAL-016..030 plus three named rows", () => {
    assert.equal(RESTORE_IDS.length, 15);
    assert.equal(RESTORE_IDS[0], "HEAL-016");
    assert.equal(RESTORE_IDS[14], "HEAL-030");
    assert.equal(RESTORE_NAMED_IDS.length, 3);
  });
});

describe("VC6B restoration fixtures (HEAL-016..030 + named)", () => {
  for (const id of ALL_IDS) {
    test(
      `${id}: ${restorationFixture(id).assertion}`,
      withVc6bFlagsOn(() => {
        const fx = restorationFixture(id);
        const { result, verification } = runReal(fx);

        assert.equal(result.mode, fx.expected.mode, `${id}: mode`);
        assert.equal(result.restored.length, fx.expected.restoredCount, `${id}: restoredCount`);
        assert.equal(result.missing.length, fx.expected.missingCount, `${id}: missingCount`);

        if (fx.expected.ok) {
          assert.deepEqual(result.codes, [], `${id}: no failure codes`);
          assert.equal(verification.ok, true, `${id}: restoration verifies`);
          assert.equal(result.semanticLossStated, false, `${id}: no loss claimed`);
        } else {
          assert.ok(
            result.codes.includes(
              fx.expected.code as (typeof result.codes)[number],
            ),
            `${id}: pinned code ${fx.expected.code} present (got ${result.codes.join(",")})`,
          );
          // Mode C must always disclose its loss (TRIAD_RESILIENCE).
          if (result.mode === "C") {
            assert.equal(result.semanticLossStated, true, `${id}: mode C states loss`);
          }
        }
      }),
    );
  }
});

describe("VC6B acceptance: byte-identity invariant", () => {
  test("every restored span's bytes equal the ORIGINAL source bytes exactly", () => {
    for (const id of ALL_IDS) {
      const fx = restorationFixture(id);
      const { reader, result } = runReal(fx);
      for (const span of result.restored) {
        // Rebuild the expected bytes independently from the decoded sources.
        const range = decodeRange(
          fx.input.request.spans.find((s) => s.nodeId === span.nodeId)!.range,
        );
        const shard = reader.exactShards.find(
          (s) =>
            s.range.sessionId === range.sessionId &&
            s.range.seqStart === range.seqStart &&
            s.range.seqEnd === range.seqEnd &&
            s.range.byteStart === range.byteStart &&
            s.range.byteEnd === range.byteEnd,
        );
        if (span.source === "exact-shard") {
          assert.ok(shard, `${id}/${span.nodeId}: exact shard present`);
          assert.deepEqual(span.bytes, shard!.originalBytes, `${id}/${span.nodeId}: verbatim`);
        } else {
          const covering = reader.ledgerEvents
            .filter(
              (e) =>
                e.sessionId === range.sessionId &&
                e.seq >= range.seqStart &&
                e.seq <= range.seqEnd,
            )
            .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
          const expected = Buffer.concat(covering.map((e) => Buffer.from(e.originalBytes)));
          assert.deepEqual(
            Buffer.from(span.bytes),
            expected,
            `${id}/${span.nodeId}: ledger concat verbatim`,
          );
        }
      }
    }
  });

  test("every insertion carries a digest that was VERIFIED against the request", () => {
    for (const id of ALL_IDS) {
      const fx = restorationFixture(id);
      const { request, result } = runReal(fx);
      for (const span of insertable(result, request)) {
        const asked = request.spans.find((s) => s.nodeId === span.nodeId);
        assert.ok(asked, `${id}/${span.nodeId}: was requested`);
        assert.equal(span.digest, asked!.digest, `${id}/${span.nodeId}: digest is the requested one`);
        assert.equal(hex(span.bytes), asked!.digest, `${id}/${span.nodeId}: bytes hash to it`);
      }
    }
  });

  test("no failing fixture inserts anything for its failed spans", () => {
    for (const id of ALL_IDS) {
      const fx = restorationFixture(id);
      if (fx.expected.ok) continue;
      const { result } = runReal(fx);
      assert.equal(
        result.restored.length,
        fx.expected.restoredCount,
        `${id}: only the pinned count was inserted`,
      );
    }
  });
});

describe("VC6B acceptance: UNIQUE failure injection", () => {
  test("swapping an exact shard's bytes AFTER lookup yields HEAL_RESTORE_DIGEST_MISMATCH", () => {
    const fx = restorationFixture("HEAL-SPAN-001");
    const { request, reader } = decodeFx(fx);

    // Baseline: the genuine corpus restores cleanly.
    const genuine = restoreSources(request, reader);
    assert.equal(genuine.mode, "A");
    assert.equal(genuine.restored.length, 1);

    // The injection: the index lookup still resolves (range + recorded digest are
    // untouched) but the file on disk now holds different bytes. Only a re-hash
    // of what was actually READ can catch this.
    const original = reader.exactShards[0]!;
    const swapped: ExactShardV1 = { ...original, originalBytes: enc("SWAPPED-AFTER-LOOKUP") };
    const result = restoreSources(request, { ...reader, exactShards: [swapped] });

    assert.ok(
      result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"),
      "digest mismatch reported",
    );
    assert.equal(result.restored.length, 0, "nothing inserted");
    assert.equal(result.mode, "C");
    assert.equal(result.semanticLossStated, true);
    assert.deepEqual(insertable(result, request), [], "insertion gate is closed");
  });

  test("a ledger record swapped after its digest check is still rejected at span level", () => {
    const fx = restorationFixture("HEAL-021");
    const { request, reader } = decodeFx(fx);
    const original = reader.ledgerEvents[0]!;
    // Keep the record's own bytesDigest consistent with the NEW bytes, so only
    // the span-level hash can reject it.
    const swappedBytes = enc("different-content");
    const swapped: EventV2 = {
      ...original,
      originalBytes: swappedBytes,
      bytesDigest: `sha256:${hex(swappedBytes)}`,
    };
    const result = restoreSources(request, { ...reader, ledgerEvents: [swapped] });
    assert.ok(result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"));
    assert.equal(result.restored.length, 0, "nothing inserted");
  });
});

describe("VC6B acceptance: forced A/B/C triad", () => {
  const range: ShardRange = {
    sessionId: "triad",
    seqStart: 1n,
    seqEnd: 1n,
    byteStart: 0,
    byteEnd: 5,
  };
  const bytes = enc("hello");
  const digest = hex(bytes);
  const request: RestoreRequestV1 = {
    schema: "restore-request-v1",
    sessionId: "triad",
    spans: [{ nodeId: "n1", range, digest }],
  };
  const shard: ExactShardV1 = {
    schema: "exact-shard-v1",
    sessionId: "triad",
    range,
    kind: "exact",
    originalBytes: bytes,
    digest,
    byteCount: bytes.length,
    case: "anchor",
  };
  const event: EventV2 = {
    schema: "event-v2",
    sessionId: "triad",
    seq: 1n,
    eventId: "e1",
    role: "user",
    kind: "message",
    originalBytes: bytes,
    bytesDigest: `sha256:${digest}`,
    utf8: { valid: true, text: "hello" },
    occurredAtMs: 1n,
  };

  test("A: an indexed exact shard serves the restoration", () => {
    const r = restoreSources(request, { exactShards: [shard], ledgerEvents: [event] });
    assert.equal(r.mode, "A");
    assert.equal(r.restored[0]!.source, "exact-shard");
    assert.equal(verifyRestored(r, request).ok, true);
  });

  test("B: a missing exact index forces the INDEPENDENT ledger range scan", () => {
    const r = restoreSources(request, { exactShards: [], ledgerEvents: [event] });
    assert.equal(r.mode, "B");
    assert.equal(r.restored[0]!.source, "ledger-scan");
    assert.deepEqual(r.restored[0]!.bytes, bytes, "B produces byte-identical output to A");
    assert.equal(verifyRestored(r, request).ok, true);
  });

  test("C: neither source exists — the span is OMITTED and the loss disclosed", () => {
    const r = restoreSources(request, { exactShards: [], ledgerEvents: [] });
    assert.equal(r.mode, "C");
    assert.equal(r.restored.length, 0, "nothing fabricated from a derived source");
    assert.deepEqual(r.missing, ["n1"]);
    assert.equal(r.semanticLossStated, true, "C states its semantic loss");
    assert.ok(r.codes.includes("HEAL_RESTORE_SOURCE_MISSING"));
  });
});

describe("VC6B acceptance: disjoint spans + arbitrary payloads", () => {
  /** Build N disjoint spans with arbitrary (non-UTF8-safe) byte payloads. */
  function disjoint(n: number): {
    request: RestoreRequestV1;
    reader: RestoreReader;
  } {
    const shards: ExactShardV1[] = [];
    const spans = Array.from({ length: n }, (_v, i) => {
      const payload = new Uint8Array([i & 0xff, 0x80, 0xff, (i * 7) & 0xff]);
      const range: ShardRange = {
        sessionId: "disjoint",
        seqStart: BigInt(i + 1),
        seqEnd: BigInt(i + 1),
        byteStart: i * 4,
        byteEnd: i * 4 + 4,
      };
      shards.push({
        schema: "exact-shard-v1",
        sessionId: "disjoint",
        range,
        kind: "exact",
        originalBytes: payload,
        digest: hex(payload),
        byteCount: payload.length,
        case: "invalid-utf8",
      });
      return { nodeId: `n${i}`, range, digest: hex(payload) };
    });
    return {
      request: { schema: "restore-request-v1", sessionId: "disjoint", spans },
      reader: { exactShards: shards, ledgerEvents: [] },
    };
  }

  test(`${RESTORE_LIMIT_SPANS} disjoint spans at the boundary all restore byte-identically`, () => {
    const { request, reader } = disjoint(RESTORE_LIMIT_SPANS);
    const result = restoreSources(request, reader);
    assert.equal(result.mode, "A");
    assert.equal(result.restored.length, RESTORE_LIMIT_SPANS);
    assert.deepEqual(result.codes, []);
    assert.equal(verifyRestored(result, request).ok, true);
    for (let i = 0; i < RESTORE_LIMIT_SPANS; i++) {
      assert.deepEqual(result.restored[i]!.bytes, reader.exactShards[i]!.originalBytes);
    }
  });

  test("70 disjoint spans exceed the limit and are rejected before any read", () => {
    const { request } = disjoint(70);
    // Empty readers: a bounds check that ran after a read would say SOURCE_MISSING.
    const result = restoreSources(request, { exactShards: [], ledgerEvents: [] });
    assert.deepEqual(result.codes, ["HEAL_RESTORE_LIMIT"]);
    assert.equal(result.mode, "C");
    assert.equal(result.restored.length, 0);
    assert.equal(result.missing.length, 70);
  });
});

describe("VC6B acceptance: flag-off byte-identical arithmetic", () => {
  test("restore + verify are pure: identical with MEGACOMPACT_VC6B unset vs '0'", () => {
    const saved = process.env.MEGACOMPACT_VC6B;
    try {
      const runAll = (): Array<{
        result: RestoreResultV1;
        verification: ReturnType<typeof verifyRestored>;
      }> =>
        ALL_IDS.map((id) => {
          const { result, verification } = runReal(restorationFixture(id));
          return { result, verification };
        });

      // Default: flag ON (env unset → sprintFlag defaults true).
      delete process.env.MEGACOMPACT_VC6B;
      const on = runAll();
      // Explicit OFF: the restore/verify math is pure and must not change.
      process.env.MEGACOMPACT_VC6B = "0";
      const off = runAll();

      assert.deepEqual(off, on, "flag OFF must be byte-identical to flag ON");
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6B;
      else process.env.MEGACOMPACT_VC6B = saved;
    }
  });
});

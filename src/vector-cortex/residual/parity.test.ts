/**
 * parity.test.ts — Reed–Solomon (9,6) erasure parity over GF(2^8)/0x11d (VC4B).
 *
 * Covers the field arithmetic, the systematic generator construction, every
 * erasure subset of size <= 3, digest-based corruption detection, and the
 * fail-closed behavior beyond the parity budget. Real logic, no mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  gfAdd,
  gfDiv,
  gfInv,
  gfInvert,
  gfMatMul,
  gfMatrix,
  gfMul,
  gfPow,
  gfSet,
  vandermonde,
} from "./gf256.js";
import {
  detectCorruptShards,
  encodeShards,
  generatorIsSystematic,
  parityRows,
  recoverStream,
  recoverWithErasures,
  shardLength,
  sha256Hex,
  systematicGenerator,
} from "./parity.js";
import { RS_DATA_SHARDS, RS_TOTAL_SHARDS, type ParityShardV1 } from "./types.js";

/** A deterministic protected-stream stand-in. */
function stream(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_v, i) => (i * 7 + 13) % 256);
}

/** Every subset of `pool` with size <= `max`. */
function subsets(pool: readonly number[], max: number): number[][] {
  const out: number[][] = [[]];
  for (let size = 1; size <= max; size++) {
    const build = (start: number, acc: number[]): void => {
      if (acc.length === size) {
        out.push([...acc]);
        return;
      }
      for (let i = start; i < pool.length; i++) build(i + 1, [...acc, pool[i]!]);
    };
    build(0, []);
  }
  return out;
}

describe("GF(2^8) field arithmetic (polynomial 0x11d)", () => {
  test("addition is XOR and is its own inverse", () => {
    for (let a = 0; a < 256; a += 17) {
      for (let b = 0; b < 256; b += 23) {
        assert.equal(gfAdd(a, b), a ^ b);
        assert.equal(gfAdd(gfAdd(a, b), b), a);
      }
    }
  });

  test("multiplication is commutative with identity 1 and absorbing 0", () => {
    for (let a = 0; a < 256; a += 11) {
      assert.equal(gfMul(a, 1), a);
      assert.equal(gfMul(a, 0), 0);
      for (let b = 0; b < 256; b += 13) {
        assert.equal(gfMul(a, b), gfMul(b, a));
      }
    }
  });

  test("every non-zero element has a multiplicative inverse", () => {
    for (let a = 1; a < 256; a++) {
      assert.equal(gfMul(a, gfInv(a)), 1, `inverse of ${a}`);
      assert.equal(gfDiv(a, a), 1);
    }
  });

  test("multiplication is associative and distributes over addition", () => {
    for (let a = 1; a < 256; a += 29) {
      for (let b = 1; b < 256; b += 31) {
        for (let c = 1; c < 256; c += 37) {
          assert.equal(gfMul(gfMul(a, b), c), gfMul(a, gfMul(b, c)));
          assert.equal(gfMul(a, gfAdd(b, c)), gfAdd(gfMul(a, b), gfMul(a, c)));
        }
      }
    }
  });

  test("gfPow matches repeated multiplication", () => {
    for (const base of [2, 3, 5, 17, 255]) {
      let acc = 1;
      for (let e = 0; e < 12; e++) {
        assert.equal(gfPow(base, e), acc, `${base}^${e}`);
        acc = gfMul(acc, base);
      }
    }
  });

  test("dividing by zero throws rather than returning a wrong field element", () => {
    assert.throws(() => gfDiv(5, 0), RangeError);
    assert.throws(() => gfInv(0), RangeError);
  });
});

describe("matrix algebra over GF(2^8)", () => {
  test("inverting a matrix yields the identity when multiplied back", () => {
    const v = vandermonde(RS_DATA_SHARDS, RS_DATA_SHARDS);
    const inv = gfInvert(v);
    assert.ok(inv, "the Vandermonde top square is invertible");
    const product = gfMatMul(v, inv);
    for (let r = 0; r < RS_DATA_SHARDS; r++) {
      for (let c = 0; c < RS_DATA_SHARDS; c++) {
        assert.equal(product.data[r * RS_DATA_SHARDS + c], r === c ? 1 : 0);
      }
    }
  });

  test("a singular matrix returns null rather than a bogus inverse", () => {
    const m = gfMatrix(3, 3);
    // Two identical rows => singular.
    gfSet(m, 0, 0, 1); gfSet(m, 0, 1, 2); gfSet(m, 0, 2, 3);
    gfSet(m, 1, 0, 1); gfSet(m, 1, 1, 2); gfSet(m, 1, 2, 3);
    gfSet(m, 2, 0, 4); gfSet(m, 2, 1, 5); gfSet(m, 2, 2, 6);
    assert.equal(gfInvert(m), null);
  });

  test("a non-square matrix is not invertible", () => {
    assert.equal(gfInvert(gfMatrix(2, 3)), null);
  });

  test("the Vandermonde matrix uses evaluation points alpha_r = r+1", () => {
    const v = vandermonde(RS_TOTAL_SHARDS, RS_DATA_SHARDS);
    for (let r = 0; r < RS_TOTAL_SHARDS; r++) {
      assert.equal(v.data[r * RS_DATA_SHARDS + 0], 1, "column 0 is alpha^0 = 1");
      assert.equal(v.data[r * RS_DATA_SHARDS + 1], r + 1, "column 1 is alpha itself");
    }
  });
});

describe("systematic RS(9,6) generator", () => {
  test("the top 6x6 square is the identity (data shards pass through)", () => {
    assert.equal(generatorIsSystematic(), true);
  });

  test("the three parity rows are non-trivial and distinct", () => {
    const rows = parityRows();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.length, RS_DATA_SHARDS);
      assert.ok(row.some((v) => v !== 0), "a parity row is not all-zero");
    }
    const encoded = rows.map((r) => r.join(","));
    assert.equal(new Set(encoded).size, 3, "the parity rows are distinct");
  });

  test("the generator is stable across calls (cached, deterministic)", () => {
    assert.deepEqual(
      Array.from(systematicGenerator().data),
      Array.from(systematicGenerator().data),
    );
  });
});

describe("shard encoding", () => {
  test("produces exactly 9 equal-length shards (6 data + 3 parity)", () => {
    const s = encodeShards(stream(5000));
    assert.equal(s.length, RS_TOTAL_SHARDS);
    assert.equal(s.filter((x) => x.kind === "data").length, RS_DATA_SHARDS);
    assert.equal(s.filter((x) => x.kind === "parity").length, 3);
    const len = s[0]!.bytes.length;
    for (const shard of s) assert.equal(shard.bytes.length, len);
    assert.equal(len, shardLength(5000));
  });

  test("data shards concatenate back to the zero-padded stream", () => {
    const src = stream(5000);
    const s = encodeShards(src);
    const len = s[0]!.bytes.length;
    const joined = new Uint8Array(len * RS_DATA_SHARDS);
    for (let i = 0; i < RS_DATA_SHARDS; i++) joined.set(s[i]!.bytes, i * len);
    assert.deepEqual(Array.from(joined.subarray(0, src.length)), Array.from(src));
  });

  test("every shard carries its own SHA-256 and the unpadded stream length", () => {
    const s = encodeShards(stream(777));
    for (const shard of s) {
      assert.equal(shard.digest, sha256Hex(shard.bytes));
      assert.equal(shard.streamLength, 777);
    }
  });

  test("an empty stream still produces nine (zero-length) shards", () => {
    const s = encodeShards(new Uint8Array(0));
    assert.equal(s.length, RS_TOTAL_SHARDS);
    for (const shard of s) assert.equal(shard.bytes.length, 0);
  });
});

describe("erasure recovery", () => {
  const src = stream(5000);
  const shards = encodeShards(src);

  test("every erasure subset of size <= 3 reconstructs the stream exactly", () => {
    const all = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const cases = subsets(all, 3);
    assert.equal(cases.length, 1 + 9 + 36 + 84, "130 subsets of size <= 3");
    for (const erased of cases) {
      const kept = shards.filter((s) => !erased.includes(s.index));
      const r = recoverStream(kept);
      assert.equal(r.ok, true, `erasure ${JSON.stringify(erased)} recovers`);
      if (!r.ok) throw new Error("unreachable");
      assert.deepEqual(
        Array.from(r.stream),
        Array.from(src),
        `erasure ${JSON.stringify(erased)} is byte-exact`,
      );
    }
  });

  test("four erasures fail closed with RES_TOO_MANY_ERASURES", () => {
    const kept = shards.filter((s) => ![0, 1, 2, 3].includes(s.index));
    const r = recoverStream(kept);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "RES_TOO_MANY_ERASURES");
  });

  test("a duplicate shard index is rejected", () => {
    const r = recoverStream([...shards.slice(0, 6), shards[0]!]);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "RES_DUPLICATE_SHARD_INDEX");
  });

  test("a wrong-length shard is rejected", () => {
    const bad: ParityShardV1 = {
      ...shards[0]!,
      bytes: shards[0]!.bytes.subarray(0, 10),
    };
    const r = recoverStream([bad, ...shards.slice(1, 7)]);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "RES_SHARD_LENGTH_MISMATCH");
  });

  test("an out-of-range shard index is rejected", () => {
    const bad: ParityShardV1 = { ...shards[0]!, index: 99 };
    const r = recoverStream([bad, ...shards.slice(1, 7)]);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "RES_DUPLICATE_SHARD_INDEX");
  });
});

describe("corruption detection (digest, never blind correction)", () => {
  const src = stream(5000);
  const shards = encodeShards(src);
  const flip = (index: number): ParityShardV1[] =>
    shards.map((s) =>
      s.index === index
        ? { ...s, bytes: (() => { const b = Uint8Array.from(s.bytes); b[0] ^= 0xff; return b; })() }
        : s,
    );

  test("a corrupt shard is detected by its per-shard SHA-256", () => {
    assert.deepEqual(detectCorruptShards(flip(4)), [4]);
    assert.deepEqual(detectCorruptShards(shards), []);
  });

  test("a corrupt shard is promoted to a known erasure and recovery succeeds", () => {
    const r = recoverStream(flip(4));
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(Array.from(r.stream), Array.from(src));
  });

  test("a corrupt PARITY shard is the third erasure alongside two marked data erasures", () => {
    // Unique failure injection (sprint contract): flip one parity shard while
    // marking two data shards erased. The per-shard SHA-256 check marks the
    // corrupt parity shard as the third known erasure; recovery from the
    // remaining six shards succeeds.
    const corrupted = flip(7).filter((s) => ![1, 3].includes(s.index));
    assert.equal(corrupted.length, 7, "two data shards were erased");
    const r = recoverStream(corrupted);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(Array.from(r.stream), Array.from(src));
  });

  test("three marked data erasures PLUS a corrupt parity shard returns RES_TOO_MANY_ERASURES", () => {
    // The companion case: it must fail closed WITHOUT attempting unknown-error
    // correction, because 3 marked + 1 detected = 4 > m=3.
    const r = recoverWithErasures(flip(7), [0, 1, 2]);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "RES_TOO_MANY_ERASURES");
  });

  test("recoverWithErasures rejects more than three marked erasures up front", () => {
    const r = recoverWithErasures(shards, [0, 1, 2, 3]);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "RES_TOO_MANY_ERASURES");
  });

  test("recoverWithErasures recovers a legal marked-erasure set exactly", () => {
    const r = recoverWithErasures(shards, [1, 4, 8]);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(Array.from(r.stream), Array.from(src));
  });
});

// VC4B residual codec + parity fixtures
// (`conformance/vector-cortex/v2/residual/`).
//
// Owner VC4B (ResidualCodecV1 / ParityShardV1). Each fixture declares a DCT /
// quantization / parity / admission condition the acceptance test executes
// against the REAL residual codec (src/vector-cortex/residual/{dct,quantize,
// parity,codec}.js), no mocks. `input.scenario` names the condition;
// `expected.ok` pins the successful behavior or the exact failure `code`.
//
// Payloads are described GENERATIVELY (kind + length + seed) rather than
// embedded as base64 so a 8193-byte case costs a few bytes of fixture. The
// acceptance test materializes them with the same deterministic generator
// (`materialize()` mirrored in the test), so the bytes are exact and stable.
//
// RES-001..050 are the registered VC4B conformance rows; the three NAMED rows
// (RES-DCT-001 / RES-RS-002 / RES-ADMIT-003) pin the sprint's headline
// assertions (4096-byte impulse matches the coefficient golden / shards 1,4,8
// erased reconstruct all bytes / the 95% boundary admits and one byte above
// rejects).

import { producer } from "./common.mjs";

const RESIDUAL_SCHEMA = "schemas/residual-fixture.schema.json";

function residualFixture(id, assertion, input, expected) {
  return { id, schema: RESIDUAL_SCHEMA, producer, assertion, kind: "residual", input, expected };
}

/** Generative payload descriptors (materialized identically by the test). */
const empty = () => ({ kind: "empty" });
const zeros = (length) => ({ kind: "zeros", length });
const constant = (length, value) => ({ kind: "constant", length, value });
const sequence = (length) => ({ kind: "sequence", length });
const lcg = (length, seed) => ({ kind: "lcg", length, seed });
const text = (length) => ({ kind: "text", length });
const invalidUtf8 = (length) => ({ kind: "invalid-utf8", length });
const dcOutlier = (length, outlierOffset) => ({ kind: "dc-outlier", length, outlierOffset });
const alternating = (length) => ({ kind: "alternating", length });

/** A generous exact-compressed size always clears the admission ceiling. */
const generous = { admissionMode: "generous" };

export const fixtures = [
  // ── DCT / transform (RES-001..010) ────────────────────────────────────────
  residualFixture("RES-001", "a 4096-byte impulse block transforms and inverts to the exact input bytes",
    { scenario: "dct-impulse", payload: dcOutlier(4096, 0), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-002", "an all-zero block quantizes to scale 0 and round-trips exactly",
    { scenario: "dct-zero-block", payload: zeros(4096), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-003", "a constant 0xff block (maximum DC) round-trips exactly",
    { scenario: "dct-constant-max", payload: constant(4096, 255), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-004", "an alternating 0x00/0xff block (maximum Nyquist energy) round-trips exactly",
    { scenario: "dct-alternating", payload: alternating(4096), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-005", "a short payload zero-pads ONLY the final block and truncates on decode",
    { scenario: "dct-partial-block", payload: text(11), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-006", "an exactly-one-block payload produces exactly one block",
    { scenario: "dct-exact-block", payload: sequence(4096), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-007", "a payload one byte over the block size produces two blocks",
    { scenario: "dct-block-plus-one", payload: sequence(4097), ...generous },
    { ok: true, admitted: true, blockCount: 2, exactRoundTrip: true }),
  residualFixture("RES-008", "an empty payload produces zero blocks and decodes to zero bytes",
    { scenario: "dct-empty", payload: empty(), ...generous },
    { ok: true, admitted: true, blockCount: 0, exactRoundTrip: true }),
  residualFixture("RES-009", "a multi-block payload (8193 bytes) round-trips exactly across three blocks",
    { scenario: "dct-multi-block", payload: sequence(8193), ...generous },
    { ok: true, admitted: true, blockCount: 3, exactRoundTrip: true }),
  residualFixture("RES-010", "the transform is deterministic (identical input yields identical coefficients)",
    { scenario: "dct-deterministic", payload: lcg(4096, 7), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),

  // ── Quantization + corrections (RES-011..020) ─────────────────────────────
  residualFixture("RES-011", "a DC-dominant block with a single outlier emits exact corrections and still decodes byte-exactly",
    { scenario: "quantize-corrections", payload: dcOutlier(4096, 2000), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true, minCorrections: 1 }),
  residualFixture("RES-012", "invalid UTF-8 bytes are carried through the codec unchanged (never normalized)",
    { scenario: "quantize-invalid-utf8", payload: invalidUtf8(512), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-013", "a pseudorandom block round-trips byte-exactly",
    { scenario: "quantize-random", payload: lcg(4096, 12345), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-014", "a sparse block (mostly zero, few spikes) round-trips byte-exactly",
    { scenario: "quantize-sparse", payload: dcOutlier(4096, 4095), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-015", "a single-byte payload round-trips byte-exactly",
    { scenario: "quantize-single-byte", payload: constant(1, 42), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true }),
  residualFixture("RES-016", "non-finite coefficients are rejected with RES_QUANTIZE_RANGE",
    { scenario: "quantize-nonfinite", payload: empty() },
    { ok: false, code: "RES_QUANTIZE_RANGE" }),
  residualFixture("RES-017", "an int16-saturating coefficient is rejected with RES_QUANTIZE_RANGE",
    { scenario: "quantize-saturation", payload: empty() },
    { ok: false, code: "RES_QUANTIZE_RANGE" }),
  residualFixture("RES-018", "a duplicate correction offset is rejected with RES_CORRECTION_DUPLICATE_OFFSET",
    { scenario: "corrections-duplicate-offset", payload: empty() },
    { ok: false, code: "RES_CORRECTION_DUPLICATE_OFFSET" }),
  residualFixture("RES-019", "an out-of-range correction offset is rejected with RES_CORRECTION_RANGE",
    { scenario: "corrections-out-of-range", payload: empty() },
    { ok: false, code: "RES_CORRECTION_RANGE" }),
  residualFixture("RES-020", "the correction stream serializes and parses back identically (ascending blocks, sorted offsets)",
    { scenario: "corrections-roundtrip", payload: empty() },
    { ok: true }),

  // ── Reed–Solomon parity (RES-021..040) ────────────────────────────────────
  residualFixture("RES-021", "the systematic generator's top 6x6 square is the identity",
    { scenario: "parity-systematic", payload: sequence(5000), ...generous },
    { ok: true }),
  residualFixture("RES-022", "encoding produces exactly 9 shards (6 data + 3 parity) of equal length",
    { scenario: "parity-shard-geometry", payload: sequence(5000), ...generous },
    { ok: true }),
  residualFixture("RES-023", "a complete shard set decodes without any reconstruction",
    { scenario: "parity-no-erasure", payload: sequence(5000), erasedIndices: [], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-024", "one erased data shard reconstructs every byte",
    { scenario: "parity-one-data-erasure", payload: sequence(5000), erasedIndices: [0], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-025", "one erased parity shard reconstructs every byte",
    { scenario: "parity-one-parity-erasure", payload: sequence(5000), erasedIndices: [8], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-026", "two erased data shards reconstruct every byte",
    { scenario: "parity-two-data-erasures", payload: sequence(5000), erasedIndices: [2, 5], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-027", "three erased shards (2 data + 1 parity) reconstruct every byte",
    { scenario: "parity-three-mixed-erasures", payload: sequence(5000), erasedIndices: [1, 3, 7], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-028", "all three parity shards erased still reconstructs from the six data shards",
    { scenario: "parity-all-parity-erased", payload: sequence(5000), erasedIndices: [6, 7, 8], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-029", "three erased data shards reconstruct from the remaining three data + three parity",
    { scenario: "parity-three-data-erased", payload: sequence(5000), erasedIndices: [0, 1, 2], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-030", "four erased shards exceed the parity budget (RES_TOO_MANY_ERASURES)",
    { scenario: "parity-four-erasures", payload: sequence(5000), erasedIndices: [0, 1, 2, 3], ...generous },
    { ok: false, code: "RES_TOO_MANY_ERASURES" }),
  residualFixture("RES-031", "a corrupt shard is detected by its SHA-256 and promoted to a known erasure",
    { scenario: "parity-corrupt-detected", payload: sequence(5000), corruptIndices: [4], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-032", "a corrupt parity shard plus two marked data erasures still recovers (the corrupt shard is the third erasure)",
    { scenario: "parity-corrupt-plus-two-erasures", payload: sequence(5000), erasedIndices: [1, 3], corruptIndices: [7], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-033", "three marked data erasures plus one corrupt parity shard returns RES_TOO_MANY_ERASURES without unknown-error correction",
    { scenario: "parity-three-erasures-plus-corrupt", payload: sequence(5000), markErased: [0, 1, 2], corruptIndices: [7], ...generous },
    { ok: false, code: "RES_TOO_MANY_ERASURES" }),
  residualFixture("RES-034", "a duplicate shard index is rejected (RES_DUPLICATE_SHARD_INDEX)",
    { scenario: "parity-duplicate-index", payload: sequence(5000), mutate: "duplicate-index", ...generous },
    { ok: false, code: "RES_DUPLICATE_SHARD_INDEX" }),
  residualFixture("RES-035", "a wrong-length shard is rejected (RES_SHARD_LENGTH_MISMATCH)",
    { scenario: "parity-bad-length", payload: sequence(5000), mutate: "truncate-shard", ...generous },
    { ok: false, code: "RES_SHARD_LENGTH_MISMATCH" }),
  residualFixture("RES-036", "an empty shard set fails closed (RES_TOO_MANY_ERASURES)",
    { scenario: "parity-empty-set", payload: sequence(5000), erasedIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8], ...generous },
    { ok: false, code: "RES_TOO_MANY_ERASURES" }),
  residualFixture("RES-037", "shard recovery is deterministic across repeated runs",
    { scenario: "parity-deterministic", payload: sequence(5000), erasedIndices: [2, 6], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-038", "an empty payload's shard set still recovers under three erasures",
    { scenario: "parity-empty-payload", payload: empty(), erasedIndices: [0, 4, 8], ...generous },
    { ok: true, exactRoundTrip: true }),
  residualFixture("RES-039", "a corrupted protected stream fails the payload digest (RES_PAYLOAD_DIGEST_MISMATCH)",
    { scenario: "parity-corrupt-payload-digest", payload: sequence(5000), mutate: "corrupt-payload-digest", ...generous },
    { ok: false, code: "RES_PAYLOAD_DIGEST_MISMATCH" }),
  residualFixture("RES-040", "a stream whose header magic is wrong is rejected (RES_HEADER_INVALID)",
    { scenario: "parity-bad-magic", payload: sequence(5000), mutate: "bad-magic", ...generous },
    { ok: false, code: "RES_HEADER_INVALID" }),

  // ── Admission accounting (RES-041..050) ───────────────────────────────────
  residualFixture("RES-041", "encoded size exactly at the 95% ceiling is admitted",
    { scenario: "admit-at-ceiling", payload: text(64), admissionMode: "at-ceiling" },
    { ok: true, admitted: true }),
  residualFixture("RES-042", "one byte above the 95% ceiling is rejected (RES_NOT_ADMITTED)",
    { scenario: "admit-one-above", payload: text(64), admissionMode: "one-below-ceiling" },
    { ok: true, admitted: false, code: "RES_NOT_ADMITTED" }),
  residualFixture("RES-043", "a zero exact-compressed size can never admit",
    { scenario: "admit-zero-exact", payload: text(64), exactCompressedSize: 0, admissionMode: "explicit" },
    { ok: true, admitted: false, code: "RES_NOT_ADMITTED" }),
  residualFixture("RES-044", "a generous exact-compressed size admits",
    { scenario: "admit-generous", payload: text(64), ...generous },
    { ok: true, admitted: true }),
  residualFixture("RES-045", "the accounting counts every persisted byte (stream + all nine shards + metadata)",
    { scenario: "admit-accounting-total", payload: sequence(5000), ...generous },
    { ok: true, admitted: true }),
  residualFixture("RES-046", "the admission ceiling is floor(0.95 * exactCompressedSize) in integer arithmetic",
    { scenario: "admit-ceiling-arithmetic", payload: text(64), ...generous },
    { ok: true, admitted: true }),
  residualFixture("RES-047", "admission never compares coefficient bytes alone (shard metadata is counted)",
    { scenario: "admit-shard-metadata-counted", payload: sequence(5000), ...generous },
    { ok: true, admitted: true }),
  residualFixture("RES-048", "an admitted artifact's decode digest equals the original payload digest",
    { scenario: "admit-digest-verified", payload: lcg(6000, 99), ...generous },
    { ok: true, admitted: true, exactRoundTrip: true }),
  residualFixture("RES-049", "a rejected artifact reports accounting without a codec or shards (mode B forced)",
    { scenario: "admit-rejected-accounting", payload: text(64), admissionMode: "one-below-ceiling" },
    { ok: true, admitted: false, code: "RES_NOT_ADMITTED" }),
  residualFixture("RES-050", "aggregate metrics accumulate counts and byte totals only (never payload)",
    { scenario: "admit-metrics-aggregate", payload: text(64), ...generous },
    { ok: true, admitted: true }),
];

export const named = [
  residualFixture(
    "RES-DCT-001",
    "a 4096-byte impulse matches the coefficient golden (named)",
    { scenario: "dct-impulse-golden", payload: dcOutlier(4096, 0), ...generous },
    { ok: true, admitted: true, blockCount: 1, exactRoundTrip: true },
  ),
  residualFixture(
    "RES-RS-002",
    "shards 1, 4 and 8 erased reconstruct all bytes (named)",
    { scenario: "parity-erase-1-4-8", payload: sequence(5000), erasedIndices: [1, 4, 8], ...generous },
    { ok: true, exactRoundTrip: true },
  ),
  residualFixture(
    "RES-ADMIT-003",
    "the 95% boundary admits and one byte above rejects (named)",
    { scenario: "admit-boundary", payload: text(64), admissionMode: "at-ceiling" },
    { ok: true, admitted: true },
  ),
];

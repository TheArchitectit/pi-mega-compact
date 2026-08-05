// VC8C canary selection + external Rust parity fixtures
// (`conformance/vector-cortex/v2/cross-language/`).
//
// Owner VC8C (selectEngine / encodeNeutralFrame / decodeNeutralFrame /
// compareFixtureOutput). The acceptance test feeds these verbatim into the
// REAL production modules (src/vector-cortex/platform/{select,cross-read}.js),
// no mocks.
//
// BOUNDED BY CONSTRUCTION. Every fixture declares its fixtureId, the expected
// output bytes, and the expected failure code. The selector's admission gates
// are exercised by fixtures RUST-ABI-001, RUST-ERR-002, and RUST-META-003.

import { producer } from "./common.mjs";

const SCHEMA = "schemas/cross-language-fixture.schema.json";

const SHA_64 = "a".repeat(64);
const COMMIT_40 = "0".repeat(40);

/** 30 numbered RUST fixtures: valid golden exchanges (RUST-001..028) + edge cases. */
function numberedFixtures() {
  const fixtures = [];
  // RUST-001..025: valid golden exchanges for the five EventV2-style records.
  const sampleBytes = [
    "cafebabe",
    "deadbeef",
    "8badf00d",
    "c0ffee42",
    "feedface",
    "baadf00d",
    "abcdef01",
    "12345678",
    "9abcdef0",
    "0fedcba9",
    "1111abcd",
    "2222ef01",
    "3333abcd",
    "4444ef01",
    "5555abcd",
    "6666ef01",
    "7777abcd",
    "8888ef01",
    "9999abcd",
    "aaaaef01",
    "bbbbabcd",
    "cccc ef01",
    "ddddabcd",
    "eeeeef01",
    "ffffabcd",
  ];
  for (let i = 0; i < 25; i++) {
    const id = `RUST-${String(i + 1).padStart(3, "0")}`;
    fixtures.push({
      id,
      schema: SCHEMA,
      kind: "cross-language-golden",
      producer,
      fixtureId: id,
      inputHex: sampleBytes[i % sampleBytes.length].replace(" ", ""),
      expectedOutputHex: sampleBytes[i % sampleBytes.length].replace(" ", ""),
      expectedFailureCode: null,
      expected: { ok: true },
    });
  }
  // RUST-026: invalid UTF-8 failure code exchange.
  fixtures.push({
    id: "RUST-026",
    schema: SCHEMA,
    kind: "cross-language-error",
    producer,
    fixtureId: "RUST-026",
    inputHex: "fffe80",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_PARITY_MISMATCH",
    expected: { ok: false, code: "RUST_PARITY_MISMATCH" },
  });
  // RUST-027: truncated frame.
  fixtures.push({
    id: "RUST-027",
    schema: SCHEMA,
    kind: "cross-language-truncated",
    producer,
    fixtureId: "RUST-027",
    inputHex: "00000010",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_FRAME_TRUNCATED",
    expected: { ok: false, code: "RUST_FRAME_TRUNCATED" },
  });
  // RUST-028: ABI mismatch rejection.
  fixtures.push({
    id: "RUST-028",
    schema: SCHEMA,
    kind: "cross-language-abi-mismatch",
    producer,
    fixtureId: "RUST-028",
    inputHex: "00",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_ABI_MISMATCH",
    expected: { ok: false, code: "RUST_ABI_MISMATCH" },
  });
  // RUST-029: platform unsupported.
  fixtures.push({
    id: "RUST-029",
    schema: SCHEMA,
    kind: "cross-language-platform",
    producer,
    fixtureId: "RUST-029",
    inputHex: "00",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_PLATFORM_UNSUPPORTED",
    expected: { ok: false, code: "RUST_PLATFORM_UNSUPPORTED" },
  });
  // RUST-030: artifact missing.
  fixtures.push({
    id: "RUST-030",
    schema: SCHEMA,
    kind: "cross-language-missing",
    producer,
    fixtureId: "RUST-030",
    inputHex: "00",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_ARTIFACT_MISSING",
    expected: { ok: false, code: "RUST_ARTIFACT_MISSING" },
  });
  return fixtures;
}

const fixtures = numberedFixtures();

const named = [
  {
    id: "RUST-ABI-001",
    schema: SCHEMA,
    kind: "cross-language-abi-exchange",
    producer,
    fixtureId: "RUST-ABI-001",
    inputHex: "cafebabe",
    expectedOutputHex: "cafebabe",
    expectedFailureCode: null,
    expected: { ok: true },
  },
  {
    id: "RUST-ERR-002",
    schema: SCHEMA,
    kind: "cross-language-error-code-exchange",
    producer,
    fixtureId: "RUST-ERR-002",
    inputHex: "fffe80",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_PARITY_MISMATCH",
    expected: { ok: false, code: "RUST_PARITY_MISMATCH" },
  },
  {
    id: "RUST-META-003",
    schema: SCHEMA,
    kind: "cross-language-cargo-digest-mismatch",
    producer,
    fixtureId: "RUST-META-003",
    inputHex: "00",
    expectedOutputHex: "",
    expectedFailureCode: "RUST_CARGO_DIGEST_MISMATCH",
    expected: { ok: false, code: "RUST_CARGO_DIGEST_MISMATCH" },
  },
];

export { fixtures, named };

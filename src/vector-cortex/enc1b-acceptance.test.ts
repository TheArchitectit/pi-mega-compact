/** ENC-1b acceptance aggregator (fixtures + contract scans, no mocks).
 *  Covers the ONNX runtime backend + embedder API Settings surface at the
 *  pure/contract level: (1) the fixture registration + kind-closure for
 *  ENC-ONNX-001..006 against the encoder-runtime-settings seam; (2) the
 *  failure triad's contract + redaction invariants by zero-tolerance source
 *  scans — the raw headers JSON is NEVER surfaced in the SetupStatusResponse
 *  contract (only `embeddingHeadersSet`) and never logged / echoed to a GET
 *  client (the ENC-1a key-redaction invariant is EXTENDED to the headers
 *  value); (3) the flag-agnostic export. The route-level POST/GET round-trip
 *  over a real tempdir `.mega-compact.env` lives in routes-setup.test.ts (the
 *  route's own test file); this aggregator is flag-agnostic (passes with
 *  ENC_1B ON or OFF). Local file reads only, zero network. All imports stay
 *  within src/ so the legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_1B_ENABLED } from "../config/vector-cortex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const ROOT = repoRoot(HERE);
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const ENC_ONNX_IDS = [
  "ENC-ONNX-001",
  "ENC-ONNX-002",
  "ENC-ONNX-003",
  "ENC-ONNX-004",
  "ENC-ONNX-005",
  "ENC-ONNX-006",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface OnnxFixture {
  id: string; producer: string; assertion: string; kind: string;
  setup: Record<string, unknown>;
  expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): OnnxFixture {
  const row = readManifest().fixtures.find(
    (f) => f.id === id && f.path.startsWith("encoder-runtime-settings/"),
  );
  assert.ok(row, `fixture ${id} registered under encoder-runtime-settings/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as OnnxFixture;
}

describe("ENC-1b conformance registration", () => {
  test("manifest registers ENC-ONNX-001..006 under the encoder-runtime-settings seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_ONNX_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.path, `encoder-runtime-settings/${id}.json`, `${id} path`);
      assert.equal(row.algorithm, "encoder-runtime-settings", `${id} algorithm`);
      assert.equal(row.schema, "schemas/encoder-runtime-settings-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.expected, "ok", `${id} expected`);
    }
    const schemaRow = m.fixtures.find(
      (f) => f.path === "schemas/encoder-runtime-settings-fixture.schema.json",
    );
    assert.ok(schemaRow, "encoder-runtime-settings schema registered");
    assert.ok(m.owner.split(",").includes("ENC-1b"), "owner CSV includes ENC-1b");
    assert.ok(m.domain.split(";").includes("encoder-runtime-settings"), "domain includes encoder-runtime-settings");
    assert.ok(m.owner.split(",").includes("ENC-1a"), "prior ENC-1a owner preserved");
    assert.ok(m.domain.split(";").includes("encoder-settings"), "prior ENC-1a domain preserved");
  });

  test("the 6 ENC-ONNX fixture kinds are closed to the spec branch set", () => {
    const kinds = new Set<string>();
    for (const id of ENC_ONNX_IDS) {
      const fx = fixture(id);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.equal(fx.expected_outcome, "ok", `${id}: outcome`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "round-trip-set-headers-redacted",
      "round-trip-set-dim-validated",
      "dim-over-cap-rejected",
      "headers-invalid-json-rejected",
      "native-opt-in-flag",
      "flag-off",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present`);
    }
  });
});

describe("ENC-1b flag + contract additivity", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_1B_ENABLED(), "boolean");
  });

  test("setup status carries the additive ENC-1b fields incl embeddingHeadersSet boolean", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const getBlock = contracts.slice(
      contracts.indexOf("interface SetupStatusResponse"),
      contracts.indexOf("interface DetectResult"),
    );
    assert.match(getBlock, /embeddingDim\?:\s*string/, "status carries optional embeddingDim");
    assert.match(getBlock, /embeddingHeadersSet\?:\s*boolean/, "status carries optional embeddingHeadersSet boolean");
    assert.match(getBlock, /allowRemoteEmbedder\?:\s*boolean/, "status carries optional allowRemoteEmbedder boolean");
    assert.match(getBlock, /encoderNativeOptIn\?:\s*boolean/, "status carries optional encoderNativeOptIn boolean");
    assert.match(getBlock, /encoderBackend\?:\s*"wasm"\s*\|\s*"native"/, "status carries encoderBackend wasm|native");
    assert.match(getBlock, /encoderDemotionReason\?:\s*string\s*\|\s*null/, "status carries encoderDemotionReason string|null");
  });

  test("redaction zero-tolerance: the status response NEVER declares a raw embeddingHeaders field (only embeddingHeadersSet)", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const getBlock = contracts.slice(
      contracts.indexOf("interface SetupStatusResponse"),
      contracts.indexOf("interface DetectResult"),
    );
    assert.ok(
      !getBlock.match(/embeddingHeaders\??:/),
      "SetupStatusResponse must not declare a raw `embeddingHeaders` field (only embeddingHeadersSet)",
    );
  });

  test("configure request carries the four ENC-1b keys additively", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const postBlock = contracts.slice(
      contracts.indexOf("interface SetupConfigureRequest"),
      contracts.indexOf("interface SetupConfigureResponse"),
    );
    assert.match(postBlock, /embeddingDim\?:\s*string/, "configure request carries optional embeddingDim");
    assert.match(postBlock, /embeddingHeaders\?:\s*string/, "configure request carries optional embeddingHeaders");
    assert.match(postBlock, /allowRemoteEmbedder\?:\s*boolean/, "configure request carries optional allowRemoteEmbedder");
    assert.match(postBlock, /encoderNativeOptIn\?:\s*boolean/, "configure request carries optional encoderNativeOptIn");
  });

  test("the sibling module pins the four exact runtime env names the runtime reads", () => {
    const impl = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-setup-enc1b.ts"),
      "utf8",
    );
    assert.match(impl, /MEGACOMPACT_EMBEDDING_DIM/, "pins MEGACOMPACT_EMBEDDING_DIM");
    assert.match(impl, /MEGACOMPACT_EMBEDDING_HEADERS/, "pins MEGACOMPACT_EMBEDDING_HEADERS");
    assert.match(impl, /MEGACOMPACT_ALLOW_REMOTE_EMBEDDER/, "pins MEGACOMPACT_ALLOW_REMOTE_EMBEDDER");
    assert.match(impl, /MEGACOMPACT_ENCODER_NATIVE/, "pins MEGACOMPACT_ENCODER_NATIVE");
  });
});

describe("ENC-1b redaction + no-log invariants (zero-tolerance)", () => {
  const engineFile = join(ROOT, "extensions", "dashboard-server", "routes-setup-enc1b.ts");

  test("routes-setup.ts and the ENC-1b sibling contain no console.log", () => {
    for (const f of [join(ROOT, "extensions", "dashboard-server", "routes-setup.ts"), engineFile]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes("console.log"), `${f} must not call console.log`);
    }
  });

  test("route reader only exposes headersSet boolean — never the raw headers JSON value", () => {
    const impl = readFileSync(engineFile, "utf8");
    assert.match(impl, /headersSet: boolean/, "reader reports headersSet as a boolean");
    // Scope to the reader function only: its return must not carry a `headers:`
    // field holding the raw value (the writer legitimately takes a headers param
    // to persist to the file).
    const readStart = impl.indexOf("export function readEnc1bEnv");
    assert.ok(readStart >= 0, "readEnc1bEnv present");
    const readEnd = impl.indexOf("export function ", readStart + 1);
    const reader = impl.slice(readStart, readEnd);
    assert.ok(!reader.includes("headers: string"), "readEnc1bEnv never returns/logs a raw headers string field");
  });

  test("the reader-the-writer separation is preserved (selection is computed in a reader, never written)", () => {
    const impl = readFileSync(engineFile, "utf8");
    // The runtime-backend computation must go through the existing
    // selectRuntimeBackend (reader-only) — never a reimplemented literal.
    assert.match(impl, /selectRuntimeBackend/, "sibling invokes the runtime's own selection");
    assert.match(impl, /ENC_1B_MAX_EMBEDDING_DIM/, "dim validation uses the ENC-1b cap constant");
  });
});

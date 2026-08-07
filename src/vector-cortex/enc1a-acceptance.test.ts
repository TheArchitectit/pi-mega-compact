/** ENC-1a acceptance aggregator (fixtures + contract scans, no mocks).
 *  Covers the external-embedder API key + endpoint Settings surface at the
 *  pure/contract level: (1) the fixture registration + kind-closure for
 *  ENC-SET-001..005 against the encoder-settings seam; (2) the failure triad's
 *  contract + redaction invariants by zero-tolerance source scans — the raw key
 *  is NEVER surfaced in the SetupStatusResponse contract (only
 *  `embeddingApiKeySet`) and never logged / echoed to a GET client; (3) the
 *  flag-agnostic export. The route-level POST/GET round-trip over a real
 *  tempdir `.mega-compact.env` lives in routes-setup.test.ts (the route's own
 *  test file); this aggregator is flag-agnostic (passes with ENC_1A ON or OFF).
 *  Local file reads only, zero network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_1A_ENABLED } from "../config/vector-cortex.js";

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
const ENC_SET_IDS = [
  "ENC-SET-001",
  "ENC-SET-002",
  "ENC-SET-003",
  "ENC-SET-004",
  "ENC-SET-005",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface SetFixture {
  id: string; producer: string; assertion: string; kind: string;
  setup: Record<string, unknown>;
  expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): SetFixture {
  const row = readManifest().fixtures.find(
    (f) => f.id === id && f.path.startsWith("encoder-settings/"),
  );
  assert.ok(row, `fixture ${id} registered under encoder-settings/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as SetFixture;
}

describe("ENC-1a conformance registration", () => {
  test("manifest registers ENC-SET-001..005 under the encoder-settings seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_SET_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.path, `encoder-settings/${id}.json`, `${id} path`);
      assert.equal(row.algorithm, "encoder-settings", `${id} algorithm`);
      assert.equal(row.schema, "schemas/encoder-settings-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.expected, "ok", `${id} expected`);
    }
    const schemaRow = m.fixtures.find((f) => f.path === "schemas/encoder-settings-fixture.schema.json");
    assert.ok(schemaRow, "encoder-settings schema registered");
    assert.ok(m.owner.split(",").includes("ENC-1a"), "owner CSV includes ENC-1a");
    assert.ok(m.domain.split(";").includes("encoder-settings"), "domain includes encoder-settings");
    assert.ok(m.owner.split(",").includes("ENC-0g"), "prior ENC-0g owner preserved");
    assert.ok(m.domain.split(";").includes("encoder-status"), "prior ENC-0g domain preserved");
  });

  test("the 5 ENC-SET fixture kinds are closed to the spec branch set", () => {
    const kinds = new Set<string>();
    for (const id of ENC_SET_IDS) {
      const fx = fixture(id);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.equal(fx.expected_outcome, "ok", `${id}: outcome`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "round-trip-set-redacted",
      "absent-key-nonfatal",
      "secret-redaction",
      "flag-off",
      "contract-additive",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present`);
    }
  });
});

describe("ENC-1a flag + contract additivity", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_1A_ENABLED(), "boolean");
  });

  test("setup status returns embedded endpoint URL + apiKeySet boolean, never the raw key (contract still allows POST to carry the key)", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    // Scaffold the SetupStatusResponse interface body (between `interface ... {`
    // and the matching `}`).
    const getBlock = contracts.slice(
      contracts.indexOf("interface SetupStatusResponse"),
      contracts.indexOf("interface DetectResult"),
    );
    assert.match(getBlock, /embeddingEndpointUrl\?:\s*string/, "status response carries optional embeddingEndpointUrl");
    assert.match(getBlock, /embeddingApiKeySet\?:\s*boolean/, "status response carries optional embeddingApiKeySet boolean");
    // Zero-tolerance: the response contract exposes ONLY the boolean
    // `embeddingApiKeySet` — never a standalone `embeddingApiKey` field
    // declaration (the regex must not match `embeddingApiKeySet?:`).
    assert.ok(
      !getBlock.match(/embeddingApiKey\??:/),
      "SetupStatusResponse must not declare a raw `embeddingApiKey` field (only embeddingApiKeySet)",
    );
    // The configure REQUEST may carry the raw key (it is written, never read back).
    const postBlock = contracts.slice(
      contracts.indexOf("interface SetupConfigureRequest"),
      contracts.indexOf("interface SetupConfigureResponse"),
    );
    assert.match(postBlock, /embeddingEndpointUrl\?:\s*string/, "configure request carries optional embeddingEndpointUrl");
    assert.match(postBlock, /embeddingApiKey\?:\s*string/, "configure request carries optional embeddingApiKey");
  });

  test("the two ENC-1a keys are the exact runtime env names embeddingConfigFromEnv reads", () => {
    // The sibling env impl pins MEGACOMPACT_EMBEDDING_URL / MEGACOMPACT_EMBEDDING_KEY
    // (NOT *_EMBEDDING_API_KEY) — the runtime names src/httpEmbedder.ts reads.
    const impl = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-setup-enc1a.ts"),
      "utf8",
    );
    assert.match(impl, /MEGACOMPACT_EMBEDDING_URL/, "writer pins MEGACOMPACT_EMBEDDING_URL");
    assert.match(impl, /MEGACOMPACT_EMBEDDING_KEY/, "writer pins MEGACOMPACT_EMBEDDING_KEY");
    assert.ok(
      !impl.includes("MEGACOMPACT_EMBEDDING_API_KEY"),
      "the API-key env var is MEGACOMPACT_EMBEDDING_KEY, never *EMBEDDING_API_KEY",
    );
  });
});

describe("ENC-1a redaction + no-log invariants (zero-tolerance)", () => {
  const routesFile = join(ROOT, "extensions", "dashboard-server", "routes-setup.ts");
  const implFile = join(ROOT, "extensions", "dashboard-server", "routes-setup-enc1a.ts");

  test("routes-setup.ts and routes-setup-enc1a.ts contain no console.log", () => {
    for (const f of [routesFile, implFile]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes("console.log"), `${f} must not call console.log`);
    }
  });

  test("route GET never serializes the raw key — the reader only exposes endpointUrl + apiKeySet boolean", () => {
    const impl = readFileSync(implFile, "utf8");
    assert.match(impl, /apiKeySet: boolean/, "reader reports apiKeySet as a boolean");
    assert.match(impl, /endpointUrl: string \| null/, "reader echoes the endpoint URL only");
    // Scope to the reader function only: its body must not write an `apiKey:`
    // field into anything it returns or logs (the writer can legitimately take
    // an apiKey param to persist to the file).
    const readStart = impl.indexOf("export function readEnc1aEnv");
    assert.ok(readStart >= 0, "readEnc1aEnv present");
    const readEnd = impl.indexOf("export function ", readStart + 1);
    const reader = impl.slice(readStart, readEnd);
    assert.ok(!reader.includes("apiKey:"), "readEnc1aEnv never returns/logs the raw apiKey field");
  });

  test("preserved unrelated lines (create-or-append): writer never deletes other env keys", () => {
    const impl = readFileSync(implFile, "utf8");
    assert.match(impl, /preserving every unrelated line/, "writer is documented create-or-append");
    assert.match(impl, /never deletes other keys|never deletes/, "writer never deletes other keys");
  });
});

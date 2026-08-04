// Canonical writer: emits every conformance/vector-cortex/v2 file + manifest.
// Writes in canonical JSON form (see CONFORMANCE.md): UTF-8, NFC, keys sorted
// by UTF-8 bytes, shortest number representation, final LF, SHA-256 over the
// declared canonical bytes. LOCAL ONLY: filesystem writes, zero network.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  V2,
  EVAL_DIR,
  SCHEMA_DIR,
  producer,
  canonicalJson,
  sha256Hex,
} from "./common.mjs";
import { schemas } from "./schemas.mjs";
import { fixtures as evalFixtures } from "./evaluation.mjs";
import { fixtures as replayFixtures } from "./replay.mjs";
import { fixtures as eventFixtures } from "./events.mjs";
import { fixtures as resilienceFixtures, named as resilienceNamed } from "./resilience.mjs";
import { fixtures as ledgerFixtures, named as ledgerNamed } from "./ledger.mjs";
import { fixtures as minhashFixtures, named as minhashNamed, seedsJson } from "./minhash.mjs";
import { fixtures as migrationFixtures, named as migrationNamed } from "./migrations.mjs";
import { fixtures as conformanceFixtures, named as conformanceNamed } from "./conformance.mjs";
import { fixtures as encoderFixtures, named as encoderNamed } from "./encoder-runtime.mjs";
import { fixtures as encoderHeadsFixtures, named as encoderHeadsNamed } from "./encoder-heads.mjs";
import { fixtures as encQualFixtures, named as encQualNamed } from "./encoder-qualification.mjs";
import { fixtures as cortexFixtures, named as cortexNamed } from "./cortex-store.mjs";
import { fixtures as topologyFixtures, named as topologyNamed } from "./topology.mjs";
import { fixtures as topologyQueryFixtures, named as topologyQueryNamed } from "./topology-query.mjs";
import { fixtures as shardFixtures, named as shardNamed } from "./shards.mjs";
import { fixtures as residualFixtures, named as residualNamed } from "./residual.mjs";
import { fixtures as reconstructionFixtures, named as reconstructionNamed } from "./reconstruction.mjs";
import { fixtures as promptDagFixtures, named as promptDagNamed } from "./prompt-dag.mjs";
import { fixtures as plannerFixtures, named as plannerNamed } from "./planner.mjs";

const REPLAY_DIR = join(V2, "replay");
const EVENTS_DIR = join(V2, "events");
const RESILIENCE_DIR = join(V2, "resilience");
const LEDGER_DIR = join(V2, "ledger");
const MINHASH_DIR = join(V2, "minhash");
const MIGRATIONS_DIR = join(V2, "migrations");
const CONFORMANCE_DIR = join(V2, "conformance");
const ENCODER_DIR = join(V2, "encoder-runtime");
const ENCODER_HEADS_DIR = join(V2, "encoder-heads");
const ENCODER_QUAL_DIR = join(V2, "encoder-qualification");
const CORTEX_DIR = join(V2, "cortex-store");
const TOPOLOGY_DIR = join(V2, "topology");
const TOPOLOGY_QUERY_DIR = join(V2, "topology-query");
const SHARDS_DIR = join(V2, "shards");
const RESIDUAL_DIR = join(V2, "residual");
const RECONSTRUCTION_DIR = join(V2, "reconstruction");
const PROMPT_DAG_DIR = join(V2, "prompt-dag");
const PLANNER_DIR = join(V2, "planner");

export function writeAll() {
  rmSync(V2, { recursive: true, force: true });
  mkdirSync(EVAL_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });
  mkdirSync(REPLAY_DIR, { recursive: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
  mkdirSync(RESILIENCE_DIR, { recursive: true });
  mkdirSync(LEDGER_DIR, { recursive: true });
  mkdirSync(MINHASH_DIR, { recursive: true });
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  mkdirSync(CONFORMANCE_DIR, { recursive: true });
  mkdirSync(ENCODER_DIR, { recursive: true });
  mkdirSync(ENCODER_HEADS_DIR, { recursive: true });
  mkdirSync(ENCODER_QUAL_DIR, { recursive: true });
  mkdirSync(CORTEX_DIR, { recursive: true });
  mkdirSync(TOPOLOGY_DIR, { recursive: true });
  mkdirSync(TOPOLOGY_QUERY_DIR, { recursive: true });
  mkdirSync(SHARDS_DIR, { recursive: true });
  mkdirSync(RESIDUAL_DIR, { recursive: true });
  mkdirSync(RECONSTRUCTION_DIR, { recursive: true });
  mkdirSync(PROMPT_DAG_DIR, { recursive: true });
  mkdirSync(PLANNER_DIR, { recursive: true });

  const manifestRows = [];

  for (const [rel, obj] of Object.entries(schemas)) {
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    writeFileSync(join(V2, rel), bytes);
    manifestRows.push({
      id: rel.split("/").pop().replace(".schema.json", ""),
      path: rel,
      sha256: sha256Hex(bytes),
      schema: rel,
      algorithm: "json-schema",
      producer,
      expected: "schema",
      license: "synthetic",
    });
  }

  for (const fx of evalFixtures) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `evaluation/${fx.id}.json`;
    writeFileSync(join(EVAL_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "metric" ? "metric-event-v1" : "annotation-v1",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  for (const fx of replayFixtures) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `replay/${fx.id}.json`;
    writeFileSync(join(REPLAY_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "cut" ? "replay-cut-v2" : "effective-cut-v2",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // EventV2 fixtures (VC1A): algorithm "event-v2" for encode rows (codec byte
  // authority) and "event-v2-validate" for validator rows.
  for (const fx of eventFixtures) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `events/${fx.id}.json`;
    writeFileSync(join(EVENTS_DIR, `${fx.id}.json`), bytes);
    // A validate-kind failure row's expected code is the FIRST listed code.
    const failureCode = !fx.expected.ok && Array.isArray(fx.expected.codes)
      ? fx.expected.codes[0]
      : null;
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "encode" ? "event-v2" : "event-v2-validate",
      producer,
      expected: fx.expected.ok ? "ok" : failureCode,
      license: "synthetic",
    });
  }

  // Resilience fixtures (VC0C): kind=breaker -> "tri-breaker", kind=spool ->
  // "tri-spool". expected.code is the code/verdict the implementation returns.
  for (const fx of [...resilienceFixtures, ...resilienceNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `resilience/${fx.id}.json`;
    writeFileSync(join(RESILIENCE_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "breaker" ? "tri-breaker" : "tri-spool",
      producer,
      expected: fx.expected.code,
      license: "synthetic",
    });
  }

  // Ledger fixtures (VC1B): kind=occurrence-v2 for ledger behavior + M2 lifecycle,
  // kind=migrate-down for downgrade export rows. Registering M2-001..015 and
  // MIG-DOWN-001 (plus the named M2-DUP-001/M2-TOOL-002/MIG-DOWN-003) as on-disk
  // fixtures so every VC1B conformance ID resolves.
  for (const fx of [...ledgerFixtures, ...ledgerNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `ledger/${fx.id}.json`;
    writeFileSync(join(LEDGER_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "migrate-down" ? "migrate-down" : "occurrence-v2",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // M4 MinHashV2 fixtures (VC1C) + the frozen seed table `seeds-v2.json`.
  const seedsBytes = Buffer.from(canonicalJson(seedsJson()), "utf8");
  writeFileSync(join(MINHASH_DIR, "seeds-v2.json"), seedsBytes);
  manifestRows.push({
    id: "seeds-v2",
    path: "minhash/seeds-v2.json",
    sha256: sha256Hex(seedsBytes),
    schema: "schemas/minhash-seeds.schema.json",
    algorithm: "minhash-seeds",
    producer,
    expected: "schema",
    license: "synthetic",
  });
  for (const fx of [...minhashFixtures, ...minhashNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `minhash/${fx.id}.json`;
    writeFileSync(join(MINHASH_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "minhash-v2",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
      // Success cases pin the canonical output digest so the v2 runner (task 5)
      // cross-checks the handler's success bytes against the manifest entry.
      ...(fx.expected.ok && fx.expected.signatureDigest
        ? { outputDigest: fx.expected.signatureDigest }
        : {}),
    });
  }

  // M4 minhash-v2 migration lifecycle fixtures (VC1C).
  for (const fx of [...migrationFixtures, ...migrationNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `migrations/${fx.id}.json`;
    writeFileSync(join(MIGRATIONS_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "minhash-v2-migration",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Conformance-manifest / downgrade behavior fixtures (VC1C).
  for (const fx of [...conformanceFixtures, ...conformanceNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `conformance/${fx.id}.json`;
    writeFileSync(join(CONFORMANCE_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "conformance-v2",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Encoder-runtime fixtures (VC2A): kind=encoder-runtime. expected.ok pins a
  // qualified mode-A load; expected.code pins the exact demotion failure code.
  for (const fx of [...encoderFixtures, ...encoderNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `encoder-runtime/${fx.id}.json`;
    writeFileSync(join(ENCODER_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "encoder-runtime",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
      ...(fx.expected.mode ? { mode: fx.expected.mode } : {}),
    });
  }

  // Encoder-heads fixtures (VC2B): kind=encoder-heads. expected.ok pins a head
  // emission with shape facts (heads/dims/width/zero); a false row pins the
  // exact failure code.
  for (const fx of [...encoderHeadsFixtures, ...encoderHeadsNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `encoder-heads/${fx.id}.json`;
    writeFileSync(join(ENCODER_HEADS_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "encoder-heads",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
      ...(fx.expected.mode ? { mode: fx.expected.mode } : {}),
    });
  }

  // Encoder-qualification fixtures (VC2C): kind=encoder-qualification. expected.ok
  // pins a mode-A qualification; expected.code pins the exact demotion code/mode.
  for (const fx of [...encQualFixtures, ...encQualNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `encoder-qualification/${fx.id}.json`;
    writeFileSync(join(ENCODER_QUAL_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "encoder-qualification",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
      ...(fx.expected.mode ? { mode: fx.expected.mode } : {}),
    });
  }

  // Cortex-store fixtures (VC3A): kind=cortex-store. expected.ok pins the
  // successful capability/keying/rebuild behavior; expected.code pins the exact
  // failure code (CTX_KEY_CONFLICT / CTX_APPEND_FAILED / CTX_PAYLOAD_DIGEST_MISMATCH).
  for (const fx of [...cortexFixtures, ...cortexNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `cortex-store/${fx.id}.json`;
    writeFileSync(join(CORTEX_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "cortex-store",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Topology fixtures (VC3B): kind=topology. expected.ok pins the deterministic
  // graph build; expected.code pins the exact rejection code (TOP_SCORE_NONFINITE).
  for (const fx of [...topologyFixtures, ...topologyNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `topology/${fx.id}.json`;
    writeFileSync(join(TOPOLOGY_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "topology",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Topology-query fixtures (VC3C): kind=topology-query rows (TOP-021..030 +
  // named) pin the query/key/invalidation behavior with algorithm
  // "topology-query"; kind=router-generation-v2 rows (M6-001..012) pin the M6
  // copy/validate/switch migration with algorithm "router-generation-v2". Both
  // live under `topology-query/` — the VC3C sprint fixture root.
  for (const fx of [...topologyQueryFixtures, ...topologyQueryNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `topology-query/${fx.id}.json`;
    writeFileSync(join(TOPOLOGY_QUERY_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "router-generation-v2" ? "router-generation-v2" : "topology-query",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Shard fixtures (VC4A): kind=shard rows (SHD-001..020 + named) pin the
  // semantic/exact partition and manifest-coverage behavior with algorithm
  // "shard".
  for (const fx of [...shardFixtures, ...shardNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `shards/${fx.id}.json`;
    writeFileSync(join(SHARDS_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "shard",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Residual fixtures (VC4B): kind=residual rows (RES-001..050 + named) pin the
  // DCT / quantization / parity / admission behavior with algorithm "residual".
  for (const fx of [...residualFixtures, ...residualNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `residual/${fx.id}.json`;
    writeFileSync(join(RESIDUAL_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "residual",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Reconstruction fixtures (VC4C): kind=reconstruction rows (CLO-001..030 +
  // REC-001..030 + named) pin closure / assembly / validation behavior with
  // algorithm "reconstruction".
  for (const fx of [...reconstructionFixtures, ...reconstructionNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `reconstruction/${fx.id}.json`;
    writeFileSync(join(RECONSTRUCTION_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "reconstruction",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Prompt-dag fixtures (VC5A): kind=prompt-dag rows (DAG-001..030 + named)
  // pin builder/validator behavior (build acceptance/rejection, stable Kahn
  // ordering, cycle / reversed-precedes / contradicts-not-ordering) with
  // algorithm "prompt-dag".
  for (const fx of [...promptDagFixtures, ...promptDagNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `prompt-dag/${fx.id}.json`;
    writeFileSync(join(PROMPT_DAG_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "prompt-dag",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Planner fixtures (VC5A): kind=planner rows (PLN-001..020 + named) pin
  // mandatory-closure / 0/1 selection / manifest-identity behavior with
  // algorithm "planner".
  for (const fx of [...plannerFixtures, ...plannerNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `planner/${fx.id}.json`;
    writeFileSync(join(PLANNER_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "planner",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  const manifest = {
    version: "2",
    viewer: "vector-cortex-conformance.mjs",
    producer: "vector-cortex-gen-fixtures.mjs",
    domain: "evaluation,replay,events,resilience,ledger,minhash,migrations,conformance,encoder-runtime,encoder-heads,encoder-qualification,cortex-store,topology,topology-query,router-generation-v2,shard,residual,reconstruction,prompt-dag,planner",
    owner: "VC0A,VC0B,VC0C,VC1A,VC1B,VC1C,VC2A,VC2B,VC2C,VC3A,VC3B,VC3C,VC4A,VC4B,VC4C,VC5A",
    schemaVersion: "metric-event-v1;replay-cut-v2;event-v2;tri-fixture;ledger-fixture;minhash-v2;minhash-v2-migration;conformance-v2;minhash-seeds;encoder-runtime;encoder-heads;encoder-qualification;cortex-store;topology-fixture;topology-query-fixture;router-generation-migration;shard-fixture;residual-fixture;reconstruction-fixture;prompt-dag-fixture;planner-fixture",
    license: "synthetic",
    fixtures: manifestRows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  writeFileSync(join(V2, "manifest.json"), Buffer.from(canonicalJson(manifest), "utf8"));

  return {
    evalCount: evalFixtures.length,
    replayCount: replayFixtures.length,
    eventCount: eventFixtures.length,
    resilienceCount: resilienceFixtures.length,
    ledgerCount: ledgerFixtures.length,
    ledgerNamedCount: ledgerNamed.length,
    namedCount: resilienceNamed.length,
    schemaCount: Object.keys(schemas).length,
    minhashCount: minhashFixtures.length,
    migrationCount: migrationFixtures.length,
    conformanceCount: conformanceFixtures.length,
    encoderCount: encoderFixtures.length,
    encoderNamedCount: encoderNamed.length,
    encoderHeadsCount: encoderHeadsFixtures.length,
    encoderHeadsNamedCount: encoderHeadsNamed.length,
    encoderQualCount: encQualFixtures.length,
    encoderQualNamedCount: encQualNamed.length,
    cortexCount: cortexFixtures.length,
    cortexNamedCount: cortexNamed.length,
    topologyCount: topologyFixtures.length,
    topologyNamedCount: topologyNamed.length,
    shardCount: shardFixtures.length,
    shardNamedCount: shardNamed.length,
    residualCount: residualFixtures.length,
    residualNamedCount: residualNamed.length,
    reconstructionCount: reconstructionFixtures.length,
    reconstructionNamedCount: reconstructionNamed.length,
    promptDagCount: promptDagFixtures.length,
    promptDagNamedCount: promptDagNamed.length,
    plannerCount: plannerFixtures.length,
    plannerNamedCount: plannerNamed.length,
  };
}

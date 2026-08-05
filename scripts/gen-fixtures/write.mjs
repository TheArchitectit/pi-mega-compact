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
import { fixtures as renderFixtures, named as renderNamed } from "./render.mjs";
import { fixtures as providerFixtures, named as providerNamed } from "./provider.mjs";
import { fixtures as rolloutFixtures, named as rolloutNamed } from "./rollout.mjs";
import { fixtures as healFixtures, named as healNamed } from "./closure-optimization.mjs";
import { fixtures as restorationFixtures, named as restorationNamed } from "./restoration.mjs";
import { fixtures as healingFixtures, named as healingNamed } from "./healing-controller.mjs";
import { fixtures as crystalFixtures, named as crystalNamed } from "./cache-crystals.mjs";
import { fixtures as economicsFixtures, named as economicsNamed } from "./cache-economics.mjs";
import { fixtures as diagnosticsFixtures, m5Fixtures as diagnosticsM5Fixtures, named as diagnosticsNamed } from "./cache-diagnostics.mjs";
import { fixtures as outcomesFixtures, named as outcomesNamed } from "./outcomes.mjs";
import { fixtures as adaptiveFixtures, m7Fixtures as adaptiveM7Fixtures, named as adaptiveNamed } from "./adaptive-policy.mjs";
import { fixtures as crossLangFixtures, named as crossLangNamed } from "./cross-language.mjs";

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
const RENDER_DIR = join(V2, "render");
const PROVIDER_DIR = join(V2, "provider");
const ROLLOUT_DIR = join(V2, "rollout");
const HEAL_DIR = join(V2, "closure-optimization");
const RESTORATION_DIR = join(V2, "restoration");
const HEALING_DIR = join(V2, "healing-controller");
const CRYSTALS_DIR = join(V2, "cache-crystals");
const ECONOMICS_DIR = join(V2, "cache-economics");
const DIAGNOSTICS_DIR = join(V2, "cache-diagnostics");
const OUTCOMES_DIR = join(V2, "outcomes");
const ADAPTIVE_DIR = join(V2, "adaptive-policy");
const CROSS_LANG_DIR = join(V2, "cross-language");

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
  mkdirSync(RENDER_DIR, { recursive: true });
  mkdirSync(PROVIDER_DIR, { recursive: true });
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  mkdirSync(HEAL_DIR, { recursive: true });
  mkdirSync(RESTORATION_DIR, { recursive: true });
  mkdirSync(HEALING_DIR, { recursive: true });
  mkdirSync(CRYSTALS_DIR, { recursive: true });
  mkdirSync(ECONOMICS_DIR, { recursive: true });
  mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
  mkdirSync(OUTCOMES_DIR, { recursive: true });
  mkdirSync(ADAPTIVE_DIR, { recursive: true });
  mkdirSync(ADAPTIVE_DIR, { recursive: true });
  mkdirSync(CROSS_LANG_DIR, { recursive: true });

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

  // Render fixtures (VC5B): kind=render rows (REN-001..020 + named) pin
  // render-in-order / exact-tool-bytes / canonical-request-hash / profile-gated
  // validation / clean-bypass behavior with algorithm "render".
  for (const fx of [...renderFixtures, ...renderNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `render/${fx.id}.json`;
    writeFileSync(join(RENDER_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "render",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Provider fixtures (VC5B): kind=provider rows (PRO-001..015 + named) pin
  // known-resolution / unknown-clean-bypass / version-gating / fixture-proven
  // exclusion / cache-identity behavior with algorithm "provider".
  for (const fx of [...providerFixtures, ...providerNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `provider/${fx.id}.json`;
    writeFileSync(join(PROVIDER_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "provider",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Rollout fixtures (VC5C): kind=rollout rows (ROL-001..020 + named) pin
  // stable-bucket assignment / monotonic gate-advance / hard-fault-freeze
  // behavior with algorithm "rollout".
  for (const fx of [...rolloutFixtures, ...rolloutNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `rollout/${fx.id}.json`;
    writeFileSync(join(ROLLOUT_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "rollout",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Closure-optimization fixtures (VC6A): kind=closure-optimization rows
  // (HEAL-001..015 + named) pin the deterministic transitive-reduction optimizer
  // and the conservative-oracle proof verifier with algorithm "closure-optimization".
  for (const fx of [...healFixtures, ...healNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `closure-optimization/${fx.id}.json`;
    writeFileSync(join(HEAL_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "closure-optimization",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Restoration fixtures (VC6B): kind=restoration rows (HEAL-016..030 + named)
  // pin exact source restoration — indexed exact-shard reads, ledger range
  // scans, digest rejection, and the request bounds — with algorithm
  // "restoration".
  for (const fx of [...restorationFixtures, ...restorationNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `restoration/${fx.id}.json`;
    writeFileSync(join(RESTORATION_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "restoration",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Healing-controller fixtures (VC6C): kind=healing-controller rows
  // (HEAL-031..045 + named) pin derived-gap detection against the durable
  // authority high-water, the authority-freeze refusal, the one-per-5-minute
  // rate limit, deterministic exponential backoff, and copy/verify/switch
  // pointer semantics, with algorithm "healing-controller".
  for (const fx of [...healingFixtures, ...healingNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `healing-controller/${fx.id}.json`;
    writeFileSync(join(HEALING_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "healing-controller",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Cache-crystal fixtures (VC7A): kind=cache-crystal rows (CRY-001..015 +
  // PRO-016..023 + named) pin canonical key encoding from covered ranges only,
  // source-start range sorting, overlap rejection, the exclusion of the global
  // frontier from identity, and content-addressed write-once store semantics,
  // with algorithm "cache-crystal".
  for (const fx of [...crystalFixtures, ...crystalNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `cache-crystals/${fx.id}.json`;
    writeFileSync(join(CRYSTALS_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "cache-crystal",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // Cache-economics fixtures (VC7B): kind=cache-economics rows (CACHE-001..015 +
  // PRO-024..030 + named) pin exact integer net-savings arithmetic, the
  // exclusion-requires-a-proving-fixture rule, provider-safe crystal boundary
  // compilation that never changes request identity, and stable session-bucket
  // experiment assignment with causal admissibility, with algorithm
  // "cache-economics".
  for (const fx of [...economicsFixtures, ...economicsNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `cache-economics/${fx.id}.json`;
    writeFileSync(join(ECONOMICS_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: "cache-economics",
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  for (const fx of [...diagnosticsFixtures, ...diagnosticsM5Fixtures, ...diagnosticsNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `cache-diagnostics/${fx.id}.json`;
    writeFileSync(join(DIAGNOSTICS_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind === "request-hash-v2" ? "request-hash-v2" : "cache-diagnostic",
      producer,
      expected: fx.expected.ok ? "ok" : (fx.expected.code ?? (Array.isArray(fx.expected.codes) ? fx.expected.codes[0] : undefined)),
      license: "synthetic",
    });
  }

  // Outcomes fixtures (VC8A): kind=outcome rows (OUT-001..025) pin payload-free
  // outcome append validation; kind=consent named rows pin grant/revoke effective
  // sequence; kind=dataset named rows pin split integrity + digest reproducibility.
  for (const fx of [...outcomesFixtures, ...outcomesNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `outcomes/${fx.id}.json`;
    writeFileSync(join(OUTCOMES_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind,
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // VC8B adaptive-policy fixtures: kind=policy-decision rows (POL-001..025)
  // pin the bounded action/constraint evaluation; kind=policy-shadow named
  // rows pin prompt-invariance; kind=pressure-v2 rows (M7-001..015) pin the
  // pressure-v2 copy/switch migration outcomes.
  for (const fx of [...adaptiveFixtures, ...adaptiveM7Fixtures, ...adaptiveNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `adaptive-policy/${fx.id}.json`;
    writeFileSync(join(ADAPTIVE_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind,
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  // VC8C cross-language fixtures: RUST-001..030 golden exchanges + 3 named
  // (ABI/ERR/META). Pin the engine parity/selection admission gates.
  for (const fx of [...crossLangFixtures, ...crossLangNamed]) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `cross-language/${fx.id}.json`;
    writeFileSync(join(CROSS_LANG_DIR, `${fx.id}.json`), bytes);
    manifestRows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: fx.schema,
      algorithm: fx.kind,
      producer,
      expected: fx.expected.ok ? "ok" : fx.expected.code,
      license: "synthetic",
    });
  }

  const manifest = {
    version: "2",
    viewer: "vector-cortex-conformance.mjs",
    producer: "vector-cortex-gen-fixtures.mjs",
    domain: "evaluation,replay,events,resilience,ledger,minhash,migrations,conformance,encoder-runtime,encoder-heads,encoder-qualification,cortex-store,topology,topology-query,router-generation-v2,shard,residual,reconstruction,prompt-dag,planner,render,provider,rollout,closure-optimization,restoration,healing-controller,cache-crystals,cache-economics,cache-diagnostics,outcomes,adaptive-policy,cross-language",
    owner: "VC0A,VC0B,VC0C,VC1A,VC1B,VC1C,VC2A,VC2B,VC2C,VC3A,VC3B,VC3C,VC4A,VC4B,VC4C,VC5A,VC5B,VC5C,VC6A,VC6B,VC6C,VC7A,VC7B,VC7C,VC8A,VC8B,VC8C",
    schemaVersion: "metric-event-v1;replay-cut-v2;event-v2;tri-fixture;ledger-fixture;minhash-v2;minhash-v2-migration;conformance-v2;minhash-seeds;encoder-runtime;encoder-heads;encoder-qualification;cortex-store;topology-fixture;topology-query-fixture;router-generation-migration;shard-fixture;residual-fixture;reconstruction-fixture;prompt-dag-fixture;planner-fixture;render-fixture;provider-fixture;rollout-fixture;closure-optimization-fixture;restoration-fixture;healing-controller-fixture;cache-crystal-fixture;cache-economics-fixture;cache-diagnostic-fixture;request-hash-v2-fixture;policy-decision-fixture;policy-shadow-fixture;pressure-v2-fixture;cross-language-fixture",
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
    renderCount: renderFixtures.length,
    renderNamedCount: renderNamed.length,
    providerCount: providerFixtures.length,
    providerNamedCount: providerNamed.length,
    rolloutCount: rolloutFixtures.length,
    rolloutNamedCount: rolloutNamed.length,
    healCount: healFixtures.length,
    healNamedCount: healNamed.length,
    restorationCount: restorationFixtures.length,
    restorationNamedCount: restorationNamed.length,
    healingCount: healingFixtures.length,
    healingNamedCount: healingNamed.length,
    crystalCount: crystalFixtures.length,
    crystalNamedCount: crystalNamed.length,
    economicsCount: economicsFixtures.length,
    economicsNamedCount: economicsNamed.length,
    diagnosticsCount: diagnosticsFixtures.length + diagnosticsM5Fixtures.length,
    diagnosticsNamedCount: diagnosticsNamed.length,
    outcomesCount: outcomesFixtures.length,
    outcomesNamedCount: outcomesNamed.length,
    adaptivePolicyCount: adaptiveFixtures.length,
    adaptiveMigrationCount: adaptiveM7Fixtures.length,
    adaptiveNamedCount: adaptiveNamed.length,
    crossLangCount: crossLangFixtures.length,
    crossLangNamedCount: crossLangNamed.length,
  };
}

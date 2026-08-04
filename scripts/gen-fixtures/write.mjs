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

const REPLAY_DIR = join(V2, "replay");
const EVENTS_DIR = join(V2, "events");
const RESILIENCE_DIR = join(V2, "resilience");
const LEDGER_DIR = join(V2, "ledger");
const MINHASH_DIR = join(V2, "minhash");
const MIGRATIONS_DIR = join(V2, "migrations");
const CONFORMANCE_DIR = join(V2, "conformance");

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

  const manifest = {
    version: "2",
    viewer: "vector-cortex-conformance.mjs",
    producer: "vector-cortex-gen-fixtures.mjs",
    domain: "evaluation,replay,events,resilience,ledger,minhash,migrations,conformance",
    owner: "VC0A,VC0B,VC1A,VC0C,VC1B,VC1C",
    schemaVersion: "metric-event-v1;replay-cut-v2;event-v2;tri-fixture;ledger-fixture;minhash-v2;minhash-v2-migration;conformance-v2;minhash-seeds",
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
  };
}

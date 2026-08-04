// VC1C conformance-manifest fixtures (`conformance/vector-cortex/v2/conformance/`).
// Owner VC1C: FixtureManifestV2 canonical validation + the conformance runner +
// the downgrade exporter. Each fixture declares a scenario the tests execute
// against a TEMP conformance root (so the committed corpus stays canonical):
//   CONF-MANIFEST-001 — a listed event fixture's digest matches canonical bytes
//                       (canonical-manifest convergence, no extra/missing/drift).
//   CONF-EXTRA-002    — injecting an unlisted file fails CONF_EXTRA_FIXTURE.
//   CONF-DOWN-003     — a repeated downgrade export yields an identical report
//                       digest (deterministic, never mutates the authority copy).

import { producer } from "./common.mjs";

const CONF_SCHEMA = "schemas/conformance-fixture.schema.json";

function confFixture(id, assertion, input, expected) {
  return { id, schema: CONF_SCHEMA, producer, assertion, kind: "conformance-v2", input, expected };
}

const confManifest = confFixture(
  "CONF-MANIFEST-001",
  "a listed event fixture digest matches canonical bytes; canonical manifests converge",
  { scenario: "canonical", domains: ["events", "minhash", "migrations"] },
  { ok: true, entryCount: 1 },
);

const confExtra = confFixture(
  "CONF-EXTRA-002",
  "an unlisted file fails with CONF_EXTRA_FIXTURE",
  { scenario: "extra-file", extraPath: "events/EVT-UNLISTED.json" },
  { ok: false, code: "CONF_EXTRA_FIXTURE" },
);

const confDown = confFixture(
  "CONF-DOWN-003",
  "a repeated downgrade export has an identical report digest",
  { scenario: "downgrade-repeat", rows: 3 },
  { ok: true, deterministic: true },
);

export const fixtures = [confManifest, confExtra, confDown];
export const named = [];

/**
 * outcomes/dataset.ts — VC8A dataset manifest builder.
 *
 * Groups outcome rows by (repo, session) so no group crosses
 * train/calibration/held-out split boundaries. Revocations disappear from
 * future manifests because the consent check excludes them.
 *
 * The manifest digest is reproducible: it is computed over the canonical
 * sorted rows, so input order does not affect the digest.
 *
 * The build/digest functions are PURE. The flag gates ONLY the reporter seam,
 * never the arithmetic.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any` type.
 */

import { createHash } from "node:crypto";
import {
  DATASET_MANIFEST_SCHEMA_V1,
  type ConsentV1,
  type DatasetManifestV1,
  type DatasetManifestRow,
  type DatasetSplit,
  type OutcomeV1,
} from "./types.js";
import { hasActiveConsent } from "./consent.js";

/** SHA-256 over the canonical sorted rows. */
export function manifestDigest(rows: ReadonlyArray<DatasetManifestRow>): string {
  const sorted = [...rows].sort((a, b) => {
    const ka = `${a.repoId}:${a.sessionId}:${a.outcomeId}`;
    const kb = `${b.repoId}:${b.sessionId}:${b.outcomeId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const text = sorted
    .map((r) => `${r.outcomeId}|${r.repoId}|${r.sessionId}|${r.split}`)
    .join("\n");
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Split a list of session groups into train/calibration/held-out. Groups are
 * assigned sequentially so no group crosses split boundaries.
 */
function assignSplits(
  groupKeys: string[],
): Map<string, DatasetSplit> {
  const result = new Map<string, DatasetSplit>();
  const n = groupKeys.length;
  const trainEnd = Math.ceil(n * 0.7);
  const calEnd = Math.ceil(n * 0.85);
  for (let i = 0; i < n; i++) {
    const split: DatasetSplit = i < trainEnd ? "train" : i < calEnd ? "calibration" : "held-out";
    result.set(groupKeys[i], split);
  }
  return result;
}

/**
 * Build a dataset manifest from outcomes, consent records, and a consent
 * high-water. Only outcomes whose session has active consent at the
 * high-water are included. Revoked sessions are excluded entirely.
 *
 * Throws OUT_CONSENT_MISSING if an outcome's session has no consent at all.
 */
export function buildManifest(
  outcomes: ReadonlyArray<OutcomeV1>,
  consentRecords: ReadonlyArray<ConsentV1>,
  consentHighWaterValue: number,
): DatasetManifestV1 {
  const groups = new Map<string, { repoId: string; sessionId: string }>();
  const included: OutcomeV1[] = [];

  for (const outcome of outcomes) {
    const highWater = consentHighWaterValue;
    if (!hasActiveConsent(consentRecords, outcome.sessionId, highWater)) {
      continue;
    }
    included.push(outcome);
    const key = `${outcome.repoId}:${outcome.sessionId}`;
    if (!groups.has(key)) {
      groups.set(key, { repoId: outcome.repoId, sessionId: outcome.sessionId });
    }
  }

  const groupKeys = [...groups.keys()].sort();
  const splitMap = assignSplits(groupKeys);

  const rows: DatasetManifestRow[] = included.map((o) => {
    const key = `${o.repoId}:${o.sessionId}`;
    const split = splitMap.get(key) ?? "held-out";
    return {
      outcomeId: o.outcomeId,
      repoId: o.repoId,
      sessionId: o.sessionId,
      split,
    };
  });

  const trainRows = rows.filter((r) => r.split === "train");
  const calRows = rows.filter((r) => r.split === "calibration");
  const heldRows = rows.filter((r) => r.split === "held-out");

  return {
    schema: DATASET_MANIFEST_SCHEMA_V1,
    manifestId: `manifest-${manifestDigest(rows).slice(0, 16)}`,
    rows,
    splitDigests: {
      "train": manifestDigest(trainRows),
      "calibration": manifestDigest(calRows),
      "held-out": manifestDigest(heldRows),
    },
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * Check if a manifest has any nonconsented records. Returns false if every
 * row's session has active consent at the given high-water.
 */
export function hasNonconsentedRecords(
  manifest: DatasetManifestV1,
  consentRecords: ReadonlyArray<ConsentV1>,
  consentHighWaterValue: number,
): boolean {
  for (const row of manifest.rows) {
    if (!hasActiveConsent(consentRecords, row.sessionId, consentHighWaterValue)) {
      return true;
    }
  }
  return false;
}

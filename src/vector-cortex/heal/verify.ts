/**
 * vector-cortex/heal/verify.ts — VC6B pre-insertion verification (task 3).
 *
 * `restoreSources` already hashes every span before it puts it in the result, so
 * why hash again here?
 *
 * Because the result is a VALUE that travels. Between restoration and insertion
 * it is passed across module boundaries, possibly cached, possibly assembled from
 * more than one restore call, possibly reordered. `verifyRestored` is the gate
 * immediately before bytes enter the reconstruction, and it re-derives its facts
 * from scratch: it hashes the bytes the result ACTUALLY CARRIES and cross-checks
 * them against the digest THE REQUEST asked for. A result object mutated after
 * `restoreSources` returned — the classic "verified then swapped" injection —
 * fails here.
 *
 * TWO DISTINCT INVARIANTS, TWO DISTINCT CODES.
 *   - `HEAL_RESTORE_DIGEST_MISMATCH` — the bytes do not hash to their OWN stated
 *     digest. The span is internally inconsistent (tampering or truncation).
 *   - `HEAL_RESTORE_RANGE_MISMATCH` — the bytes are internally consistent but do
 *     not answer the question that was asked: the nodeId was never requested, or
 *     the digest disagrees with the digest the request pinned for that nodeId.
 *     This is the "right bytes, wrong span" failure — substituting one real,
 *     correctly-hashed span for another would otherwise pass a naive check.
 *
 * WHOLESALE, NOT PER-SPAN. `insertable` returns the restored spans only when the
 * entire result verifies. Inserting the good half of a result whose other half
 * failed verification would splice a partially-corrupt transcript into the
 * reconstruction without the caller ever seeing a mode-C disclosure.
 *
 * Pure: `node:crypto` only, no storage/console/network (PREVENT-PI-004 /
 * PREVENT-011).
 */

import type {
  RestoreFailureCode,
  RestoreRequestV1,
  RestoreResultV1,
  RestoreSpanResult,
  RestoreVerification,
} from "./restore-types.js";
import { sha256Hex } from "./restore-readers.js";
import { orderCodes } from "./restore.js";

/**
 * Re-verify every restored span against the request that asked for it.
 *
 * Returns `{ok:true}` only when EVERY restored span hashes to its own digest AND
 * that digest is the one the request pinned for that node.
 */
export function verifyRestored(
  result: RestoreResultV1,
  request: RestoreRequestV1,
): RestoreVerification {
  const requestedDigests = new Map<string, string>();
  for (const span of request.spans) requestedDigests.set(span.nodeId, span.digest);

  const codes: RestoreFailureCode[] = [];

  for (const span of result.restored) {
    // (1) Internal consistency: do these bytes hash to the digest they claim?
    if (sha256Hex(span.bytes) !== span.digest) {
      codes.push("HEAL_RESTORE_DIGEST_MISMATCH");
      // A span that fails its own digest cannot meaningfully be checked against
      // the request's digest as well; one code per real defect keeps the verdict
      // readable.
      continue;
    }

    // (2) Provenance: was this node requested, and with THIS digest? An
    // unrequested node or a digest swap is a range mismatch, not a hash failure.
    const wanted = requestedDigests.get(span.nodeId);
    if (wanted === undefined || wanted !== span.digest) {
      codes.push("HEAL_RESTORE_RANGE_MISMATCH");
    }
  }

  if (codes.length === 0) return { ok: true };
  return { ok: false, codes: orderCodes(codes) };
}

/**
 * The spans that may be inserted: all of them, or none.
 *
 * A caller should never need to decide which half of a partially-verified result
 * is safe — that decision is the whole point of the digest contract, so it is
 * made here, once, in the strict direction.
 */
export function insertable(
  result: RestoreResultV1,
  request: RestoreRequestV1,
): readonly RestoreSpanResult[] {
  return verifyRestored(result, request).ok ? result.restored : [];
}

/**
 * epoch.ts — deterministic epoch-id derivation for the S27 DB-mirror.
 *
 * The epoch id MUST be a pure function of the checkpoint it decorates so that
 * replaying / refreshing the same compaction yields the SAME epoch id (idempotent
 * appends + ON CONFLICT refresh). No Date.now / uuid / crypto — this is the
 * only source of randomness-free epoch naming in the mirror stack.
 *
 * - epochIdFor(cp)  → "epoch:" + cp   (human-traceable back to its checkpoint)
 * - epochNonceFor(cp) → FNV-1a 32-bit hash (cheap, well-distributed nonce)
 *
 * Pi-agnostic: no pi runtime imports (src/ invariant).
 */

/**
 * FNV-1a 32-bit nonce for a checkpoint id. Deterministic and RNG-free:
 * h = 0x811c9dc5; for each char: h ^= codePoint; h = Math.imul(h, 0x01000193);
 * return h >>> 0 (unsigned).
 */
export function epochNonceFor(checkpointId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < checkpointId.length; i++) {
    const cp = checkpointId.codePointAt(i);
    if (cp === undefined) continue;
    h ^= cp;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic epoch id: "epoch:" + checkpointId. Trivially traceable back to
 * the source checkpoint, and stable under replay (refresh-safe upserts).
 */
export function epochIdFor(checkpointId: string): string {
  return "epoch:" + checkpointId;
}

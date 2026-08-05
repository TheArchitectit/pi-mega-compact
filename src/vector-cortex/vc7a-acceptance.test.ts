/**
 * vc7a-acceptance.test.ts — VC7A acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./cache/ to stay
 * under the 300-line soft limit (soft-as-hard gate). This file registers the
 * sprint's compiled entry point — `node --test` discovers it alongside its
 * siblings.
 *
 * Sibling files:
 *   - cache/crystal.test.ts     — canonical key encoding, source-start range
 *                                 sorting, overlap rejection, invalidation,
 *                                 CRY-001..015 + PRO-016..023 + named rows
 *   - cache/store.test.ts       — content-addressed write-once, collision,
 *                                 interrupted-write recovery, forced triad A/B/C
 *   - cache/flag-parity.test.ts — MEGACOMPACT_VC7A=0 byte-identity + event
 *                                 suppression
 *
 * The doc-mandated run commands are:
 *   node --test dist/vector-cortex/vc7a-acceptance.test.js
 *   MEGACOMPACT_VC7A=0 node --test dist/vector-cortex/vc7a-acceptance.test.js
 * (the publish-acceptance script mirrors the cache subtree to dist/vector-cortex/
 * so the ./cache/* relative imports resolve).
 */

export {};

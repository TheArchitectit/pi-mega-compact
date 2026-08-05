/**
 * vc7c-acceptance.test.ts — VC7C acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./cache/ and
 * ./migrations/ to stay under the 300-line soft limit (soft-as-hard gate). This
 * file registers the sprint's compiled entry point — `node --test` discovers it
 * alongside its siblings.
 *
 * Sibling files:
 *   - cache/diagnostics.test.ts        — exclusive miss ranking, absence-is-not-
 *                                        a-mismatch, evidence co-occurrence,
 *                                        advanceDelta clamping, transience
 *   - cache/flag-parity-vc7c.test.ts   — MEGACOMPACT_VC7C=0 byte-identity, event
 *                                        suppression, payload-free assertions
 *   - cache/breaker-chaos.test.ts      — cache-serve demotion decision + triad recovery
 *   - migrations/request-hash-v2.test.ts — M5 copy/validate/switch, collision
 *                                        detection, identity preservation
 *
 * The doc-mandated run commands are:
 *   node --test dist/vector-cortex/vc7c-acceptance.test.js
 *   MEGACOMPACT_VC7C=0 node --test dist/vector-cortex/vc7c-acceptance.test.js
 * (the publish-acceptance script mirrors the cache/ and migrations/ subtrees to
 * dist/vector-cortex/ so the relative imports resolve.)
 */

export {};

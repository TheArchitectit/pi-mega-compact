/**
 * vc8c-acceptance.test.ts — VC8C acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./platform/ to
 * stay under the 300-line soft limit (soft-as-hard gate). This file registers
 * the sprint's compiled entry point — `node --test` discovers it alongside
 * its siblings.
 *
 * Sibling files:
 *   - platform/select.test.ts          — six admission checks, failure triad
 *                                        demotion (A/B/C), determinism
 *   - platform/cross-read.test.ts       — neutral framing encode/decode,
 *                                        truncation, byte comparison
 *   - platform/flag-parity-vc8c.test.ts — MEGACOMPACT_VC8C=0 byte-identity,
 *                                        event suppression
 *
 * The doc-mandated run commands are:
 *   node --test dist/vector-cortex/vc8c-acceptance.test.js
 *   MEGACOMPACT_VC8C=0 node --test dist/vector-cortex/vc8c-acceptance.test.js
 * (the publish-acceptance script mirrors the platform/ subtree to
 * dist/vector-cortex/ so the relative imports resolve.)
 */

export {};

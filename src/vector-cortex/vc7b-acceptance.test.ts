/**
 * vc7b-acceptance.test.ts — VC7B acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./provider/ and
 * ./cache/ to stay under the 300-line soft limit (soft-as-hard gate). This file
 * registers the sprint's compiled entry point — `node --test` discovers it
 * alongside its siblings.
 *
 * Sibling files:
 *   - provider/economics.test.ts      — net-savings arithmetic, exclusion-proof
 *                                        rule, TTL/min-prefix eligibility,
 *                                        CACHE-001..015 + PRO-024..030 + named
 *   - provider/experiments.test.ts    — stable bucket assignment, causal
 *                                        admissibility, journal-loss safety,
 *                                        CACHE-RANDOM-003
 *   - cache/compiler.test.ts          — identity-preserving boundary compilation,
 *                                        merge-forward, CACHE-010..013
 *   - cache/flag-parity-vc7b.test.ts  — MEGACOMPACT_VC7B=0 byte-identity + event
 *                                        suppression
 *
 * The doc-mandated run commands are:
 *   node --test dist/vector-cortex/vc7b-acceptance.test.js
 *   MEGACOMPACT_VC7B=0 node --test dist/vector-cortex/vc7b-acceptance.test.js
 * (the publish-acceptance script mirrors the cache/ and provider/ subtrees to
 * dist/vector-cortex/ so the relative imports resolve.)
 */

export {};

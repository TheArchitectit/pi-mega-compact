/**
 * vc8b-acceptance.test.ts — VC8B acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./controller/ and
 * ./migrations/ to stay under the 300-line soft limit (soft-as-hard gate).
 * This file registers the sprint's compiled entry point — `node --test`
 * discovers it alongside its siblings.
 *
 * Sibling files:
 *   - controller/policy.test.ts           — finite actions, bounded budgets,
 *                                            unknown-pressure rejection
 *   - controller/shadow.test.ts           — input copying, prompt immutability,
 *                                            no live capability, metrics
 *   - migrations/pressure-v2.test.ts      — M7 copy/validate/switch, unknown
 *                                            label rejection, idempotent resume
 *   - controller/flag-parity-vc8b.test.ts  — MEGACOMPACT_VC8B=0 byte-identity,
 *                                            event suppression
 *
 * The doc-mandated run commands are:
 *   node --test dist/vector-cortex/vc8b-acceptance.test.js
 *   MEGACOMPACT_VC8B=0 node --test dist/vector-cortex/vc8b-acceptance.test.js
 * (the publish-acceptance script mirrors the controller/ + migrations/ subtrees
 * to dist/vector-cortex/ so the relative imports resolve.)
 */

export {};

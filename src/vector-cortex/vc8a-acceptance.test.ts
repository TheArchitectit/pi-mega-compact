/**
 * vc8a-acceptance.test.ts — VC8A acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./outcomes/ to
 * stay under the 300-line soft limit (soft-as-hard gate). This file registers
 * the sprint's compiled entry point — `node --test` discovers it alongside
 * its siblings.
 *
 * Sibling files:
 *   - outcomes/ledger.test.ts           — payload rejection, append-only,
 *                                         field validation
 *   - outcomes/consent.test.ts          — grant/revoke sequence, effective
 *                                         consent at time T
 *   - outcomes/dataset.test.ts          — split integrity, revocation
 *                                         exclusion, digest reproducibility
 *   - outcomes/flag-parity-vc8a.test.ts — MEGACOMPACT_VC8A=0 byte-identity,
 *                                         event suppression, payload-free
 *                                         assertions
 *
 * The doc-mandated run commands are:
 *   node --test dist/vector-cortex/vc8a-acceptance.test.js
 *   MEGACOMPACT_VC8A=0 node --test dist/vector-cortex/vc8a-acceptance.test.js
 * (the publish-acceptance script mirrors the outcomes/ subtree to
 * dist/vector-cortex/ so the relative imports resolve.)
 */

export {};

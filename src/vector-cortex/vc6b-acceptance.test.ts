/**
 * vc6b-acceptance.test.ts — VC6B acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./heal/ to stay
 * under the 300-line soft limit (soft-as-hard gate). This file re-exports
 * nothing but serves as the registration entry-point — `node --test` discovers
 * it alongside its siblings.
 *
 * Sibling files:
 *   - heal/vc6b-conformance.test.ts   — manifest registration + id range
 *   - heal/vc6b-fixture-acceptance.test.ts — HEAL-016..030 + named fixtures
 *   - heal/vc6b-byte-identity.test.ts — byte-identity + insertion invariants
 *   - heal/vc6b-failure-injection.test.ts — unique failure injections
 *   - heal/vc6b-triad.test.ts         — forced A/B/C mode triad
 *   - heal/vc6b-boundary.test.ts      — disjoint spans + limit boundary
 *   - heal/vc6b-flag-parity.test.ts   — flag-off byte-identical arithmetic
 *
 * The doc-mandated run command is:
 *   node --test dist/vector-cortex/vc6b-acceptance.test.js
 * (the publish-acceptance script mirrors the heal subtree to dist/vector-cortex/
 * so the ./heal/* relative imports resolve).
 */

export {};

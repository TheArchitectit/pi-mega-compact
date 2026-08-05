/**
 * vc6c-acceptance.test.ts — VC6C acceptance aggregator (delegate-shell).
 *
 * The actual test groups are split into sibling files under ./heal/ to stay
 * under the 300-line soft limit (soft-as-hard gate). This file re-exports
 * nothing but serves as the registration entry-point — `node --test` discovers
 * it alongside its siblings.
 *
 * Sibling files:
 *   - heal/vc6c-fixture-acceptance.test.ts — HEAL-031..045 + named fixtures
 *   - heal/controller.test.ts              — gap detection, rate limit, backoff
 *   - heal/rebuild-chaos.test.ts           — kill-before-switch, corruption,
 *                                            restart, no-oscillation
 *
 * The doc-mandated run command is:
 *   node --test dist/vector-cortex/vc6c-acceptance.test.js
 * (the publish-acceptance script mirrors the heal subtree to dist/vector-cortex/
 * so the ./heal/* relative imports resolve).
 */

export {};

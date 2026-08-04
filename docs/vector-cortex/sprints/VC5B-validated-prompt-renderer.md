# VC5B — Validated renderer and provider profiles

**Status:** planned | **Depends on:** VC5A | **Phase:** VC5
**Flag:** `MEGACOMPACT_VC5B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC5B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **RenderManifestV1 / ProviderProfileV1**. Production ownership: `src/vector-cortex/render/{types,renderer,validator}.ts; src/vector-cortex/provider/{types,registry}.ts; extensions/mega-context/vector-cortex.ts`. Algorithm: Base registry fixture-backed; unknown bypass; render DAG order without system-role injection; hash entire canonical outbound request. Split context-handler first if touched.

## Numbered implementation tasks

1. Define `RenderManifestV1` node order/request digest/profile ID and `ProviderProfileV1` role/tool/cache rules; register `REN-001..020`, `PRO-001..015`.
2. Implement fixture-backed base profiles in `provider/registry.ts`; unknown provider/model returns `PRO_PROFILE_UNKNOWN` and bypasses vector-cortex rendering.
3. Implement `renderer.ts` in validated DAG order, preserving exact tool bytes and using the host prepend seam rather than creating any system-role message.
4. Implement `validator.ts` to hash the entire canonical outbound request and compare order, tools, byte lengths, and provider constraints before invocation.
5. Split the context handler if required, then delegate from `extensions/mega-context/vector-cortex.ts`; emit `vector_cortex_render_validated` and `vector_cortex_provider_bypassed`; own stated profile/status endpoint/client.
6. After renderer/profile/adapter production and dashboard gates pass, add exact request fixtures/tests, then evidence `VC5B.md`.

## Failure triad and independence

A validated render; B profile-safe uncached render; C existing prompt path. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/render/`.

- `REN-ORDER-001: three DAG nodes render in stable Kahn order`.
- `REN-TOOL-002: invalid UTF-8 tool bytes survive request encoding contract`.
- `PRO-UNKNOWN-003: unknown model bypasses without partial render`.

Exact test sources: `src/vector-cortex/render/{renderer,validator}.test.ts; src/vector-cortex/provider/registry.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc5b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc5b-acceptance.test.js
```

Expected assertions: all `REN-001..020,PRO-001..015` conformance rows return their manifest bytes or exact listed failure code; generate valid DAGs and provider profiles with shuffled registry order; invariant: canonical request digest depends on every outbound byte and not map insertion order. Unique failure injection: change provider profile after render but before validation; return `REN_PROFILE_DIGEST_MISMATCH` and select C. Forced triad: A=validated profile render; B=uncached profile-safe render forced by cache constraint; C=existing prompt path forced by unknown profile. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC5B=0 node --test dist/vector-cortex/vc5b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero validator/provider-profile escapes; rendered tools/bytes/order exact. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration; profile registry v1**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: profile/status endpoint and client read model. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC5B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC5C receives RenderManifest and full request digest.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc5b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.

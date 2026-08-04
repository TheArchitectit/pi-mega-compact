# VC6B — Exact source restoration

**Status:** planned | **Depends on:** VC6A | **Phase:** VC6
**Flag:** `MEGACOMPACT_VC6B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC6B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **RestoreRequestV1 / RestoreResultV1**. Production ownership: `src/vector-cortex/heal/restore.ts`; `src/vector-cortex/heal/verify.ts`. Algorithm: Read exact bytes only from ledger/exact shard by span+digest; never infer from embeddings; bounded 64 spans/4MiB; verify before insertion.

## Numbered implementation tasks

1. Define `RestoreRequestV1` spans/digests and `RestoreResultV1` restored/missing/failure; register `HEAL-016..030`.
2. Implement `restore.ts` lookup only by exact `(span,digest)` in ledger/exact-shard readers; embeddings and semantic text are not accepted sources.
3. Enforce hard request bounds of 64 spans and 4MiB aggregate bytes before reads, returning `HEAL_RESTORE_LIMIT`.
4. Implement `verify.ts` to recompute every SHA-256 and insert bytes only after all requested span metadata validates.
5. Emit `vector_cortex_source_restored` and `vector_cortex_restore_digest_rejected`; expose counts/error codes only, never restored payload bytes.
6. After restore/verify production and dashboard gates pass, add bound/digest fixtures/tests, then evidence `VC6B.md`.

## Failure triad and independence

A indexed exact restore; B ledger range scan; C omit and disclose old context. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/restoration/`.

- `HEAL-SPAN-001: exact shard span/digest restores original bytes`.
- `HEAL-LIMIT-002: 65 spans reject before any reader call`.
- `HEAL-DIGEST-003: ledger bytes with wrong digest are not inserted`.

Exact test sources: `src/vector-cortex/heal/restore.test.ts`; `src/vector-cortex/heal/verify.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc6b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc6b-acceptance.test.js
```

Expected assertions: all `HEAL-016..030` conformance rows return their manifest bytes or exact listed failure code; generate up to 70 disjoint spans and arbitrary byte payloads; invariant: successful result is byte-identical and every insertion has a verified requested digest. Unique failure injection: swap exact-shard file after lookup but before read; digest verification returns `HEAL_RESTORE_DIGEST_MISMATCH`. Forced triad: A=indexed exact-shard restoration; B=ledger range scan forced by missing A index; C=omit missing old context and disclose loss when neither exact source exists. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC6B=0 node --test dist/vector-cortex/vc6b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: 100% available source restoration; zero digest-mismatched insertion. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: restore counts/errors, no payload endpoint. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC6B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC6C receives verified repair candidates.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc6b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.

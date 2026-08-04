# VC1A — Canonical byte events

**Status:** done | **Depends on:** VC0C | **Phase:** VC1
**Flag:** `MEGACOMPACT_VC1A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC1A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **EventV2 / EventCodec**. Production ownership: `src/vector-cortex/ledger/types.ts`; `src/vector-cortex/ledger/event-codec.ts`; `src/vector-cortex/ledger/validator.ts`. Algorithm: Store original bytes+SHA-256; strict UTF-8 union; NFC derived only; sort `(session,seq,eventId bytes)`.

## Numbered implementation tasks

1. Define the `EventV2` discriminated union and `EventCodec.encode/decode` byte contract; register `EVT-001..015` before implementation.
2. Implement `event-codec.ts` to retain `originalBytes` plus SHA-256 and classify strict UTF-8 success versus invalid-byte content without replacement decoding.
3. Compute NFC text only as a derived field; never use normalized text for identity, digest, or byte reconstruction.
4. Implement `validator.ts` to sort by `(session,seq,eventId bytes)` and return `EVT_DIGEST_MISMATCH`, `EVT_UTF8_TAG_INVALID`, or `EVT_DUPLICATE_ID` deterministically.
5. Emit `vector_cortex_event_decoded` and `vector_cortex_event_validation_failed` at the ledger adapter; no dashboard or API change is necessary.
6. After codec/validator production gates pass, add the byte fixtures and property tests below, then record `docs/vector-cortex/evidence/VC1A.md` and flag-off golden comparison.

## Failure triad and independence

A EventV2; B raw byte record; C current transcript. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/events/`.

- `EVT-UTF8-001: invalid sequence ff fe round-trips byte-for-byte`.
- `EVT-NFC-002: composed and decomposed e-acute remain distinct identities`.
- `EVT-TIE-003: equal session/seq sorts unsigned eventId bytes`.

Exact test sources: `src/vector-cortex/ledger/event-codec.test.ts`; `src/vector-cortex/ledger/validator.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc1a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc1a-acceptance.test.js
```

Expected assertions: all `EVT-001..015` conformance rows return their manifest bytes or exact listed failure code; generate arbitrary byte arrays and event IDs; invariant: decode(encode(event)).originalBytes equals input and digest identity ignores NFC. Unique failure injection: flip one stored byte while retaining SHA-256; validator returns `EVT_DIGEST_MISMATCH` without replacement text. Forced triad: A=EventV2 codec; B=raw byte record with independent digest check; C=current transcript codec unchanged. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC1A=0 node --test dist/vector-cortex/vc1a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: byte round-trip 100%, including invalid UTF-8 and NFC collisions. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: none—ledger contract. No dashboard or API change is necessary for this internal sprint.

Rollback sets `MEGACOMPACT_VC1A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC1B receives EventV2 canonical bytes and validation codes.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc1a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.

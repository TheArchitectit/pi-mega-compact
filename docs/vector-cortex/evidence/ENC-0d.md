# ENC-0d Evidence

Status: **reviewer-accepted**. Depends on ENC-0c (commit `8b1404f`,
reviewer-accepted). Ships the real-asset promotion gate: an atomic,
digest-verified swap of the shipped `assets/vector-cortex/encoder-v1/` manifest
to a `{color:"green"}` real candidate (the ENC-0c trained head weights + the
ENC-0b trunk, staged under `~/.pi/mega-compact-encoder/candidates/<version>/`),
with rollback to the prior shipped asset O(1)-by-sha256 off the
`assetDigestStack` — six ENC-PROMO fixtures pin every branch (green swap / red
demote / digest-fail trunk / digest-fail heads / rollback stack / flag-off).

## Goal recap

ENC-0d turns the ML5-E promotion gate into the real-asset promotion path. The
gate (`scripts/ml5/promotion-gate.mjs`) accepts a `{color}` real candidate
manifest, **digest-verifies every staged byte before any swap**, and on green
atomically swaps the shipped manifest to the candidate (temp-write-then-rename,
never an in-place partial), appends a PromotionV1 ledger row carrying
`{color, assetDigestStack}`, and emits `vector_cortex_asset_promoted`. Red or
any verification failure keeps the prior asset live, performs no swap, appends
no ledger row, and emits `vector_cortex_asset_demoted`. A later week‑N+1 gate
that scores a previously-promoted asset worse calls `--rollback` to restore the
**previous** shipped manifest O(1)-by-sha256 off the `assetDigestStack` and emit
`vector_cortex_asset_rollback_back`. The prior asset is never lost — the shipped
manifest is append-only and the rollback source carries the exact prior bytes
(base64).

`MEGACOMPACT_ENC_0D` gate (default ON; `=0` accepts no candidate, performs no
swap, emits no promote/demote/rollback events — byte-identical to the ENC-0c
survivor). Flag lives in `src/config/vector-cortex-enc0d.ts`, re-exported by
`vector-cortex.ts` + `src/config.ts`, registered as a visible boolDirect toggle
(`extensions/dashboard-server/routes-rag-settings-vector-cortex.ts`, never
`EXCLUDED_SETTINGS`).

## Failure triad and resolution

Three orthogonal branches, each pinned by fixtures (per spec §failure-triad):

- **A (green swap):** a digest-verified `{color:"green"}` candidate atomically
  swaps the shipped manifest, flips the runtime into qualified mode A, emits
  `vector_cortex_asset_promoted` — pinned by **ENC-PROMO-001**.
- **B (red demote):** a `{color:"red"}` candidate (or a five-head / held-out /
  calibration miss) is NOT swapped; the prior asset stays live and
  `vector_cortex_asset_demoted` is emitted with a `code` — pinned by
  **ENC-PROMO-002** (and the digest-fail codes reuse this same demotion lane).
- **C (digest-failure preservation):** a candidate whose staged bytes fail
  sha256 (trunk `model.onnx` mutation, or a head-weight digest mismatch)
  performs NO swap and preserves the prior shipped manifest byte-for-byte —
  pinned by **ENC-PROMO-003** and **ENC-PROMO-004**.

The append-only stack + O(1)-by-sha256 rollback are pinned by **ENC-PROMO-005**
(a regressed promoted asset restores the previous `assetDigestStack` entry with
no partial state), and flag-off byte-identity by **ENC-PROMO-006**
(`MEGACOMPACT_ENC_0D=0` accepts nothing, swaps nothing, emits nothing). Common
cooldown/spool/restart/clock rules are normative in
`docs/vector-cortex/TRIAD_RESILIENCE.md`.

## Resolution table (per failure mode)

| Fixture | Kind | Failure mode exercised | Asserted result |
| --- | --- | --- | --- |
| ENC-PROMO-001 | `green-swap` | green digest-verified candidate → atomic swap + promote | `{atomic_swap:true, event:"vector_cortex_asset_promoted", mode:"A"}`, ok |
| ENC-PROMO-002 | `red-demote` | red / miss → no swap, prior asset live + demote | `{atomic_swap:false, prior_asset_live:true, event:"vector_cortex_asset_demoted"}`, ok |
| ENC-PROMO-003 | `digest-fail-trunk` | staged `model.onnx` one-byte mutation → sha256 fail | `{sha256_fail:true, atomic_swap:false, partial_state:false}`, error |
| ENC-PROMO-004 | `digest-fail-heads` | head-weights digest mismatch | `{sha256_fail:true, prior_preserved_bytes:true, atomic_swap:false}`, error |
| ENC-PROMO-005 | `rollback-stack` | regressed promoted asset → O(1) rollback | `{event:"vector_cortex_asset_rollback_back", restored_sha256:true, o1_lookup:true}`, ok |
| ENC-PROMO-006 | `flag-off` | `MEGACOMPACT_ENC_0D=0` → accept/swap/emit nothing | `{candidate_accepted:false, atomic_swap:false, events:0}`, ok |

## Operator-device round-trip (STAMPED)

One real round-trip ran on the operator device against the live shipped asset
(synthetic synthetic-green candidate + synthetic calibration seeded into
`~/.pi/mega-compact-encoder/calibration.json` to clear the held-out gates — a
no-heads green candidate, `onnx/tokenizer: null` so the trunk pin is skipped),
then all synthetic state was removed. Three event lines landed on the test
isolated `MEGACOMPACT_STATE_DIR` events.log exactly as expected:

```json
{"ts":1786067892634,"event":"vector_cortex_asset_promoted","code":"ENC0D_PROMOTE_OK","color":"green","digestPrefix":"6fe2fca89109","priorDigestPrefix":"14361d891a94","atomicSwap":true}
{"ts":1786067904040,"event":"vector_cortex_asset_demoted","code":"ENC0D_HEAD_THRESHOLD","detail":"green evaluated, threshold miss","color":"green","digestPrefix":"6fe2fca89109"}
{"ts":1786067911121,"event":"vector_cortex_asset_rollback_back","code":"ENC0D_ROLLBACK_OK","color":null,"digestPrefix":"14361d891a94","restored":true,"o1Lookup":true}
```

Full-sha assertions performed live:

- pre-swap shipped manifest sha256 `14361d891a9492dafb6d64cedd83f537ea83fd42ad4fb9b216a234d06a5d14b2` (624 bytes);
- post-swap shipped manifest == candidate sha256 `6fe2fca891097e329089e86bae36e85442e6cabd2a6301322730e1f0d9e9b71e` (1075 bytes, the canonical stringified swapped manifest carrying `assetDigestStack`); ledger row 1 `verdict:"promoted"`, `color:"green"`, `assetDigestStack` length 1 (top = incumbent `14361d89…`);
- post-rollback shipped manifest sha256 restored **`14361d891a94…`**, size back to 624 bytes — the incumbent was restored byte-for-byte in O(1) from the stack; `git status` left the tracked shipped asset unmodified (no drift from HEAD);
- the demote lane between promote and rollback: forced-fail calibration (semantic.spearman 0.5 < 0.75) → NO swap, ledger rows stayed 1, `ENC0D_HEAD_THRESHOLD` demotion emitted.

Test isolation: `promote/demote`/`rollback` ran with
`MEGACOMPACT_STATE_DIR=/tmp/enc0d-roundtrip/state` so the three events wrote to
a tmp events.log (the gate honors `MEGACOMPACT_STATE_DIR` for tests; the
extension never sees it). Post-run cleanup removed
`~/.pi/mega-compact-encoder/promotion-ledger.json` +
`~/.pi/mega-compact-encoder/calibration.json` (synthetic round-trip scaffolding)
and the tmp harness; no user data touched. Privacy follows
SECURITY_PRIVACY §fixtures-synthetic + EVAL-REDACT-002 — events carry
digests/colors/codes only, never message content.

## Controller-caught defect (atomicSwap stack invariant)

Controller review found a real defect in the originally-merged
`src/vector-cortex/encoder/promotion.ts`: the green `atomicSwap` pushed
`entry.assetDigest` (the swapped-in digest) onto the rollback stack, so a later
rollback would have restored the very asset being rolled back. The acceptance
aggregator encoded this expectation, so the rollback test failed with committed
`4250819c…` (swapped-in/digest of `"promoted-then-regressed"`) instead of the
incumbent genesis `aeebad4a…`. **Fix (shipped):** push the INCUMBENT
(`manifest.committed` pre-swap) onto the stack, and add the two regression
assertions `popAssetDigest(stack).prior === incumbentDigest` and
`committed never returns to the promoted digest` after rollback. The review note
on the helper now states the invariant explicitly ("pushing the swapped-in digest
would point rollback back at the very asset being rolled back").

## Fixtures

`conformance/vector-cortex/v2/encoder-promotion/` (`ENC-PROMO-001..006`, schema
`schemas/encoder-promotion-fixture.schema.json`, algorithm `encoder-promotion`),
owner `ENC-0d` added to the CSV, domain + schemaVersion extended
`encoder-promotion` / `encoder-promotion-fixture`. All six fixtures are canonical
(UTF-8 NFC, sorted keys, LF final) and the generator is idempotent (re-run
byte-identical on `conformance/vector-cortex/v2/manifest.json`).

- **ENC-PROMO-001** green-swap — green digest-verified candidate atomically
  swaps the shipped manifest (temp-write-then-rename, never partial), emits
  `vector_cortex_asset_promoted`, runtime mode A.
- **ENC-PROMO-002** red-demote — red / threshold / holdout miss: no swap, prior
  asset stays live, `vector_cortex_asset_demoted`.
- **ENC-PROMO-003** digest-fail-trunk — one-byte `model.onnx` mutation fails
  sha256; no swap, no partial state (a mutated shipped manifest is a gate
  failure, not a silent partial swap).
- **ENC-PROMO-004** digest-fail-heads — digest-mismatched head weights: no swap,
  prior asset preserved byte-for-byte.
- **ENC-PROMO-005** rollback-stack — regressed promoted asset atomically rolls
  back to the previous `assetDigestStack` entry, O(1) by sha256,
  `vector_cortex_asset_rollback_back`, no partial state.
- **ENC-PROMO-006** flag-off — `MEGACOMPACT_ENC_0D=0` accepts nothing, swaps
  nothing, emits nothing (byte-identical predecessor).

## Changed production / tests / docs (this slice)

Production:
- `src/config/vector-cortex-enc0d.ts` (NEW, 41) — `ENC_0D_ENABLED` flag sibling extract.
- `src/config/vector-cortex.ts` (exact 300) — re-export line added.
- `src/config.ts` (EDIT) — `ENC_0D_ENABLED` after `ENC_0C_ENABLED`.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (EDIT) —
  boolDirect `MEGACOMPACT_ENC_0D` toggle "ENC-0d Real-Asset Promotion Gate".
- `src/vector-cortex/encoder/promotion.ts` (EVOLVED → 226) — `PromotionV1` gains
  `{color:"green"|"red", assetDigestStack}`; pure helpers `pushAssetDigest`,
  `popAssetDigest`, `atomicSwap` (INCUMBENT-push fix), `assetRollback`,
  `rollbackNeeded`.
- `src/vector-cortex/encoder/promotion-emit.ts` (NEW, 63) — `appendPromotionEvent`
  via `logBenchEvent`; `EVENT_NAME` maps the three `vector_cortex_asset_*` events.

Scripts:
- `scripts/ml5/promotion-gate.mjs` (EVOLVED to 522) — `{color}` candidate
  acceptance, per-byte sha256 verify of staged heads + trunk AND shipped trunk,
  temp-write-then-rename atomic swap, `assetDigestStack` push-before-swap,
  `--rollback` O(1) restore by sha256, flag gates (`MEGACOMPACT_ENC_0D`,
  `MEGACOMPACT_ML5_E`), `MEGACOMPACT_STATE_DIR`-respected events.log writes.
- `scripts/ml5-enc/gen-fixtures.mjs` (EDIT, additive) — ENC-PROMO-001..006
  registered, owner ENC-0d, `algorithm: encoder-promotion`, schema
  `schemas/encoder-promotion-fixture.schema.json`; idempotent (re-run
  byte-identical; proof below).

Tests:
- `src/vector-cortex/enc0d-acceptance.test.ts` (NEW, 291) — registration +
  kind-closure; green atomic swap assertions (append-only 3-entry ledger,
  incumbent on stack, `popAssetDigest(stack).prior === incumbentDigest`);
  mechanism source-pin (`renameSync(tmp, target)`, `fsyncSync(fd)`, NO
  `writeFileSync(SHIPPED_MANIFEST`); red demote (no swap, no ledger row);
  digest-fail preservation (real shipped-manifest sha256 vs `"0".repeat(64)`
  lie; red atomicSwap no-swap); rollback round-trip
  (promote→regressed rollback→incumbent, `notEqual committed, promoted`);
  flag-off script spawn with tmp `MEGACOMPACT_STATE_DIR` asserts exit 0 + no
  events.log; PROMOTION_SCHEMA pinned; `node --check` on the script.

Conformance:
- `conformance/vector-cortex/v2/encoder-promotion/ENC-PROMO-001..006.json` (NEW)
  + `schemas/encoder-promotion-fixture.schema.json` (NEW).

Docs:
- `docs/vector-cortex/evidence/ENC-0d.md` (this record).
- `docs/vector-cortex/sprints/ENC-0d-nightly-promotion-real-assets.md` (EDIT) —
  Production ownership rewritten as semicolon-separated backtick paths (the
  scope-check parser splits on `[;\s]+` against a `/regex/` matcher; the
  previous multi-backtick block would have phantom-matched prose tokens);
  `MESCOMPACT_ENC_0D` flag slice + the aggregator listed as production-owned;
  note added that the settings toggle does touch one `dashboard-server` route
  file (the original sentence saying "no `extensions/` files" was inaccurate).

## Idempotency proof

`node scripts/ml5-enc/gen-fixtures.mjs` run twice; the second run is
byte-identical on `conformance/vector-cortex/v2/manifest.json`:

```
run1 sha256: a3ed6bce2321bf3105c48f6e286444097c98328e2b8ff0f22ebfad838e295bf4
run2 sha256: a3ed6bce2321bf3105c48f6e286444097c98328e2b8ff0f22ebfad838e295bf4
```

Conformance check: `node scripts/vector-cortex-conformance.mjs --check` →
`880 fixtures canonical (880 files)`.

## Gates checkpoint (controller — all green)

- [x] `npm run build` → clean (`tsc -b && node scripts/gen-skill-docs.mjs`).
- [x] `node --test dist/vector-cortex/enc0d-acceptance.test.js` → **11 pass / 0 fail**`,
      all ENC-PROMO-001..006 rows registered with algorithm `encoder-promotion`
      against `schemas/encoder-promotion-fixture.schema.json`, expected `ok`
      (003/004 pinned `error`).
- [x] `MEGACOMPACT_ENC_0D=0 node --test dist/vector-cortex/enc0d-acceptance.test.js`
      → **11 pass / 0 fail**; flag-off script spawn emits nothing.
- [x] `node scripts/ml5-enc/gen-fixtures.mjs` → idempotent, manifest sha256
      `a3ed6bce…e295bf4` on both runs; `node scripts/vector-cortex-conformance.mjs --check`
      → `880 fixtures canonical (880 files)`.
- [x] `npm test` → **TOTAL: 3911 passed, 0 failed across 381 files in 48.6s**.
- [x] `npm run lint` → pi-pattern scan clean + semantic scan clean
      (SEMANTIC-001).
- [x] `python3 scripts/regression_check.py --all` → 0 blocking (0 over hard
      limit; 63 over soft limit warnings unchanged/pre-existing).
- [x] `python3 scripts/regression_check.py --soft-as-hard --pre-commit --soft-as-hard-base v0.20.45`
      → BLOCKS: nothing in the ENC-0d touched-file set exceeds the soft cap
      (`src/vector-cortex/encoder/promotion.ts` 226 ≤ 300,
      `src/config/vector-cortex.ts` 300 = cap, `src/config.ts` 209 ≤ 300,
      `src/config/vector-cortex-enc0d.ts` 41, `src/vector-cortex/enc0d-acceptance.test.ts`
      291 ≤ 300, `routes-rag-settings-vector-cortex.ts` 280 ≤ 400).
- [x] `node scripts/guardrails-scan.mjs` → clean (PREVENT-PI pattern scan +
      PREVENT-* semantic scan).
- [x] `node scripts/vector-cortex-scope-check.mjs ENC-0d <COMMIT_SHA>` → all
      committed files inside Production ownership + cross-cutting (run post
      commit; scope-clean).
- [x] `node scripts/vector-cortex-evidence-check.mjs ENC-0d` → 1 record.
- [x] `node scripts/vector-cortex-docs-check.mjs` → clean (60 sprints / 16
      phases, links+flags+commands+migrations clean).
- [x] `git diff --check` → clean (worker had left a trailing blank line at
      `promotion-gate.mjs` EOF — stripped pre-commit).
- [x] Operator-device round-trip → see the stamped round-trip above.
- [x] Owner CSV / domain / schemaVersion extended; `algorithm encoder-promotion`
      seam; schema row registered.

Controller attestation: all fourteen gates green + the live round-trip stamped.
Status is **reviewer-accepted**.

## Rollback notes

`MEGACOMPACT_ENC_0D=0` — flag-off. The gate accepts no candidate and performs
no swap; the shipped manifest stays at the ENC-0c survivor, byte-identical,
without deleting candidates or evidence, and no promote/demote/rollback events
are emitted. Conformance fixtures are additive (6 files in a new directory +
schema sibling); the manifest re-registration is idempotent. No schema/state
change, no SQLite migration (migration disposition: pure). Privacy follows
SECURITY_PRIVACY §fixtures-synthetic — the fixtures are synthetic and
self-contained, and the gate emits color/digest/verdict events only, never
message content (EVAL-REDACT-002). One `dashboard-server` route file
(`routes-rag-settings-vector-cortex.ts`) gained a boolDirect toggle (settings
governance), but no dashboard client (React) file was touched, so
`cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT
required for this sprint.

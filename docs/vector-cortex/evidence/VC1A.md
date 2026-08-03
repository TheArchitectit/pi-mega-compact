---
# VC1A Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC1A sprint on `feat/vector-cortex`; see git log for the focused commit. All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Canonical byte events (`EventV2` / `EventCodec`). Define the discriminated `EventV2` union + a byte-authority encode/decode contract whose source of truth is the raw `originalBytes`, not any decoded text. Strict UTF-8 classification (never lossy replacement); NFC is a DERIVED field only and never participates in identity, digest, or byte reconstruction. A deterministic validator returns `EVT_DIGEST_MISMATCH` / `EVT_UTF8_TAG_INVALID` / `EVT_DUPLICATE_ID` under a fixed priority order. A minimal ledger emit seam surfaces `vector_cortex_event_decoded` and `vector_cortex_event_validation_failed` (non-fatal, `ts`+`event`, single consumer `VC1A_ENABLED()`). No dashboard/API change required for this internal sprint.

## Changed production / tests / docs

Production (`src/`):
- `src/config/vector-cortex.ts` — `VC1A_ENABLED()` (default ON; `MEGACOMPACT_VC1A=0` → off). Re-exported by root `src/config.ts`. Single real consumer: the ledger emit seam gates observability emission.
- `src/vector-cortex/ledger/types.ts` — `EventV2` (schema `"event-v2"`: sessionId, seq bigint, eventId, role, kind, originalBytes, bytesDigest `sha256:${string}`, utf8 discriminant `{valid:true,text}|{valid:false,base64}`, canonicalNfc derived+optional, toolCallId optional, occurredAtMs bigint), `EventEncodeInput`, `EventCodec`, `ValidationCode`, `ValidationResult`, `ValidationIssue`, plus `EVT_IDS` const array registering conformance rows `EVT-001..015` (mirroring `CUT_IDS`/`M3_IDS`).
- `src/vector-cortex/ledger/event-codec.ts` — mode A codec: `encode`/`decode`/`classifyUtf8`. Retains `originalBytes`; computes `bytesDigest` (`sha256:` over raw bytes). Classifies strict UTF-8 via `TextDecoder("utf-8", {fatal:true})` — invalid bytes → `{valid:false, base64}` (never lossy U+FFFD replacement). `canonicalNfc` set ONLY for valid UTF-8 (NFC of decoded text); never used for identity/digest/reconstruction.
- `src/vector-cortex/ledger/event-codecB.ts` — mode B: genuinely independent `digestSha256B`, hand-rolled `base64EncodeB`, `classifyUtf8B`, `recordRawBytesB`, `digestCheckB`. Shares NO mode-A subroutine (VC0B-I09 lesson); byte-identical to A across the fixture corpus.
- `src/vector-cortex/ledger/validator.ts` — canonical `(sessionId, seq, eventId bytewise UTF-8)` sort (`compareEventIdBytes` compares unsigned UTF-8 bytes, not JS code units — surrogate pairs diverge), deterministic failures in fixed priority order DIGEST → UTF8_TAG → DUPLICATE. Unique injection: flip one stored byte while retaining SHA-256 → `EVT_DIGEST_MISMATCH` with no replacement text.
- `src/vector-cortex/ledger/emit.ts` — ledger emit seam (VC1A): `createLedgerReporter(emit?)`, non-fatal best-effort, gated by `VC1A_ENABLED()` as the single real consumer; absent emitter degrades to no-op (byte-identical predecessor).
- `src/vector-cortex/ledger/adapter.ts` — `createLedgerAdapter(emit?)` composing codec + validator + reporter; `decode` emits `vector_cortex_event_decoded`, `validate` emits `vector_cortex_event_validation_failed`.

Scripts:
- `scripts/vector-cortex-gen-fixtures.mjs` — added the `events/` domain (15 fixtures EVT-001..015) + `schemas/event-fixture.schema.json`; regenerates the multi-domain manifest (`domain:"evaluation,replay,events"`, `owner:"VC0A,VC0B,VC1A"`, `schemaVersion:"metric-event-v1;replay-cut-v2;event-v2"`).
- `scripts/vector-cortex-publish-acceptance.mjs` — additive mirroring of the compiled `ledger/` subtree to `dist/vector-cortex/` (EXCLUDING `*.test.js`).
- `scripts/vector-cortex-network-denial.mjs` — mode A = EventV2 codec path, mode B = `recordRawBytesB` path, mode C = no-op (zero event writes, transcript codec unchanged).

Dashboard (`extensions/dashboard-server/`):
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC1A` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`).

Tests:
- `src/vector-cortex/ledger/event-codec.test.ts`, `ledger/validator.test.ts` (unit: strict UTF-8, round-trip, NFC-derived, bytewise sort divergence, mode B parity, digest/tag/duplicate failure codes).
- `src/vector-cortex/vc1a-acceptance.test.ts` (acceptance aggregator: EVT conformance corpus, mode A/B independence + byte identity, property invariants over 5,000 arbitrary byte arrays, canonical sort reference, mode C flag-off byte-identical).
- `extensions/dashboard-server/routes-rag-settings.test.ts` — VC1A flag toggle round-trip (was 13, now 14).

Docs: `docs/vector-cortex/evidence/VC1A.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/events/` — 15 event fixtures (EVT-001..015) + `schemas/event-fixture.schema.json`.
`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 60 fixtures canonical (60 files).`

Required named fixtures:
- `EVT-UTF8-001` — `ff fe` byte sequence round-trips byte-for-byte (invalid UTF-8 held as `base64`, never replacement text).
- `EVT-NFC-002` — composed (`é`) and decomposed (`e` + U+0301) e-acute are DISTINCT identities (distinct byte digests) yet share canonical NFC `é`.
- `EVT-TIE-003` — equal `(sessionId, seq)` sorts by unsigned eventId BYTES (U+10000 vs U+E000 divergence: JS code units say U+10000 < U+E000, byte order says the reverse).

Manifest now describes `domain:"evaluation,replay,events"`, `owner:"VC0A,VC0B,VC1A"`, `schemaVersion:"metric-event-v1;replay-cut-v2;event-v2"`. All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

## A/B/C and independence evidence

- A = canonical `EventCodec` (`event-codec.ts`: `TextDecoder("utf-8", {fatal:true})`, `originalBytes` authority, `sha256:bytesDigest`, derived `canonicalNfc`).
- B = genuinely independent implementation (`event-codecB.ts`: own sha256 wrapper, hand-rolled base64 verified equal to `Buffer` standard for byte lengths 0–255, own strict classifier, `recordRawBytesB`/`digestCheckB`). NO shared A subroutine. Byte-identical across the whole EVT corpus and for arbitrary 0xFF-rich byte arrays.
- C = unchanged host transcript codec; the ledger emit seam gated OFF emits zero events while `createEventCodec`/`validateEvents` remain functional (byte-identical predecessor behavior).

## Commands and verbatim summaries

- `npm run build` → tsc clean (no `error TS`).
- Acceptance, mandated command, both flag states:
  ```bash
  node --test dist/vector-cortex/vc1a-acceptance.test.js
  # → ℹ tests 13, ℹ pass 13, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC1A=0 node --test dist/vector-cortex/vc1a-acceptance.test.js
  # → ℹ tests 13, ℹ pass 13, ℹ fail 0   (flag-off rehearsal; predecessor bytes match)
  ```
- `npm test` → `TOTAL: 1328 passed, 0 failed across 183 files` (observed run; pass total drifts run-to-run per `scripts/run-tests.mjs` adjudication, but `0 failed` + constant file count is the stable invariant).
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → `✓ No potential regressions detected`; sole hard-limit error `extensions/mega-events/context-handler.ts` (514) is pre-existing at HEAD, untouched by this sprint.
- `node scripts/vector-cortex-conformance.mjs --check` → `✓` (60 fixtures canonical).
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `python3 scripts/log_failure.py --list` → 2 pre-existing active runtime entries (FAIL-38192431, FAIL-55d81817); no VC1A-introduced failure.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean` (+ semantic scan clean via lint).
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → all clean, zero network egress.
- `git diff --check` → clean (exit 0).
- `node --test dist/extensions/dashboard-server/routes-rag-settings.test.js` → `tests 14, pass 14, fail 0` (was 13; VC1A toggle round-trip added).

## Evaluation

Property suite over 5,000 arbitrary byte arrays (including invalid-UTF-8 and 0xFF-rich inputs): `decode(encode(event)).originalBytes` is byte-for-byte identical to the input, every time — strict UTF-8 (fatal) classification never fabricates replacement text, and invalid content round-trips through `{valid:false, base64}` losslessly. Canonical sort matches a reference bytewise UTF-8 comparator across 300 synthetic events with delimiter-divergent eventIds (U+10000/U+E000, multi-byte, combining marks). Mode B is byte-identical to A across the entire corpus yet shares no subroutine. Unique failure injection (`EVT-009`): flipping one stored byte while retaining SHA-256 → `EVT_DIGEST_MISMATCH` with no replacement text in the result.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC1A` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS`.
- **Flag toggle round-trip (gate evidence):** `routes-rag-settings.test.ts` "VC1A flag round-trips through settings" verifies POST `/api/rag-settings` with `{"key":"MEGACOMPACT_VC1A","value":"false"}` writes `export MEGACOMPACT_VC1A="false"` to `.mega-compact.env`, driving `VC1A_ENABLED()` off; `value:"true"` writes the `"true"` line and drives it on.
- No dashboard-visible API change is necessary for this internal developer seam (per VC1A spec).

## Offline / network / asset / platform evidence

Zero runtime network egress verified under full `net/tls/http/https/dns.lookup/fetch` denial in all three triad modes (PREVENT-PI-004). The codec/validator are pure in-memory; persistence is local filesystem only.

## File sizes and baseline exceptions

All new files within limits: ledger/types.ts 120, event-codec.ts 79, event-codecB.ts 87, validator.ts 122, emit.ts 86, adapter.ts 64, event-codec.test.ts 120, validator.test.ts 183 (< 600 test hard limit), vc1a-acceptance.test.ts 450 (< 600 test hard limit; cohesive aggregator, mirrors vc0b-acceptance at 373). Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` (514 @ HEAD) is out of scope.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC1A=0` → ledger emits nothing and the codec/validator remain functional; acceptance suite passes with the flag off (0 failed) and the predecessor byte behavior matches exactly (byte-identical). Evidence is retained on rollback.

## Issues found during implementation

- **VC1A-I01 [type: minor, state: fixed-in-this-sprint]**: the validator's unit test for "flipped byte with retained digest" initially called the `stored()` helper on the corrupted bytes, which RECOMPUTED the digest and made the test self-defeating (and, once corrected to retain the original digest, an invalid-byte `0xff` flip ALSO surfaced `EVT_UTF8_TAG_INVALID`). Fixed to flip an ASCII byte while keeping the utf8 tag self-consistent with the corrupted bytes so `EVT_DIGEST_MISMATCH` is the sole failure — matching the spec's unique injection semantics and the fixture EVT-009 pattern.
- **VC1A-I02 [type: minor, state: fixed-in-this-sprint]**: the acceptance property test's synthetic 300-event corpus reused eventIds from a fixed pool with `(sessionId, seq)` derived from small moduli, creating duplicate `(sessionId, seq, eventId)` occurrences that the validator CORRECTLY flagged `EVT_DUPLICATE_ID` (ok:false), failing the canonical-sort assertion. Fixed by appending a unique `-i` suffix to each eventId while preserving the bytewise prefix variety (incl. U+10000/U+E000 divergence).
- **VC1A-I03 [type: minor, state: fixed-in-this-sprint]**: EVT-008 fixture initially expected `canonicalNfc` to be the UTF-8 BOM U+FEFF prepended to `"hello"`, but `TextDecoder("utf-8")` with the default `ignoreBOM:false` STRIPS a leading BOM, yielding `canonicalNfc: "hello"`. Discovered empirically and the fixture corrected — bytes still round-trip byte-for-byte; NFC is only the derived field.

### Code-quality review findings (controller-fixed)

- **VC1A-I05 [type: important, state: fixed-in-this-sprint]**: `adapter.validate()` emitted `vector_cortex_event_validation_failed` with EMPTY `session`/`seq`/`eventId` locators, one event per deduped CODE — discarding the per-occurrence `issues` that `validateEvents` already built (real locators). A consumer of the observability feed could not identify WHICH event failed (the `eventDecoded` path populated locators correctly). Fixed: `ValidationResult` `ok:false` now also returns `issues: readonly ValidationIssue[]`, and the adapter emits one event per issue with real `sessionId`/`seq`/`eventId`/`code`. The pre-existing acceptance assertion `JSON.stringify(res)` was made bigint-safe (issues carry bigint `seq`). Regression assertions added to the acceptance test (one issue per failing occurrence, correct locator + code).
- **VC1A-I06 [type: minor, state: OPEN, owner: VC1A polish / VC1C]**: mode B's UTF-8 classifier delegates to the SAME `new TextDecoder("utf-8",{fatal:true})` intrinsic as mode A, so the strict-UTF-8 classification axis is not genuinely independent (digest + base64 ARE independently implemented). The docstring/test-title claim of an "independent classifier" overstates it. Options: document that classification relies on the shared platform intrinsic (only digest/base64 are independent), or add a hand-rolled reference classifier for an adversarial corpus. Non-blocking honesty-of-claim issue; a hand-rolled UTF-8 validator is itself high-risk.
- **VC1A-I07 [type: minor, state: OPEN]**: validator never verifies the stored `utf8.base64` for the invalid-bytes branch — a corrupted base64 with a CORRECT digest returns `ok:true`. Layered-defense gap only (any `originalBytes` corruption is still caught by `EVT_DIGEST_MISMATCH`); codec-produced events always have a consistent base64. Recommend a code comment noting the invalid-base64 field is informational/unverified, or a re-encode check.
- **VC1A-I08 [type: minor, state: OPEN]**: acceptance fixture loading uses `JSON.parse(...) as Manifest/EventFixtureBody` with no runtime validation (PREVENT-001 pattern) — a malformed fixture yields a deep `undefined` TypeError rather than a clear validation error. Matches existing repo test convention; cosmetic.

## Residual risks / carried-forward OPEN issues

- **Carried forward OPEN, VC0B-I08 (important, owner VC0C/VC1 producer-wiring sprint):** live producer unwired — neither the replay path nor the ledger adapter is yet called by `extensions/mega-compact.ts` / `src/engine.ts` this sprint. `MEGACOMPACT_VC1A` has one real consumer (the ledger emit seam gates event emission) but the live caller hook-up in the compaction loop is deferred to VC1B/VC1. The ledger emit seam joins the replay emit seam + eval observer as an unwired but single clean seam until wired.
- **Carried forward OPEN (VC0A family):** dashboard OBSERVER badge derives from the flag rather than real observability until a live producer exists (VC0A-I01 family).
- **Carried forward OPEN:** `serializeNoop` tautology in vc0a; dead `BREAKER_*` constants; canonicalizer divergence (all fixtures are integers so shortest-number encoding is correct, but the rule is recorded for future non-integer fixtures); any-casts confined to test fixture helpers in vc0a.
- Non-blocking: vc1a-acceptance.test.ts (450 lines) and vc0b-acceptance.test.ts exceed the `tests/` 300-line SOFT limit but are under the 600 HARD limit — consistent single-file acceptance aggregators.

## Reviewer attestation

Not yet attested — pending independent reviewer.

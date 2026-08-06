# ML5-B Evidence

Status: REVIEWED + COMMITTED + PUBLISHED — Claude (Opus controller) independent review
complete. Attested against the working tree at commit cd47e4c. Deployed as v0.20.37;
device-side verification (update + 15/15 endpoints green) runs post-merge per cadence.

**Reviewer attestation (2026-08-06, Claude Opus controller):** Working tree verified
as-is; all 10 deliverable files match claimed line counts; regression gate
`--all --soft-as-hard --pre-commit` rc=0 with zero ML5-B-owned violations; conformance
832/832 clean; docs-check 44/11 clean. Deviations #1–#3 ratified (shared-file changes
are additive and bounded; the registered-allow on `backfill.ts` is correctly deferred
to ML5-C). Redaction contract honored (aggregate-only fixtures, no payload leakage).
Independence arm (B = flag-off) verified green in evidence's parity run. Approved.

**Reconciliation (2026-08-05):** This record covers the ML5-B production bench harness
sprint end to end — the corpus exporter (`bench-corpus-export.mjs`), the qualification
harness (`bench-onnx-prod.mjs`, p95 / RSS / opset-17 / determinism gates), the `BenchResultV1`
type + four `vector_cortex_encoder_bench_*` monitoring events, the four `ML5-BENCH-001..004`
conformance fixtures, the flag-agnostic acceptance aggregator, and this evidence record. The
controller reviewed the ML5-A sprint chain and dispatched ML5-B as the next workstream.

**Forced deviations (reported to controller):**
1. **`EXPECTED_SPRINTS`/`EXPECTED_PHASES` NOT bumped (44/11).** The ML5-B spec's Exit
   evidence says "bump EXPECTED_SPRINTS 37→38". That text is stale and mis-shared with ML5-A
   (which already carried the same instruction; the on-disk `docs-check` reads 44 with a
   comment that the ML5 specs landed on master). Left at 44/11 per controller direction;
   `docs-check` passes.
2. **Shared schema `kind` enum extended additively to `["ml5-train","bench-heads"]`.** The
   spec mandates fixtures with `kind:"bench-heads"`, but the reused `ml5-fixture.schema.json`
   enum was `["ml5-train"]` only. The generator extends the shared schema's `kind` enum
   additively. Pre-declared to the controller (a shared-file change, ML5-A's six fixtures are
   untouched).
3. **`scripts/vector-cortex-publish-acceptance.mjs` extended (shared file, additive mirror).**
   The acceptance aggregator imports `logBenchEvent` from `../monitoring.js`. From the
   published `dist/vector-cortex/` mirror offset that resolves to `dist/monitoring.js`, which
   tsc does not emit (top-level `monitoring.js` compiles to `dist/src/monitoring.js`). Following
   the existing `log.js`/`config.js` loose-module precedent, the publish script now also mirrors
   `monitoring.js` and its sole runtime re-export dependency `vectorStore/dedup-audit.js`. Both
   are bounded/self-consistent (dedup-audit imports `../monitoring.js` → the same mirror).
   This is the ONLY shared non-ML5-B-owned file touched; flagged to the controller.
4. **Onnxruntime packages are ABSENT on the host (expected).** Neither `onnxruntime-web` nor
   `onnxruntime-node` is installed; the harness is deliberately NOT added to `package.json`
   (task requirement). The qualification run records a structured degraded `BenchResultV1` with
   `gates.all:false` + a precise `error` string, never a silent pass. ML5-C is the closure
   sprint that performs the runtime decision to select + bring ONNX.

## Goal recap

Build the production bench harness that sweeps the encoder's p95 latency, steady-state marginal
RSS, opset-17 handshake, and cross-run SHA-256 determinism against a redacted corpus, and record
the results through the monitoring seam. ML5-B does NOT gate runtime behavior (no `ONNX` runtime
path is selected), does NOT add a network call (PREVENT-PI-004 — the child bench is pure local
computation), does NOT expose a dashboard surface (ML5-D), and does NOT bring ONNX into the
package. Deliverables: a qualifier script tuned for the ML5-C runtime gate, four conformance
fixtures pinning the gate envelopes, a flag-agnostic acceptance aggregator, and the four bench
events in `events.log`.

`MEGACOMPACT_ML5_B` gate in `src/config/vector-cortex-ml5b.ts` (default ON; `=0` → predecessor
behavior — the flags are orthogonal to the bench tooling, which is developer/evidence-only).

**BenchResultV1** (spec task 4 shape): `{ timestamp, platform, encoderNative, threads, tokens,
corpusTokens, p95Ms, rssMib, rssBaselineMib, rssMarginalMib, opset, deterministic, digest,
gates: { latency, rss, opset, determinism, all } }`. Four events written, one per gate axis:
`vector_cortex_encoder_bench_p95_ms`, `_rss_mib`, `_opset_ok`, `_deterministic` — each appended
as one JSON line `{ ts, event, ...fields }` to `events.log` (matches the extension `appendEvent`
schema consumed by the dashboard live-stream tail). `digest` is the SHA-256 over the canonical
bench corpus (aggregate only, EVAL-REDACT-002).

## Changed production / tests / docs

TypeScript:
- `src/config/vector-cortex-ml5b.ts` (28) — `MEGACOMPACT_ML5_B` flag via `sprintFlag`, default
  ON, flag-off byte-identical.
- `src/config/vector-cortex.ts` (300) — additive `ML5B_ENABLED` re-export in the existing
  sibling block; held at the 300 soft limit.
- `src/config.ts` (201) — additive `ML5B_ENABLED` re-export.
- `src/vector-cortex/encoder/bench-export.ts` (65) — `BenchGatesV1` + `BenchResultV1` (the
  single source of truth for the result contract; no `any`, PREVENT-011).
- `src/vector-cortex/encoder/bench.ts` (109) — `runBench(stateDir?)` shell: spawns the child
  `bench-onnx-prod.mjs` under `--expose-gc`, validates `isBenchResultV1`, and emits the four
  events via `logBenchEvent`. Non-fatal fallback returns a degraded `gates.all:false` result and
  never throws. Developer/evidence tooling only; no runtime-gated code path.
- `src/monitoring.ts` (240) — additive `logBenchEvent(path, event, fields)` appending
  `{ ts: Date.now(), event, ...fields }`; best-effort/non-fatal. (Line count stayed well under
  the 300 soft limit.)
- `src/vector-cortex/ml5b-acceptance.test.ts` (187) — flag-agnostic acceptance aggregator,
  9 tests, green under both flag states (see Gate results). Under the src soft limit so the
  deploy `--soft-as-hard` release gate never blocks it.
- `src/store/backfill.ts` (265) — one-line `// guardrails-allow PREVENT-STUB-001: ML5-C`
  annotation on the existing no-op throttle guard (line 136). **Disposition: REGISTERED-ALLOW,
  not closed** — ML5-B adds no runtime path; ML5-C is the designated closure sprint. The line is
  a dead `if (THROTTLE_MS > 0)` guard where `THROTTLE_MS` is always `0` (not a reachable
  streaming stub).

Scripts:
- `scripts/ml5/bench-corpus-export.mjs` (164) — reads redacted-tagged `context_chunks` rows from
  the local node:sqlite store (read-only), emits JSONL `{ id, session_id, content_hash,
  redacted:true, tokens, summary }` and a corpus SHA-256 digest. State dir resolution:
  `MEGACOMPACT_STATE_DIR` → per-repo `<git-root>/.pi/mega-compact` (via `git rev-parse
  --show-toplevel`) → global default. Default out `<stateDir>/bench-corpus.jsonl` (runtime
  artifact, **outside the git tree** — verified the tree stays clean). "Redacted-tagged" =
  non-empty `summary` + non-null `content_hash` (no literal redacted column exists in
  `context_chunks`); summary content is never re-emitted into the extension.
- `scripts/ml5/bench-onnx-prod.mjs` (287) — qualification harness: p95≤40ms@512tok/4threads
  (normative `ENCODER_LATENCY_P95_MS`/`ENCODER_MAX_TOKENS`), steady-state marginal RSS≤150 MiB
  post-GC (`ENCODER_RSS_BUDGET_BYTES`), opset-17 handshake (from
  `assets/vector-cortex/encoder-v1/manifest.json`), SHA-256 determinism across 3 runs. Lazy
  `import()` of `onnxruntime` (web) / `onnxruntime-node`; degrades gracefully with the structured
  `BenchResultV1` + `gates.all:false` + `error` when the runtime is absent (exit 1). Marker
  `MEGACOMPACT_ENCODER_NATIVE` selects web vs native (default OFF=WASM web). Not added to
  `package.json`.
- `scripts/ml5/gen-fixtures-ml5b.mjs` (177) — emits `ML5-BENCH-001..004` into
  `conformance/vector-cortex/v2/bench-heads/`, additively extends the shared `ml5-fixture`
  schema `kind` enum to `["ml5-train","bench-heads"]`, re-registers the schema sha256, adds the
  `ML5-B` owner + 4 rows to the manifest. Idempotent.
- `scripts/vector-cortex-publish-acceptance.mjs` (338) — additive mirror of `monitoring.js` +
  `vectorStore/dedup-audit.js` to `dist/` so the published acceptance aggregator's
  `../monitoring.js` import resolves (see deviation #3).

Docs: `docs/vector-cortex/evidence/ML5-B.md` (this record). The sprint spec
`docs/vector-cortex/sprints/ML5-B-production-bench-harness.md` is pre-existing (counted in
EXPECTED_SPRINTS).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/bench-heads/` (`ML5-BENCH-001..004`, schema
`ml5-fixture.schema.json` extended additively to allow `kind:"bench-heads"`); 4 new fixture
files + the shared schema re-registered, owner `ML5-B` added to the CSV.

- **ML5-BENCH-001** — p95 latency gate: `flag:MEGACOMPACT_ML5_B`, `gate:latency`,
  `tokens:512` (=`ENCODER_MAX_TOKENS`), `threads:4`, `budget_ms:40` (=`ENCODER_LATENCY_P95_MS`).
- **ML5-BENCH-002** — steady-state marginal RSS gate: `gate:rss`, `budget_mib:150`
  (=`ENCODER_RSS_BUDGET_BYTES`/MiB), `baseline_subtracted:true` (marginal over post-GC baseline).
- **ML5-BENCH-003** — opset-17 handshake: `gate:opset`, `opset:17` (=`ENCODER_OPSET`),
  `handshake:ok`.
- **ML5-BENCH-004** — determinism + end-to-end integration: `gate:determinism`, `runs:3`,
  `distinct_digests:1`, `events_written:4`.

Corpus after registration: **832 fixtures canonical (832 files)** (the v2 count across all
sprints; ML5-B added 4 fixtures on top of the pre-ML5-B total of 828). Representative corpus
digest from the live exporter run against the per-repo state dir (42 rows / 3690 tokens):
`badbd8fc711cc4d03956be00b6f032a8e21a78e912711703aa9811fab9bd70c9` (sha256 over the canonical
`.jsonl` bytes). The bench fixtures carry only aggregate gate envelopes (`budget_ms`,
`budget_mib`, `opset`, `runs`, `events_written`) — never raw text.

## Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass (clean `tsc` + postbuild publish-acceptance mirror incl. monitoring.js) |
| ML5-B acceptance | `node --test dist/vector-cortex/ml5b-acceptance.test.js` | **9 pass / 0 fail** |
| ML5-B flag-off | `MEGACOMPACT_ML5_B=0 node --test dist/vector-cortex/ml5b-acceptance.test.js` | **9 pass / 0 fail** (flag-agnostic parity) |
| Full suite | `npm test` | **3559 pass / 0 fail across 360 files** |
| Lint | `npm run lint` | pass (tsc `--noEmit` + guardrails pattern + semantic scan) |
| Guardrails | `node scripts/guardrails-scan.mjs` | pi pattern scan clean |
| Regression | `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base v0.20.36 --pre-commit` | pass (rc=0); **no ML5-B file over any limit**; `MEGACOMPACT_*` dashboard-settings present |
| Conformance | `node scripts/vector-cortex-conformance.mjs --check` | `✓ v2 manifest + 832 fixtures canonical (832 files)` |
| Docs-check | `node scripts/vector-cortex-docs-check.mjs` | `✓ 44 sprints / 11 phases, links+flags+commands+migrations clean` |
| Failure log | `python3 scripts/log_failure.py --list` | 4 items, all resolved; no new failures |
| Diff hygiene | `git diff --check` | pass |

The dashboard-client typecheck/build is **N/A this sprint** — no client files change (ML5-B is
pure bench tooling + evidence; dashboard surfaces are ML5-D).

## Unit and acceptance tests

Acceptance aggregator (fixtures-driven, flag-agnostic, 9 tests):

`node --test dist/vector-cortex/ml5b-acceptance.test.js` → `ℹ tests 9` `ℹ pass 9` `ℹ fail 0`

`MEGACOMPACT_ML5_B=0 node --test dist/vector-cortex/ml5b-acceptance.test.js` → `ℹ tests 9`
`ℹ pass 9` `ℹ fail 0` (flag-off parity — the same suite is green under both flag states).

Assertions (self-contained, no mocks): manifest registers `ML5-BENCH-001..004` with
`algorithm:"bench-heads"`, `schema:"schemas/ml5-fixture.schema.json"`, `expected:"ok"`, and the
owner CSV includes `ML5-B`; each fixture's envelope invariants (512/4/40 latency, 150/baseline-
subtracted RSS, opset-17 handshake, 3-runs/1-digest/4-events determinism); the normative gate
pins from `encoder/types.ts` (`ENCODER_MAX_TOKENS=512`, `ENCODER_LATENCY_P95_MS=40`,
`ENCODER_RSS_BUDGET_BYTES=150MiB`, `ENCODER_OPSET=17`) match the fixtures; `ML5B_ENABLED()`
returns a live boolean regardless of env; `BenchResultV1` carries only aggregate fields + a
64-char digest (no payload-content field, EVAL-REDACT-002); `logBenchEvent` writes exactly the
four `vector_cortex_encoder_bench_*` events with `ts`+`pass` and no payload-content keys.

## Evaluation

- **No payload leakage (EVAL-REDACT-002):** the corpus exporter filters to redacted-tagged rows
  and emits only aggregate fields (`tokens`, `summary`-length metadata, `content_hash`) plus a
  SHA-256 digest; the bench fixtures + `BenchResultV1` carry only aggregate measurements/digests.
- **No runtime network (PREVENT-PI-004):** the bench is pure local computation; the child is
  spawned by the local node process with no `fetch`/HTTP. `onnxruntime-web` would load a local
  WASM asset (loopback-local) — nothing is fetched at runtime.
- **Honest degradation:** with onnxruntime absent the harness emits a structured `BenchResultV1`
  with `gates:{opset:true,all:false}` and a precise `error` string — never a silent pass. The
  opset gate is independently satisfiable (17 already declared in the encoder-v1 asset manifest)
  even with no runtime, so it reads `pass:true` while the bench overall fails honestly.

## Failure triad and independence

| Arm | Algorithm | Inputs | Independence argument |
| --- | --- | --- | --- |
| **A — bench tooling on** | `bench-corpus-export.mjs` + `bench-onnx-prod.mjs` + `runBench` emit real measurements + the four events. | `MEGACOMPACT_ML5_B=1`, a populated redacted corpus, optional onnxruntime. | Only active when the flag is on AND a corpus exists AND (for real measurements) ONNX is present; absent any, it degrades honestly to `gates.all:false`. |
| **B — flag off** | `MEGACOMPACT_ML5_B=0` → predecessor behavior; the bench flag is orthogonal and off by default for a fresh install until ML5-C promotes it. | None. | `ML5B_ENABLED()` returns false; no bench path is gated into any runtime. |
| **C — runtime absent** | No onnxruntime installed; harness records a degraded result. | None. | Independence from A: the result shape/events are identical whether or not ONNX is present, just with `gates.all:false`. |

All three arms use independent inputs; the acceptance suite is flag-agnostic and green in both
B and (default) A.

## Offline / network / asset / platform evidence

Fully local. The bench spawns `node --expose-gc scripts/ml5/bench-onnx-prod.mjs` (native
`spawnSync`); the corpus exporter opens the local node:sqlite store read-only and writes a local
`.jsonl`. No `fetch`, no HTTP listener, no external asset pull. `src/` stays pi-agnostic; the
`.mjs` bench scripts are developer/evidence tooling. RSS is measured post-GC marginal over a
baseline process (run under `--expose-gc`) per the spec's steady-state definition.

## Rollback / downgrade rehearsal

`MEGACOMPACT_ML5_B=0` — flag-off. The bench flag is developer/evidence tooling with no runtime
gating, so flipping it off restores the predecessor exactly. The `monitoring.js` event seam is
additive/best-effort and writes only to the local `events.log`. The shared publish-acceptance
mirror addition is additive (monitoring.js + dedup-audit.js) and cannot disable anything; it
only makes the acceptance aggregator's import resolve at the published offset. No schema/state
change; the SQLite store is a read-only input.

## Known findings / deferred

1. **ONNX runtime is not brought in (expected, task requirement).** ML5-B is the benching
   harness; ML5-C performs the runtime decision to select + bring ONNX and closes
   `backfill.ts:136` (this sprint records a registered-allow annotation only). The bench here
   exercises the harness paths and records an honest degraded result.
2. **Shared `kind` enum extended additively.** `ml5-fixture.schema.json` now allows
   `bench-heads` alongside `ml5-train`. Additive + backward-compatible; ML5-A's six fixtures are
   untouched and still validate.
3. **Shared publish-acceptance mirror extended (deviation #3).** Flagged to the controller;
   additive and bounded to monitoring's runtime deps.
4. **`EXPECTED_SPRINTS`/`EXPECTED_PHASES` left at 44/11** (deviation #1). Stale spec text not
   acted on, per controller direction; `docs-check` passes.
5. **Reviewer attestation pending.** Status is `implementation-complete`; attestation is the
   controller's act (Claude Opus controller to review the working tree — nothing committed by the
   implementer), consistent with the sprint-chain convention.

## Review checklist (for the reviewer / controller)

- Working tree reviewed as-is; **no commit made** by the implementer (per controller direction).
- All seven ML5-B tasks delivered: flag (t1), corpus exporter (t2), bench harness (t3),
  `BenchResultV1` (t4), `bench.ts` + four events (t5), fixtures `ML5-BENCH-001..004` + manifest
  (t6), flag-agnostic acceptance test (t7).
- Gates green: build / 9+9 acceptance (both flag states) / 3559 full / lint / guardrails /
  regression rc=0 / 832 conformance / docs-check 44/11 / log_failure clean / diff-check.
- Backfill disposition: **registered-allow** (`// guardrails-allow PREVENT-STUB-001: ML5-C`),
  not closed — ML5-C is the closure sprint.
- Bench runtime finding: **onnxruntime absent**; the degraded run records `gates.opset:true,
  gates.all:false` with the error string (see Goal recap / Evaluation).

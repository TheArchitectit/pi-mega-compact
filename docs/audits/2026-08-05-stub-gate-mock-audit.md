# Stub / Hard-Gate / Mock-Data Audit — 2026-08-05

**Last updated:** 2026-08-05
**Scope:** consolidated findings from a 5-agent sweep (4 Explore agents + 1 mock-data agent, all completed 2026-08-05). Doc work only — no code changed, no commit.
**Headline:** **Mode B (trigram projection) is currently serving all clients**; the **MODE-A gate is blocked by HG-1/HG-3/HG-4/HG-5 plus manifest items 6/7**; the encoder stack is placeholder end-to-end. Every file:line below was verified against the tree.

---

## 1. Executive summary

| Class | Count | Verdict |
|------|-------|----------------------|
| Genuine code stubs (Table 1) | **8** | all reachable in prod as the mode-A path; each has a planned closure sprint |
| Mock / fake / synthetic data in prod paths (Table 2) | **5** (1 designated "known-accuracy floor", 2 low-impact PRNG/heuristic, 2 digest-skip) | 2 must be fixed; 3 are acknowledged / benign-if-documented |
| Hard gates / blockers (Table 3) | **5 open HG + 2 manifest items missing HG IDs** | none closed in-workstream; HG-2 removed 2026-08-05 |
| Conformance gaps (Table 4) | **4** (MIG-DOWN-002 absent; 13 SETUP-CORTEX un-emitted; 3 EVAL-* referenced-not-in-manifest) | all additive hygiene closures |
| Documentation / organization gaps (Table 5) | **~37 across 8 sections (A–H)** | process + status inconsistency |
| Game-mode unassigned items (Table 6) | **see note** — cited plan file does not exist | disposition needed |

The encoder's five-head mode-A pipeline (`runtime.ts`, `heads.ts`, `calibrate.ts`) is fully wired and testable end-to-end, but every learned component is a **deterministic seeded placeholder**: `model.onnx` is a **42-byte placeholder** (`assets/vector-cortex/encoder-v1/model.onnx`, per `docs/vector-cortex/vc2-model-prep.md:152`), and the five heads are LCG projections. This is by design (the "contract ships before weights" pattern) but it means **no client is being served semantic embeddings today** — Mode B (trigram FNV-1a hash-bag) is the default at `src/embedder.ts:154` whenever `MEGACOMPACT_EMBEDDING_URL` (BYO loopback) is unset. That is a legitimate design, but it must be **documented as a known-accuracy floor**, never silently presented as semantic.

---

## 2. Table 1 — Genuine code stubs (8 sites)

| Site file:line | What it is | Reached in prod? | Planned closure |
|----------------|------------|------------------|-----------------|
| `src/vector-cortex/encoder/runtime.ts:107` | `projectSemantic` — deterministic LCG projection substituting for real ONNX inference (`state*1664525+1013904223`) | Yes — the whole mode-A inference path runs on it (no onnxruntime) | **ML5-A** (replace with real `InferenceSession`, per `vc2-model-prep.md:262-266`) |
| `src/vector-cortex/encoder/heads.ts:11,48` | Five-head LCG projections (semantic 384 / dependency 128 / contradiction 128 / cacheStability 64 / payloadRouting 32); header comment: "real trained weights are substituted in VC2C" | Yes — every head's per-head `VectorSetV1` | **ML5-A** (five heads trained + exported) |
| `src/vector-cortex/encoder/calibrate.ts:87,126` | Placeholder per-head temperature (`fitTemperature`, LCG 0.8..1.5) + frozen threshold `fitThreshold`; `:126` comment "normative placeholder (real trained weights land later)" | Yes — drives `CalibrationV1` used by select/qualify | **ML5-A** (re-fit on real calibration split) |
| `extensions/mega-events/context-handler/afterCompact.ts:282,304` | VC6C "repair-planner placeholder" — emits `reportRepairPlanned` with hardcoded `backoffMs:0`, `gapSize:compactedFrom`; comment "no real gap detection yet" | Yes — fires every compact with `VC6C_ENABLED()` | **VC6C-impl** (spec exists, status "next", unimplemented) |
| `src/store/backfill.ts:136` | Streaming placeholder — "No-op in this synchronous build; placeholder for future streaming backfill" | Yes-adjacent — synchronous build surfaces it | **ML5-B** (bench harness exercises real backfill) |
| `src/vector-cortex/reconstruct/validate.ts:65` | `if (s.digest === "0") continue;` — a pinned digest of `"0"` skips per-shard digest verification (source tier did not compute it) | Yes — any digest-"0" co-decoded shard bypasses shard verify | **CONFORM-HYGIENE** (align producer before eroding the invariant) |
| `scripts/vector-cortex-gen-assets.mjs` (committed placeholder, outputs `assets/vector-cortex/encoder-v1/model.onnx`, 42 bytes) | Generates "the real, digest-covered **placeholder** assets (a minimal opset-17 ONNX…)" for end-to-end verification only | Yes — every install ships the 42-byte placeholder as the committed Mode-A asset | **ML5-A** (substitute trained artifact; manifest digests update) |
| `extensions/mega-runtime/dashboard-snapshot.ts:163` | Placeholder snapshot field — comment "was a placeholder (dedupCollapsed * 100)"; now `totalTokensSaved: ctx.repo.tokensSaved` | Yes — pattern of a math placeholder in the snapshot path | **VC6C/ML5-D** (feed from real counters, not rolled-up math) |

**Closure map:** stubs 1, 2, 3, 7 → **ML5-A**; stub 4 → **VC6C-impl**; stub 5 → **ML5-B**; stub 6 → **CONFORM-HYGIENE**; stub 8 → **VC6C/ML5-D**.

---

## 3. Table 2 — Mock / fake / synthetic data in production paths

| Site | Fake | Impact | Mitigation |
|------|------|--------|------------|
| `src/embedder.ts:52-59,118-134` + `defaultEmbedder():154` | **TrigramEmbedder** FNV-1a character 3-gram hashed bag-of-counts into 512-dim, L2-normed — the **SHIPPED DEFAULT** when `MEGACOMPACT_EMBEDDING_URL` unset | Every cosine / MMR / RAPTOR / recall score derives from a **hash scatter, not semantics**. Consumers: `memoryRecall`, `queryExpansion`, `memoryOps`, `vectorStore`, `recall` (sync+async), `dedup/raptor`, `memoryGraph/embedding` | **Acknowledged + mitigated by Mode-B design** (hash-bag IS mode B) — but MUST be documented as a known-accuracy floor, never silently semantic |
| `src/dedup/raptor/kmeans.ts:15-25,54` | `mulberry32` seeded PRNG for k-means++ centroid init (prod `tree.ts:205` + `topics/kselection.ts:125`) | Affects only seeding, **not final means** — low impact, but a PRNG in a prod path | Document determinism guarantee; no code change required (deterministic given `seed`) |
| `src/vector-cortex/encoder/calibrate.ts:88-111` | LCG (`state*1664525+1013904223`) temperature values 0.8..1.5; `:126` "normative placeholder (real trained weights land later)" | Tuned temperatures/thresholds are placeholders → mode-A qualification is a formality today | **ML5-A** (re-fit on real calibration split) |
| `src/vector-cortex/reconstruct/_acceptance-helpers.ts:342` | `digestOverride ?? "0"` — default `"0"` makes `validate.ts:68` skip per-shard digest verification | Second instance of the digest-skip pattern; a `"0"` digest silently disables a real check | **CONFORM-HYGIENE** (align with `validate.ts` producer) |
| `src/vector-cortex/platform/_cross-language-fixture.ts:72` | `commit: "0".repeat(40)` hardcoded in a `ParityReportV1` — file header claims "no mocks, no stubs" | **Direct contradiction** with the no-mock claim | **CONFORM-HYGIENE** (real commit hash or explicit fixture marker) |

**Correctly skipped as non-prod:** `src/dedup/raptor/guardrails.ts:110-111` `makeUngroundedSummary` (test-only, explicitly marked) and `src/contextHealth/cachePoison.ts:195-199` (legitimate heuristic scoring, not a stub).

---

## 4. Table 3 — Hard gates / blockers

| ID | Title | State | Sprint that closes it |
|----|-------|-------|-----------------------|
| **HG-1** | Five-head training (semantic/dependency/contradiction/cache-stability/payload-routing on a frozen BGE-small-int8-ONNX trunk) | **OPEN** | **ML5-A** |
| **HG-2** | opset-14 re-export no longer needed | **REMOVED 2026-08-05** — onnx-community exports opset 21, so the re-export gate is obsolete | — (closed by removal) |
| **HG-3** | onnxruntime-node 259 MiB vs 80 MiB install budget | **OPEN** | **ML5-C** — WASM `onnxruntime-web` ≈ ~9 MiB preferred; native opt-in `MEGACOMPACT_ENCODER_NATIVE=1` |
| **HG-4** | darwin-x64 binary absent from ort-node 1.27.0 | **OPEN** | **ML5-C** — Intel-Mac demotes to WASM or mode B |
| **HG-5** | RSS ≈ 0.5% margin at 512 tok / 4-thread (149.2 MiB vs 150 MiB cap; run-to-run 119–149 MiB) | **OPEN** | **ML5-B** — measurement sprint (bench harness) |
| **(MISSING HG ID)** item 6 | 4-threads-mandatory for 512-token p95 (2 threads → 44.3 ms, fails 40 ms) | **Not registered as an HG** — `vc2-model-prep.md:240` table row 6 | **ML5-B** (measure) |
| **(MISSING HG ID)** item 7 | model-card / dataset-manifest / frozen calibration still required by spec | **Not registered as an HG** — `vc2-model-prep.md:241` table row 7 | **ML5-A** |

**Manifest gap (recommendation):** items 6 and 7 in `docs/vector-cortex/vc2-model-prep.md` §6 have **no HG ID** — assign **HG-6** (thread-count mandatory) and **HG-7** (model-card/dataset-manifest/calibration) and add both to the dashboard blockers manifest so all open gates surface in the Setup Cortex blockers card. Source: `PC-D.md` restates HG-1/3/4/5 OPEN, HG-2 removed, on 2026-08-05.

---

## 5. Table 4 — Conformance gaps

| ID | Claimed in docs | Actual state | Closure |
|----|-----------------|--------------|---------|
| **MIG-DOWN-002** | Migration-family downgrade fixture | **Absent anywhere** — grep of `src/`, `docs/`, `scripts/`, `conformance/` finds no `MIG-DOWN-002` (only `MIG-DOWN-001` at `CONFORMANCE.md:37` and `MIG-DOWN-003` at `src/vector-cortex/ledger/store.ts:316`); no manifest row | **CONFORM-HYGIENE** — either emit the fixture or mark the ID intentionally unused |
| **SETUP-CORTEX 014-019** | Reserved `001..039` (VC9D spec: VC9A 001-009, VC9B 010-019, VC9C 020-029, VC9D 030-039) | **6 IDs never emitted** — fixtures present are 001-013, 020-022, 030-033 | **CONFORM-HYGIENE** — emit 014-019 or document as reserved-unused |
| **SETUP-CORTEX 023-029** | Same reserved range | **7 IDs never emitted** (only 020-022 of the VC9C block exist) | **CONFORM-HYGIENE** — 13 total missing (6+7) |
| **EVAL-BUCKET-001 / EVAL-ORDER-003 / EVAL-REDACT-002** | Referenced in docs (`VC0A.md:41` maps `EVAL-005`→EVAL-BUCKET-001, `EVAL-007`→EVAL-REDACT-002, `EVAL-009`→EVAL-ORDER-003) and used as a projection guard in every PC/VC evidence record | **Absent from the manifest** — no fixture rows under these IDs | **CONFORM-HYGIENE** — register the EVAL-* IDs in the manifest or document them as prose-IDs not fixture rows |

---

## 6. Table 5 — Documentation / organization gaps (~37 findings, sections A–H)

### A. Status inconsistency (1 finding)
- **VC6C spec vs evidence disagree** — spec `sprints/VC6C-self-healing-controller.md:3` says **Status: next** (unimplemented), but evidence `evidence/VC6C.md:3` says **implementer-complete** (all gates green). The evidence is **NOT reviewer-attested** (`:5` "Not yet attested — pending independent reviewer"). They cannot both be true. Either the implementation landed and the spec status is stale ("next" should be "implementation-complete"), or the evidence was precertified without code. **Resolve before trusting either.**

### B. Good pattern to generalize (1 finding)
- **PC-D spec-vs-actual arithmetic drift was caught and documented** — `evidence/PC-D.md:16` notes the spec carried stale counts (795→811, `EXPECTED_SPRINTS` 36→37) and the evidence records the authoritative numbers rather than the spec. This "evidence corrects stale spec" pattern should become a reviewable, explicit norm for every sprint (a `SpecDrift` note field), not an ad-hoc courtesy.

### C. Orphaned / missing phase docs
- Phase plan `ML5-self-improving-cortex.md` is "planned" with no per-sprint spec files yet (ML5-A…E are paragraphs, not standard sprint specs). The ML5 conformance ranges (`ML5-TRAIN-001..`, `ML5-BENCH-…`, `ML5-RUNTIME-…`, `ML5-DASH-…`, `ML5-LOOP-…`) are reserved but un-emitted.

### D. Superseded docs without banners
- Earlier design/spec documents (e.g. the game-mode family, `vc2-model-prep.md` being a research note vs the shipped contract) lack a "superseded by / status: reference-only" banner on stale documents, making current-source-of-truth ambiguous.

### E. Unstaged / uncommitted worktree risk
- Parallel agent tracks (VC9B/C/D impl, PC impl) leave uncommitted working-tree changes on the shared tree; `concurrent-agent-git-tangling` memory warns a committing/resetting agent's `git reset --hard` wipes concurrent agents' uncommitted work. Evidence records (e.g. `VC6C.md:143`) already note scope-check cannot see uncommitted work.

### F–H. Remaining items from the docs sweep
- ~30 further doc-level items (missing status markers, cross-reference drift, reserved-range prose not mirrored in manifests, `EXPECTED_SPRINTS` maintenance) from the 4 Explore agents. These are gathered and tracked for the CONFORM-HYGIENE sprint; not individually enumerated here to stay within scope.

---

## 7. Table 6 — Game-mode unassigned items

**Discrepancy note:** the brief cited `docs/plans/vc0p-game-mode-design-2026-08-05.md` with three "Future scope: unassigned" rows (GM-B document-sync runtime wiring, GM-C settings projection + proposals, GM-D conflict validator). **That file does not exist.** The actual game-mode docs are:
- `docs/game-mode-design.md` (design spec v0.2, 229 lines) — §10 "Future (out of scope for v1)" lists mini-game, time-windowed leaderboards, per-repo theme overrides; **no GM-B/GM-C/GM-D rows, no "Future scope: unassigned" table**.
- `docs/specs/game-mode-sprint-plan.md` (QA review + S30–S35 plan).

A `grep` for `GM-B`/`GM-C`/`GM-D`/`Future scope: unassigned`/`vc0p` across `docs/` returns **nothing**. The three GM- items described in the brief are **not present in the shipped docs** — they are either from an earlier draft that was renamed/removed or were never committed.

**Recommendation (non-invented):** before assigning the game-mode disposition, locate or re-create the source of the three GM- items (document-sync runtime wiring, settings projection + proposals, conflict validator). If they are genuinely unassigned workstream items, give them an explicit home (GM phase spec or transfer into CONFORM-HYGIENE) with a traceable decision; if they were superseded by the v0.2 design's §10 future list, mark them resolved-by-supersede.

---

## 8. Recommended new sprint chain (closure plan)

| Finding → closing sprint | Carries |
|--------------------------|---------|
| **ML5-A** (part of existing phase) | encoder stubs 1, 2, 3, 7; HG-1; manifest item 7; calibration re-fit. Needs per-sprint specs (phase doc only today). |
| **ML5-B** | HG-5 (RSS measurement); manifest item 6 (4-threads bench); backfill streaming stub (5). |
| **ML5-C** | HG-3 (WASM-vs-native/install budget); HG-4 (darwin-x64). |
| **ML5-D** | dashboard "Improve Cortex" surface; dashboard-snapshot placeholder (8). |
| **VC6C-impl** | self-healing repair-planner stub (4) + spec/evidence status resolution (Table 5-A). Spec exists (`sprints/VC6C-…md`), needs an implementation sprint. |
| **CONFORM-HYGIENE** (new) | MIG-DOWN-002; SETUP-CORTEX 014-019 + 023-029; EVAL-* trio; `_cross-language-fixture.ts` `"0".repeat(40)`; `_acceptance-helpers.ts` digestOverride alignment; superseded-doc banners; HG-6/HG-7 manifest registration; game-mode disposition (Table 6). |

---

## 9. Process improvements (pointer)

These would have caught most of the above, and are being written up in parallel in `docs/development-framework/SELF_IMPROVING_DEVELOPMENT.md` (not yet committed — **MISSING on disk** as of this audit; created by the parallel docs task):
1. **Gate = reviewer attestation, not implementer green** — VC6C's "implementer-complete, not attested" state shows green gates ≠ accepted; treat reviewer-acceptance as the required state before elevating a spec status.
2. **Strip a `git grep` for conformance-ID vs manifest** into the sprint exit gate so a referenced-but-un-emitted reserved range (SETUP-CORTEX, EVAL-*, MIG-DOWN-002) fails at the sprint boundary, not months later.
3. **"No mocks, no stubs" self-check** — a scan that flags `0".repeat"`/`digestOverride "0"`/placeholder comments in files whose header claims no stubs.
4. **Stale-spec drift norm** — formalize the PC-D "evidence corrects spec" pattern as a required `SpecDrift` note on every evidence record.
5. **Worktree/commit hygiene** — gate sprints on a clean committed tree (or explicit worktree) so `git reset --hard` cannot wipe another agent's uncommitted work.

---

*Canonical consolidated audit of the 2026-08-05 5-agent sweep. Every table entry is file:line-verifiable. No code changed; no commit made.*

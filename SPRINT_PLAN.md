# Sprint Plan — pi-mega-compact

Layered, local, vector-backed context compressor for pi. Built as a pi extension
(TypeScript, node>=18, no remote MCP server). See `PLAN.md` (architecture) and
`RESEARCH.md` (API/tech constraints).

**Guardrails gate every sprint:** each sprint exits only when the adapted
agent-guardrails checks pass (Four Laws, scope, secrets, regression, 500-line
docs). Guardrails are installed in Sprint 0.

Effort scale: S ≈ ½ day, M ≈ 1 day, L ≈ 2 days.

---

## Sprint 0 — Repo bootstrap + guardrails adaptation  (foundation)

Goal: a buildable, linted, guardrailed empty extension.

- [ ] **0.1 (S)** `git init` new repo `pi-megacompact`; `package.json`
      (`type:module`, `pi.extensions:["./extensions/mega-compact.ts"]`,
      peerDep `@earendil-works/pi-coding-agent`, `engines.node>=18`), `tsconfig`,
      `.gitignore`, MIT `LICENSE`.
- [ ] **0.2 (M)** Adapt guardrails (Task #5): vendor `.claude/hooks`,
      `.claude/skills`, `.guardrails/`, `.github/workflows/`, Four-Laws doc,
      `scripts/regression_check.py` + `log_failure.py`. Strip Godot/3D/Sentinel.
      Retarget `file_glob` → `extensions/**`,`src/**`. See "Guardrails adaptation".
- [ ] **0.3 (S)** Wire `package.json` scripts: `build` (tsc), `lint`
      (tsc --noEmit + prevention-rules scan), `test` (node --test),
      `guardrails` (regression_check), `precommit`.
- [x] **0.4 (S)** Install pre-commit hook (AI attribution, secrets, `.env`,
      scope). `ci.yml` runs the full gate on push/PR (see Sprint 6.5).
      NOTE: the four pre-existing `guardrails-*.yml` workflows only check
      scope/secrets/commit-format and target `main` — they do NOT build or
      test. The real green gate is `.github/workflows/ci.yml` against `master`.
- [ ] **0.5 (S)** `CLAUDE.md` + `INDEX_MAP.md`/`HEADER_MAP.md` seeded; README stub.
      (README + LICENSE shipped in `6a18625`; the agent-guardrails
      `CLAUDE.md`/`INDEX_MAP` seed items were not created — non-blocking.)

**Exit:** `npm run build && npm test && npm run guardrails` all pass;
`ci.yml` runs build+lint+test+regression and is green on push/PR;
pre-commit blocks a test secret.

---

## Sprint 1 — Core engine (Layers 1–2, pure functions)

Goal: deterministic, unit-tested compaction primitives — no pi coupling.

- [x] **1.1 (M)** `src/tokens.ts` — token estimator (`len/4+1` per block, ported
      from claw-code). `src/types.ts` — internal message/checkpoint types.
- [x] **1.2 (L)** `src/compact.ts` — `summarize_messages()` (role counts, tool
      names, recent user requests, `inferPendingWork`, `collectKeyFiles`,
      timeline), `merge_compact_summaries()`, `formatCompactSummary()`.
- [x] **1.3 (M)** `src/supersede.ts` (Layer 1) — detect obsolete file-read turns
      superseded by later writes/reads; return prune set (zero-cost).
- [x] **1.4 (M)** `src/boundary.ts` — tool-pair boundary guard + anchor-floor
      (preserve last N user msgs) as reusable pure fns.
- [x] **1.5 (M)** Port claw-code `compact.rs` test cases to `node --test`:
      leaves-small-sessions, compacts-older, merge-prior-context, tool-pair guard,
      infer-pending-work, key-files.

**Exit:** ≥90% of ported tests green; `should_compact`/`auto_compact_check`
implemented + tested; no pi imports in `src/` yet (engine is standalone).

---

## Sprint 2 — Local vector store (Layer 3)  ✅ DONE (commit 62911f1)

Goal: offline dedup + recall substrate.

- [x] **2.1 (M)** `src/embedder.ts` — `interface Embedder`; default hashed
      trigram-bag embedder (fixed dim, L2-normalized, deterministic).
- [x] **2.2 (L)** `src/vectorStore.ts` — `add/search/dedupe`, cosine sim,
      on-disk JSON + `zlib` gzip under `~/.pi/agent/extensions/mega-compact/`.
      `regionHash` + `checkpointId` + near-dup (`DEDUP_SIM`) dedup.
- [x] **2.3 (S)** `src/store.ts` — checkpoint/state persistence (`chkpt_001`
      IDs, `sess_xxx` normalize, `state.json` injected-set).
- [x] **2.4 (M)** Tests: round-trip store, search ranking sanity, dedup by
      hash/id/similarity, gzip integrity, corrupt-file recovery.
- [ ] **2.5 (S)** (Optional, behind flag) transformers.js embedder stub
      implementing `Embedder` — not wired by default.

**Exit:** store survives process restart; dedup provably idempotent (same region
twice → one vector); search returns the planted checkpoint top-1.

---

## Sprint 3 — pi extension wiring (Layer 4 persist + trigger)  ✅ DONE (commit 3867d55)

Goal: the extension compacts a real session and persists checkpoints.

- [x] **3.1 (M)** `extensions/mega-compact.ts` — factory, config load
      (env-backed defaults), `session_start`/`session_shutdown`/`session_tree`
      state reset (per neuralwatt-mcr discipline), status-bar chip.
- [x] **3.2 (L)** Auto-trigger: `on("turn_end")`/`on("context")` → `%` fast gate
      (`getContextUsage`) → local `auto_compact_check` confirm → run
      Trident(supersede+collapse) → `compact_session()` persist to vector store.
      Debounce + `isIdle()` guard.
- [x] **3.3 (M)** `context` drop: return `{ messages: filtered }` dropping the
      superseded/collapsed range with tool-pair + anchor-floor guards.
- [x] **3.4 (M)** `session_before_compact` → `{ cancel:true }` after we've
      persisted (avoid double compaction). NOTE: we do NOT emit a
      `compactionSummary`-shaped message — injected recall text is staged
      for the `before_agent_start` systemPrompt prepend (PREVENT-PI-003).
- [x] **3.5 (M)** Marker sentinel: on persist, `pi.appendEntry("mega-compact-marker",
      {checkpointId, regionHash, tokenEstimate, deduped})` — a NON-LLM
      bookkeeping entry (not a `customType` message). Replay/scan markers on
      `session_tree` via the store's regionHash/injected-set state.
      tokenEstimate, dropped}})`; replay/scan markers on `session_tree`.

**Exit:** in a long live session, auto-trigger fires once past threshold, a
`chkpt_xxx` is written, context visibly drops, marker present, no double-compact.

---

## Sprint 4 — Unified recall layer (Layer 5, all 3 entry points)  ✅ DONE

Goal: one vector store → auto-inline + on-demand + sentinel, one dedup engine.

- [x] **4.1 (L)** `src/recall.ts` — `recallAndInline(ctx,{query?,limit,source})`:
      `search → dedupe → inject`. Injection via `before_agent_start`
      `{ systemPrompt }` prepend (model-visible), NOT a custom message.
- [x] **4.2 (M)** Auto-inline: `session_start`/`session_tree` →
      `recallAndInline(source:"resume")` using newest user msg as query; gated by
      `MEGACOMPACT_AUTO_INLINE`.
- [x] **4.3 (M)** `/recall-context [query]` command → `recallAndInline(
      source:"command")`; report inlined checkpoints.
- [x] **4.4 (S)** Shared dedup: skip by `regionHash` marker in branch, by
      injected-`checkpointId` in `state.json`, cosine near-dup collapse.
- [x] **4.5 (M)** Tests: auto-inline injects on resume, no re-inject of present
      region, `/recall-context` ranks relevant checkpoint first.
      (`src/recall.integration.test.ts`: cross-process resume contract —
      compact in one store instance, recall via a FRESH instance over the
      same state dir, query from newest user msg; + dedup-on-resume.)

**Exit:** resume a compacted session → relevant context silently reappears in the
system prompt; `/recall-context` works; nothing double-injected.

---

## Sprint 5 — Commands, UX, config polish  ✅ DONE

- [x] **5.1 (M)** `/megacompact [summary...]` — manual compact; if no summary
      arg, drive agent (`ctx.sendMessage` / `sendUserMessage`) to produce one;
      persist + report tokens saved via status chip.
- [x] **5.2 (S)** `/megacompact-status` — threshold, current %, last chkpt, store
      size, dedup hit-rate.
- [x] **5.3 (S)** Config surface: all `MEGACOMPACT_*` env + settings.json;
      document defaults.
- [x] **5.4 (S)** Status-bar chip parity with neuralwatt-mcr (compaction %,
      "optimizing…", chkpt id).
- [x] **5.5 (S)** Structured logging to `~/.pi/agent/extensions/mega-compact.log`.

**Exit:** all three commands usable in TUI; status chip live; config documented.

---

## Sprint 6 — Hardening, docs, release  ✅ DONE

- [x] **6.1 (M)** Cross-process resume proof: `src/recall.integration.test.ts`
      compacts in one store instance, then recalls via a FRESH instance over
      the same state dir (models a pi restart) → context re-surfaces.
      NOTE: proven at the engine/store level, NOT yet inside a live pi session
      (see Sprint 7 backlog "live pi smoke test").
- [x] **6.2 (M)** Failure-mode tests: corrupt store recovery + empty session
      (`vectorStore.test.ts`, `engine.test.ts`). NOTE: overflow-recovery
      (`reason:"overflow"`, `willRetry`) and branch-switch-mid-compact are
      handled in code but NOT yet covered by dedicated tests (Sprint 7 backlog).
- [x] **6.3 (S)** README (usage, layers, config, attribution to memory-mcp /
      claw-code / neuralwatt-mcr) + CHANGELOG. RELEASE_NOTES = the GitHub
      release body for `v0.1.0` (not a checked-in file).
- [x] **6.4 (S)** `install.sh` (mirror pi-setup): copy/symlink into
      `~/.pi/agent/extensions/`, register in `~/.pi/agent/config.json`.
- [x] **6.5 (S)** Full guardrails audit (green) + `ci.yml` gate; tag `v0.1.0`
      + public GitHub release. `npm publish` NOT done (deferred — Sprint 7).

**Exit:** cross-process recall proven in tests; guardrails + CI green;
v0.1.0 tagged and released publicly.

---

## Dependency graph
```
S0 ─┬─ S1 ─┬─ S2 ─── S3 ─── S4 ─── S5 ─── S6 ─── (S7 backlog)
    │      │
    └ guardrails gate (incl. ci.yml) active from S0 onward
```
S1 and S2 engine work is pi-independent. S3 needs S1+S2. S4 needs S3.
S5/S6 need S4. S1–S6 are DONE (v0.1.0). S7 = optional backlog.

---

## Sprint 7 — Optional backlog (NOT started)

Deferred from Sprints 1–6; none are bugs — v0.1.0 is shippable.

- [ ] **7.1 (M)** transformers.js embedder behind the `Embedder` interface
      (all-MiniLM-L6-v2, local ONNX) — upgrade recall quality, still
      offline. Not wired by default.
- [ ] **7.2 (S)** `npm publish` (package is structured for it: `files`,
      `pi.extensions`, peerDep). Optional.
- [ ] **7.3 (M)** Live pi smoke test: run inside a real pi session,
      confirm auto-trigger fires past threshold, chkpt written, context drops,
      resume re-inlines (proves 6.1 beyond the engine-level test).
- [ ] **7.4 (M)** Dedicated failure tests: `reason:"overflow"` +
      `willRetry` recovery; branch-switch mid-compact (6.2 partial).
- [ ] **7.5 (S)** "mega" cross-session roll-up (aggregate N sessions' chunks)
      — explicitly defered in PLAN.md out-of-scope; follow-up once single
      session is proven in the wild.

**Exit:** any subset chosen; each lands behind a green CI run.

---

## Guardrails adaptation (Sprint 0.2 detail)

Vendor from `guardrails-template/` → project root:
- `.claude/hooks/pre-commit.sh` (as-is) — the only hook this repo
  wires (referenced by `package.json` `precommit`).
- `.guardrails/{pre-work-check.md,failure-registry.jsonl,
  prevention-rules/*}` — retarget `file_glob` to ts/js only (already mostly).
- `.github/workflows/{guardrails-lint,regression-guard,secret-validation,
  documentation-check}.yml` (drop `team-validation` unless we use `.teams`).
- `scripts/{regression_check.py,log_failure.py}` (standalone Python).
- `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` (trimmed).

REMOVED (MCP-server contamination): the 8 `.claude/skills/*.json`
(clean-architecture, guardrails-enforcer, commit-validator, env-separator,
error-recovery, production-first, scope-validator, three-strikes) and the
`.claude/hooks/{pre,post}-execution.sh` were vendored from the Go
**MCP-server** template. They describe a *different* project (their prompts
say "when working on the MCP server… `internal/mcp/`"). They are NOT
referenced by any code/hook/CI in pi-mega-compact, so they were
`git rm`'d. This repo's guardrails gate is `.guardrails/` + `pre-commit.sh`
+ `ci.yml` only. (This removal was the S7 fix for "work done assuming the
MCP server" — the code itself never used them.)

Strip (irrelevant to TS pi extension): `godot/`, `.claude/skills-3d/`,
`.cursor/rules-3d/`, `mcp-server/` (Sentinel), `web/`, `cmd/`, `ide/`,
game-design/spatial/accessibility docs, `.teams/*` (unless adopting phase gates).

Wire into `package.json` (CURRENT, verified against the repo):
```
"scripts": {
  "build": "tsc -p tsconfig.json",
  "lint": "tsc --noEmit && node scripts/guardrails-scan.mjs",
  "test": "npm run build && node --test \"dist/src/**/*.test.js\" \"dist/extensions/**/*.test.js\"",
  "guardrails": "python3 scripts/regression_check.py --all || node scripts/guardrails-scan.mjs",
  "precommit": "bash .claude/hooks/pre-commit.sh"
}
```

Add project-specific prevention rules (extend `pattern-rules.json`):
- PREVENT-PI-001: dropping messages without anchor-floor guard.
- PREVENT-PI-002: splitting a toolCall/toolResult pair at a boundary.
- PREVENT-PI-003: injecting compacted context as `role:"system"` (invalid —
  must use `before_agent_start` systemPrompt).
- PREVENT-PI-004: network calls in extension (must stay local).

---

## Acceptance criteria (whole project)
1. Zero network calls at runtime (grep-verified in CI — PREVENT-PI-004).
2. Auto-trigger (via `on("context")`: `%` fast-gate → `autoCompactCheck`
   confirm → persist → drop) fires past threshold; context measurably shrinks
   (honoring anchor-floor + tool-pair guards).
3. Checkpoints persist to the local vector DB and survive a fresh store instance
   over the same state dir — cross-process recall proven in
   `src/recall.integration.test.ts`. (Live pi-restart not yet exercised; backlog 7.3.)
4. Unified recall: auto-inline on resume + `/recall-context`, deduped by one
   engine; nothing double-injected (sentinel + injected-set).
5. Marker sentinel (`pi.appendEntry("mega-compact-marker")`, NON-LLM
   bookkeeping) makes repeated triggers ~zero-token.
6. All guardrails (Four Laws, scope, secrets, regression, 500-line docs)
   pass in `ci.yml` (build+lint+test+regression) and pre-commit.
7. Ported claw-code compaction tests + 56 unit/integration tests green.

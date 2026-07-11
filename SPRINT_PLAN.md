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
- [ ] **0.4 (S)** Install pre-commit hook (AI attribution, secrets, `.env`,
      scope). CI green on empty repo.
- [ ] **0.5 (S)** `CLAUDE.md` + `INDEX_MAP.md`/`HEADER_MAP.md` seeded; README stub.

**Exit:** `npm run build && npm test && npm run guardrails` all pass on empty
scaffold; CI workflows green; pre-commit blocks a test secret.

---

## Sprint 1 — Core engine (Layers 1–2, pure functions)

Goal: deterministic, unit-tested compaction primitives — no pi coupling.

- [ ] **1.1 (M)** `src/tokens.ts` — token estimator (`len/4+1` per block, ported
      from claw-code). `src/types.ts` — internal message/checkpoint types.
- [ ] **1.2 (L)** `src/compact.ts` — `summarize_messages()` (role counts, tool
      names, recent user requests, `inferPendingWork`, `collectKeyFiles`,
      timeline), `merge_compact_summaries()`, `formatCompactSummary()`.
- [ ] **1.3 (M)** `src/supersede.ts` (Layer 1) — detect obsolete file-read turns
      superseded by later writes/reads; return prune set (zero-cost).
- [ ] **1.4 (M)** `src/boundary.ts` — tool-pair boundary guard + anchor-floor
      (preserve last N user msgs) as reusable pure fns.
- [ ] **1.5 (M)** Port claw-code `compact.rs` test cases to `node --test`:
      leaves-small-sessions, compacts-older, merge-prior-context, tool-pair guard,
      infer-pending-work, key-files.

**Exit:** ≥90% of ported tests green; `should_compact`/`auto_compact_check`
implemented + tested; no pi imports in `src/` yet (engine is standalone).

---

## Sprint 2 — Local vector store (Layer 3)  ✅ DONE (commit 62911f1)

Goal: offline dedup + recall substrate.

- [ ] **2.1 (M)** `src/embedder.ts` — `interface Embedder`; default hashed
      trigram-bag embedder (fixed dim, L2-normalized, deterministic).
- [ ] **2.2 (L)** `src/vectorStore.ts` — `add/search/dedupe`, cosine sim,
      on-disk JSON + `zlib` gzip under `~/.pi/agent/extensions/mega-compact/`.
      `regionHash` + `checkpointId` + near-dup (`DEDUP_SIM`) dedup.
- [ ] **2.3 (S)** `src/store.ts` — checkpoint/state persistence (`chkpt_001`
      IDs, `sess_xxx` normalize, `state.json` injected-set).
- [ ] **2.4 (M)** Tests: round-trip store, search ranking sanity, dedup by
      hash/id/similarity, gzip integrity, corrupt-file recovery.
- [ ] **2.5 (S)** (Optional, behind flag) transformers.js embedder stub
      implementing `Embedder` — not wired by default.

**Exit:** store survives process restart; dedup provably idempotent (same region
twice → one vector); search returns the planted checkpoint top-1.

---

## Sprint 3 — pi extension wiring (Layer 4 persist + trigger)  ✅ DONE (commit 3867d55)

Goal: the extension compacts a real session and persists checkpoints.

- [ ] **3.1 (M)** `extensions/mega-compact.ts` — factory, config load
      (env-backed defaults), `session_start`/`session_shutdown`/`session_tree`
      state reset (per neuralwatt-mcr discipline), status-bar chip.
- [ ] **3.2 (L)** Auto-trigger: `on("turn_end")`/`on("context")` → `%` fast gate
      (`getContextUsage`) → local `auto_compact_check` confirm → run
      Trident(supersede+collapse) → `compact_session()` persist to vector store.
      Debounce + `isIdle()` guard.
- [ ] **3.3 (M)** `context` drop: return `{ messages: filtered }` dropping the
      superseded/collapsed range with tool-pair + anchor-floor guards.
- [ ] **3.4 (M)** `session_before_compact` → `{ cancel:true }` after we've
      persisted (avoid double compaction); emit `compactionSummary`-shaped
      message for native-looking UI.
- [ ] **3.5 (M)** Marker sentinel: on persist, `pi.sendMessage({customType:
      "mega-compact-marker", display:false, details:{checkpointId, regionHash,
      tokenEstimate, dropped}})`; replay/scan markers on `session_tree`.

**Exit:** in a long live session, auto-trigger fires once past threshold, a
`chkpt_xxx` is written, context visibly drops, marker present, no double-compact.

---

## Sprint 4 — Unified recall layer (Layer 5, all 3 entry points)  ✅ DONE

Goal: one vector store → auto-inline + on-demand + sentinel, one dedup engine.

- [ ] **4.1 (L)** `src/recall.ts` — `recallAndInline(ctx,{query?,limit,source})`:
      `search → dedupe → inject`. Injection via `before_agent_start`
      `{ systemPrompt }` prepend (model-visible), NOT a custom message.
- [ ] **4.2 (M)** Auto-inline: `session_start`/`session_tree` →
      `recallAndInline(source:"resume")` using newest user msg as query; gated by
      `MEGACOMPACT_AUTO_INLINE`.
- [ ] **4.3 (M)** `/recall-context [query]` command → `recallAndInline(
      source:"command")`; report inlined checkpoints.
- [ ] **4.4 (S)** Shared dedup: skip by `regionHash` marker in branch, by
      injected-`checkpointId` in `state.json`, cosine near-dup collapse.
- [ ] **4.5 (M)** Tests: auto-inline injects on resume, no re-inject of present
      region, `/recall-context` ranks relevant checkpoint first.

**Exit:** resume a compacted session → relevant context silently reappears in the
system prompt; `/recall-context` works; nothing double-injected.

---

## Sprint 5 — Commands, UX, config polish

- [ ] **5.1 (M)** `/megacompact [summary...]` — manual compact; if no summary
      arg, drive agent (`ctx.sendMessage` / `sendUserMessage`) to produce one;
      persist + report tokens saved via status chip.
- [ ] **5.2 (S)** `/megacompact-status` — threshold, current %, last chkpt, store
      size, dedup hit-rate.
- [ ] **5.3 (S)** Config surface: all `MEGACOMPACT_*` env + settings.json;
      document defaults.
- [ ] **5.4 (S)** Status-bar chip parity with neuralwatt-mcr (compaction %,
      "optimizing…", chkpt id).
- [ ] **5.5 (S)** Structured logging to `~/.pi/agent/extensions/mega-compact.log`.

**Exit:** all three commands usable in TUI; status chip live; config documented.

---

## Sprint 6 — Hardening, docs, release

- [ ] **6.1 (M)** End-to-end test script: scripted long session → auto-compact →
      restart pi → auto-inline restores context (cross-session proof).
- [ ] **6.2 (M)** Failure-mode tests: corrupt store, empty session, overflow
      recovery (`reason:"overflow"`, `willRetry`), branch switch mid-compact.
- [ ] **6.3 (S)** README (usage, layers, config, attribution to memory-mcp /
      claw-code / neuralwatt-mcr), CHANGELOG, RELEASE_NOTES.
- [ ] **6.4 (S)** `install.sh` (mirror pi-setup): copy/symlink into
      `~/.pi/agent/extensions/`, register in extensions config.
- [ ] **6.5 (S)** Full guardrails audit; tag `v0.1.0`; optional npm publish.

**Exit:** cross-session recall demoed; guardrails audit clean; v0.1.0 tagged.

---

## Dependency graph
```
S0 ─┬─ S1 ─┬─ S2 ─── S3 ─── S4 ─── S5 ─── S6
    │      │
    └ guardrails gate active from S0 onward (blocks every exit)
```
S1 and S2 engine work is pi-independent (parallelizable). S3 needs S1+S2. S4
needs S3. S5/S6 need S4.

---

## Guardrails adaptation (Sprint 0.2 detail)

Vendor from `guardrails-template/` → project root:
- `.claude/hooks/{pre,post}-execution.sh`, `pre-commit.sh` (as-is).
- `.claude/skills/{guardrails-enforcer,commit-validator,scope-validator,
  clean-architecture,production-first,error-recovery,three-strikes,
  env-separator}.json` (as-is).
- `.guardrails/{pre-work-check.md,failure-registry.jsonl,
  prevention-rules/*}` — retarget `file_glob` to ts/js only (already mostly).
- `.github/workflows/{guardrails-lint,regression-guard,secret-validation,
  documentation-check}.yml` (drop `team-validation` unless we use `.teams`).
- `scripts/{regression_check.py,log_failure.py}` (standalone Python).
- `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` (trimmed).

Strip (irrelevant to TS pi extension): `godot/`, `.claude/skills-3d/`,
`.cursor/rules-3d/`, `mcp-server/` (Sentinel), `web/`, `cmd/`, `ide/`,
game-design/spatial/accessibility docs, `.teams/*` (unless adopting phase gates).

Wire into `package.json`:
```
"scripts": {
  "build": "tsc -p tsconfig.json",
  "lint": "tsc --noEmit && python scripts/regression_check.py --all",
  "test": "node --test",
  "guardrails": "python scripts/regression_check.py --all",
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
1. Zero network calls at runtime (grep-verified in CI).
2. Auto-compaction fires on both gates; context measurably shrinks.
3. Checkpoints persist to local vector DB and survive pi restart.
4. Unified recall: auto-inline on resume + `/recall-context`, deduped by one
   engine; nothing double-injected.
5. Marker sentinel makes repeated triggers ~zero-token.
6. All guardrails (Four Laws, scope, secrets, regression, 500-line docs) pass in
   CI and pre-commit.
7. Ported claw-code compaction tests green.

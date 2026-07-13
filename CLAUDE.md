# Project Guidelines — pi-mega-compact

## 0. Navigation Maps (READ FIRST)
* **docs/INDEX_MAP.md**: Read this FIRST to find documents by keyword/category.
* **docs/HEADER_MAP.md**: Find specific sections with file:line references for targeted reading.
* **docs/AGENT_GUARDRAILS.md**: MANDATORY safety protocols — read before any code change.

---

## 1. Context & Setup
* **Stack**: TypeScript, Node >= 18, ESM (`"type": "module"`). Ships as a pi coding-agent extension (no remote MCP server).
* **Detector**: `package.json` (`pi.extensions`, `engines.node`), `tsconfig.json`. Do NOT read `package-lock.json` blindly.
* **Guardrails**: Read [docs/AGENT_GUARDRAILS.md](docs/AGENT_GUARDRAILS.md) before any code change. The Four Laws (Read First / Stay in Scope / Verify Before Commit / Halt When Uncertain) are NON-NEGOTIABLE.

---

## 2. Token-Saving Rules (STRICT)
* **NO EXPLORATION**: do not `ls -R` the whole tree; use the maps.
* **NO RE-READING**: trust your context; do not re-read files you just edited.
* **TARGETED CONTEXT**: read ONLY files relevant to the request.
* **CONCISE PLANS**: bullet points only.
* **USE MAPS**: check `docs/INDEX_MAP.md` before reading full documents.

---

## 3. Workflow
* **Tests**: run ONLY relevant tests (`npm test` runs `node --test` on `dist/**/*.test.js` — build first).
* **Edits**: prefer small, single-file edits in `src/`; keep `src/` pi-agnostic (no pi runtime types).
* **Commits**: one focused commit per task; AI-attribution required (pre-commit hook enforces `Co-Authored-By:`).
* **Guardrails gate**: every change must pass `npm run lint` + `python3 scripts/regression_check.py --all`.

---

## 4. Hard Project Constraints (PREVENT-PI)
These are pi-extension invariants; `scripts/guardrails-scan.mjs` scans for violations:

| Rule | Severity | Meaning |
|------|----------|---------|
| PREVENT-PI-001 | error | Never drop messages without the anchor-floor guard (preserve recent N). |
| PREVENT-PI-002 | error | Never split a toolCall/toolResult pair at a compaction boundary. |
| PREVENT-PI-003 | error | Never inject compacted context as `role:"system"` — use the `before_agent_start` systemPrompt prepend. |
| PREVENT-PI-004 | critical | **Zero network calls at runtime.** Extension is fully local (pglite = in-process WASM, FS persistence). No `fetch`/HTTP to remote. EXCEPTION: the optional, user-triggered `/dashboard` localhost server — audited via `// guardrails-allow PREVENT-PI-004: <reason>` inline annotations (scanner enforces a reason). |

Additional guardrails (from template): PREVENT-001 (JSON.parse without null check), PREVENT-002 (SQL string concat — use parameterized queries), PREVENT-011 (`any` type), PREVENT-024 (hallucinated package import), PREVENT-003 (hardcoded credentials).

---

## 5. Architecture at a Glance
* **Layers** (Trident stack): L1 supersede → L2 collapse → L3 cluster/vectorize → L4 persist → L5 recall/inline.
* **One store**: `pglite` (`@electric-sql/pglite`) is the source of truth from v0.2.0 (Sprint 8). Legacy gzipped JSON checkpoint files are retained as DR snapshots.
* **Embedder**: `TrigramEmbedder` default (self-contained, 512-dim). `MEGACOMPACT_EMBEDDER=minilm` (all-MiniLM-L6-v2 ONNX, 384-dim) is flag-gated, off by default.
* **Key source files**: `src/store.ts` (compression + state), `src/vectorStore.ts` (VectorStore add/search/dedupe), `src/engine.ts` (compactSession), `src/recall.ts` (recallAndInline), `src/embedder.ts`, `src/compact.ts`, `src/extractive.ts`, `src/supersede.ts`, `src/boundary.ts`, `src/types.ts`, `src/config.ts`, `src/adapt.ts`, `src/log.ts`.
* **Extension entry**: `extensions/mega-compact.ts` (pi runtime adapter).

---

## 6. Documentation Standards
* **500-Line Max**: no document over 500 lines. Split with `docs/` subfiles.
* **Update Maps**: update `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` when adding/changing docs.
* **Sprints**: per-sprint full specs live in `docs/specs/` following the SPRINT_GUIDE structure (Header / Safety / Problem / Scope / Execution / Acceptance / Rollback).

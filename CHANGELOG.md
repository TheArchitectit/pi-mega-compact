# Changelog

## v0.1.0 (2026-07-11)

First tagged release. The full local, vector-backed compaction pipeline is wired
end-to-end as a pi extension — no remote MCP server, all processing local.

### Added
- **Layer 1 — Supersede**: zero-cost pruning of obsolete file reads
  (`supersede.ts`).
- **Layer 2 — Collapse**: heuristic summarization (`compact.ts`:
  `summarizeMessages`, `mergeCompactSummaries`, `autoCompactCheck`).
- **Layer 3 — Cluster / vector store**: deterministic trigram-bag embedder
  (`embedder.ts`) + gzipped on-disk checkpoint persistence (`store.ts`) +
  `VectorStore` (`vectorStore.ts`) with `add / search / dedupe` and
  cosine near-duplicate collapse at `DEDUP_SIM=0.90`.
- **Layer 4 — Persist + trigger**: `engine.ts` `compactSession()` Trident
  pipeline (SUPERSEDE → COLLAPSE → CLUSTER) and `extensions/mega-compact.ts`
  wiring — config load, session state reset, the auto-trigger
  (`context` → % fast-gate → `autoCompactCheck` → persist → context drop
  honoring the anchor floor + tool-pair guards), and `session_before_compact`
  cancellation once a checkpoint is persisted.
- **Layer 5 — Unified recall**: `recall.ts` `recallAndInline()` is the
  single injection path serving three entry points through one dedup engine:
  - Auto-inline on `session_start` (resume/fork) and `session_tree`, gated by
    `MEGACOMPACT_AUTO_INLINE`, injected via the `before_agent_start`
    system-prompt prepend (PREVENT-PI-003).
  - On-demand `/recall-context [query]`.
  - The dedup sentinel (`mega-compact-marker` entry) so no region is
    re-vectorized or re-injected.
- **Adapter boundary** (`adapt.ts`): the one pi↔engine message conversion,
  index-aligned so drop-range indices map straight back onto real messages.
- **Commands**: `/megacompact [summary...]`, `/recall-context [query]`,
  `/megacompact-status` (now with live store stats: checkpoint count, tokens,
  last chkpt, injected count, dedup hit-rate).
- **Status-bar chip** with parity to neuralwatt-mcr (compaction %, chkpt id,
  "recalled N chkpt").
- **Structured logging** to `~/.pi/agent/extensions/mega-compact.log`
  (gated by `MEGACOMPACT_DEBUG`), best-effort (never throws into the
  extension).
- **Test suite**: 52 unit tests across all engine modules + the vector store,
  run via `node --test` on the compiled output.
- **Guardrails**: agent-guardrails Four-Laws / scope / secrets / regression gate
  active from Sprint 0; `guardrails-scan` + `regression_check` both green.

### Config (env-backed, see README)
`MEGACOMPACT_FAST_GATE_PCT`, `MEGACOMPACT_THRESHOLD_TOKENS`,
`MEGACOMPACT_ANCHOR_USER_MESSAGES`, `MEGACOMPACT_PRESERVE_RECENT`,
`MEGACOMPACT_AUTO`, `MEGACOMPACT_AUTO_INLINE`, `MEGACOMPACT_AUTO_INLINE_K`,
`MEGACOMPACT_DEDUP_SIM`, `MEGACOMPACT_STATE_DIR`, `MEGACOMPACT_DEBUG`.

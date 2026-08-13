# Succession map — mega-compact/ithacus → radcode

**Date:** 2026-08-13. Companion to `docs/LTS.md`. Maps each mega-compact + ithacus capability to its radcode disposition: already-ported / to-port / protected-radcode-native / retired.

radcode is at `/mnt/data/git/RADOPENCODE` (remote `TheArchitectit/radcode`). Its own roadmap: `docs/RADCODE_CONSOLIDATION_ROADMAP.md`. Design IP to carry forward: `docs/RADCODE_DESIGN_IP_FROM_MEGA.md`.

## Already ported to radcode (verified 2026-08-13)

| Capability | mega/ithacus source | radcode location | Note |
|---|---|---|---|
| Trident compaction (supersede→collapse→cluster) | `src/engine.ts`, `src/compact.ts` | `crates/memory/src/compact/mod.rs` | Ported (MP sprints). **BUT inert at runtime** — `LightBackend::compact` is a no-op; only REPL `/compact` runs it. Wiring is radcode Phase 0. |
| Boundary safety (anchor floor, tool-pair guard) | `src/boundary.ts` | `crates/memory/src/compact/boundary.rs` | Ported (file opens with port admission). |
| Pressure tiers + extractive | `src/compact.ts`, `src/extractive.ts` | `crates/memory/src/compact/{config,extractive,collapse}.rs` | Ported. |
| Dedup L0/L1/L2 + trigram | `src/dedup/`, `src/store/bloom.ts` | `crates/memory/src/dedup/` | Ported with param fidelity (256 hashes, 64×4 LSH, 512-dim FNV-1a). |
| RAPTOR tree | `src/dedup/raptor/` | `crates/memory/src/raptor/` | Ported. |
| Recall (recallAndInline + xrepo + fork) | `src/recall.ts`, `src/recall/` | `crates/memory/src/recall/` | Ported. **BUT inert** — `memory_integration` is orphaned; recall not wired to the live loop. radcode Phase 0. |
| Turn store + fork | `src/store/turns/` | `crates/storage/`, `crates/runtime/src/fork.rs` | Ported. Apply C2 lesson 2.1 (conversation-monotonic index) when wiring. |
| decideTrim | ithacus `src/team.ts` | `crates/team/` | Ported. |

## To port into radcode (unique to TS — radcode lacks or is thinner)

| Capability | Source | radcode gap | radcode phase |
|---|---|---|---|
| **Vector-cortex** (PGlite+pgvector, global topology, canary rollout) | `src/vector-cortex/`, `src/vectorStore.ts` | 0 references — biggest gap | Phase 2.1 |
| **FTS5 trigram tokenizer** | `src/store/sqlite.ts` | radcode uses BM25 | Phase 2.2 |
| **6-axis context-health** (incl. storeErrorRate) | `src/contextHealth.ts` | radcode monitoring thinner | Phase 2.3 |
| **Mailbox** (parent↔child agent messaging) | ithacus `src/mailbox.ts` | radcode `inbox` = task queue, not messaging | Phase 2.4 |
| **Dispatch** (child subprocess, `-e`, `--mode json`) | ithacus `extensions/ithacus-spawn.ts` | radcode dispatcher is in-process | Phase 2.4 |
| **15-state worker-status** | ithacus `src/worker-status.ts` | radcode has coarse `TeamRecordStatus` | Phase 2.5 |
| **3WF pattern** (three-way failback) | `src/failback/`, context-handler guards | not present — build in during Phase 0 wiring | Phase 0 (design IP doc) |
| **Bridge API facade** | `src/bridge/factory.ts` | becomes radcode's MCP tool surface | Phase 1 |
| **Dashboard auth + route coverage** | `extensions/dashboard-server/` (~80 routes) | radcode ~14 routes, no auth | Phase 2.6 (protect radcode's Leptos impl; port surfaces) |

## Protected radcode-native (NOT ported from mega — preserve, do not gut)

These are radcode's own surface with no mega/ithacus equivalent. A mega-parity rewrite must not drop them: **TUI + concurrent channels** (`03_TUI`), **native desktop** (`06_PLATFORM`), **LSP client**, **plugin system** (`.so`/`ToolPlugin`), **Discord/Telegram bots + CI action**, **VS Code extension**, **remote control mobile UI**, **game mode** (`05_GAME`), **built-in workflows** (code_dev/bug_fix/review/refactor), **`radcode serve` JSON-RPC**. radcode specs `03_TUI`, `04_DASHBOARD`, `05_GAME`, `06_PLATFORM` are PROTECTED; only `01_MEMORY_CORE` + `08_PARITY_CATCHUP` rewrite freely; `02_AGENT_FRAMEWORK` is surgical (mixed).

## Retired (superseded, not ported)

- mega's React dashboard → superseded by radcode's Leptos/WASM dashboard (different framework, deliberate).
- mega's `node:sqlite` sync store → superseded by radcode's `rusqlite` (storage crate, schema v12).
- mega's PREVENT-PI guardrails scanners → radcode has its own guardrails approach; carry forward the `PREVENT-INTERNAL-ERR-001` pattern (C2 lesson 2.3) and PREVENT-PI-004 (zero-network-by-default) as principles.

## The endgame

A thin TS pi-extension ("radcode brain adapter") delegates pi.dev's `before_agent_start`/context/`session_shutdown` hooks to radcode's MCP brain. mega-compact + ithacus retire once the adapter runs mega's real workloads with verified-equivalent results. See `docs/LTS.md` § Retirement criteria.

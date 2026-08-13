# pi-mega-compact — Long-Term Support (LTS)

**Status:** LTS — patches only, as of 2026-08-13.
**Current release:** v0.21.4 (the last feature release; Sprints R + H + 3WF are all in).
**Successor:** [radcode](https://github.com/TheArchitectit/radcode) (Rust) — a complete pi.dev replacement.

## Why LTS

pi-mega-compact is a mature, over-built extension (~1200 tests, v0.21.4, deployed and dogfooded) serving a small user base. A successor — radcode — has already ported most of its stack (the `MP-00…MP-32` Mega-Port sprints: Trident compaction, boundary safety, pressure tiers, dedup L0/L1/L2, RAPTOR, recall, turn store) and radcode's own review documents the plan: *reach compaction+memory parity, then sunset mega-compact.* Maintaining feature parity across two languages for a small user base is the wrong allocation of effort, and every new TS feature widens the parity gap radcode must close (Rust iterates slower).

So mega-compact stops growing. It remains the **live production system** until radcode's brain is wired and verified equivalent, at which point it is retired.

## What LTS means

- **Bug fixes + security patches only.** No new features. No new sprints.
- The shipped bridge to ithacus (v0.21.3 ↔ v0.6.16) stays as-is — it is the pattern for radcode's eventual inverted pi-adapter.
- The TS stateless-MCP state-server + dashboard-absorption plan (briefly considered 2026-08-13) is **cancelled** — it would invest in the sunset-path system. The MCP state server, when built, goes in radcode (Rust).
- Open feature branches (`feat/three-way-failback`, etc.) are merged-or-frozen, not extended.

## What moves to radcode

All future feature work. The forward-looking design IP is captured in radcode at `docs/RADCODE_DESIGN_IP_FROM_MEGA.md` and `docs/RADCODE_CONSOLIDATION_ROADMAP.md`. In summary:

- **Three-Way Failback (3WF)** — the critical-path reliability pattern (three independent sources → vote → validate → escalate → guard). radcode should build this in when it wires its (currently inert) recall/compaction, not port mega's pre-3WF naive version.
- **Vector-cortex** (PGlite+pgvector HNSW) — the single biggest unique mega asset; radcode has zero cortex references today.
- **FTS5 trigram** (radcode uses BM25), **6-axis context-health** (radcode's monitoring is thinner), **mailbox** (radcode's inbox is a task queue, not agent messaging), **ithacus dispatch** (child subprocess spawn), **15-state worker-status**.
- **C2 lessons** — conversation-monotonic turn indexing (not per-session), store-write errors as a distinct health axis, the internal-error scanner guardrail.

## Retirement criteria (the sunset)

mega-compact is retired when **all** hold:
1. radcode's brain is wired and verified live — `memory_integration` connected to the agent loop, real recall (not substring AutoMemory), real compaction (not the no-op `LightBackend::compact`).
2. radcode's MCP server serves the brain over stdio + stateless HTTP.
3. A thin TS pi-adapter delegates pi.dev's hooks to radcode's MCP brain, and runs mega's real workloads with verified-equivalent results.
4. The unique assets (cortex, FTS5, mailbox, dispatch, health) are ported or superseded in radcode.

Until then, mega-compact v0.21.4 + ithacus v0.6.18 are the production system.

## For maintainers

- Treat this repo as maintenance-only. A change that adds a feature is out of scope; redirect it to radcode.
- The guardrails, deploy gate (`scripts/deploy.sh`), and file limits still apply to any patch.
- See `docs/SUCCESSION.md` for the asset-by-asset migration map.

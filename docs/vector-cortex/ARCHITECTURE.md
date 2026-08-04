# Vector Cortex Architecture

## Authority and planes

The append-only EventV2 ledger is the sole historical authority; original bytes and occurrence order outrank normalized/search representations. Host pushes facts and pulls views; stores initiate no callbacks. Current backend choices defer to root `CLAUDE.md` and as-built source. Derived cortex artifacts are disposable and bounded by contiguous durable authority high-water.

Data flow:

`host bytes → EventV2 ledger/compat journal → qualified encoder A | trigram B | lexical C → capability-gated topology → semantic + exact/residual shards → mandatory VC4C closure → PromptDagV1/plan → validated renderer → optional provider-profile crystal → host prompt hook`.

No compacted context is injected as system-role content. Anchor floor and tool pair adjacency are invariant. A validator failure returns the unchanged predecessor/C path before provider invocation.

## Owned seams

- [CONTRACTS](CONTRACTS.md): EventV2, PromptDagV1 edge/order/span semantics, plans, profiles, crystal keys, triad result, compatibility journal.
- [MODEL_ASSET](MODEL_ASSET.md): learned architecture/training/runtime/package qualification; unqualified A cannot serve.
- [RESIDUAL_CODEC](RESIDUAL_CODEC.md): reversible byte codec and RS numeric erasure parity. Semantic vectors never recover exact text.
- [TRIAD_RESILIENCE](TRIAD_RESILIENCE.md): breaker constants, independent fallbacks, authority outage and spool.
- [SECURITY_PRIVACY](SECURITY_PRIVACY.md): permissions/encryption/lifecycle/consent.

## Storage and capability boundaries

Ledger reader exposes ordered range and high-water; writer only append; admin export/retention/integrity. Cortex/cache/outcome stores repeat reader/writer/admin gating. Dashboard GET receives reader only. Every derived row includes schema/algorithm versions, exact source ranges, source/dependency high-water and input/output digest. Append failure is non-fatal to host but freezes derived frontier and selects C.

Exact tier contains tools, anchors, invalid UTF-8 and any protected/source bytes. Semantic tier is task-state assistance. Residuals are admitted only if complete parity artifact is smaller than exact compression and digest round-trips. VC4C closure recursively includes dependencies/tool pairs and conservatively resolves contradictions before any VC5 plan.

## Cache and provider boundary

ProviderProfileV1 base registry arrives VC5B. Entire canonical outbound request is hashed unless a versioned fixture proves a field cache-irrelevant; unknown profile bypasses. Immutable crystals bind covered ranges/digest, dependency high-water, profile/request and renderer version. Unrelated global frontier changes do not invalidate a crystal. Provider raw fields remain preserved; there is no universal cache API fiction.

## Local-only and release

Runtime loads packaged integrity-checked assets or explicit local paths. No downloader. Enforcing tests deny Node network constructors while running all modes and scan TS/Rust dependency/source. Optional audited loopback features remain outside model download behavior. Assets and neutral conformance fixtures are verified in `npm pack --dry-run` listing and offline clean-install smoke; publishing remains `scripts/deploy.sh` only.

## Downgrade and repair

Every v2 append atomically records compatibility journal data. Downgrade exports a verified legacy copy; active v2 is never opened by an old binary or silently left stale. Derived corruption rebuilds from ledger into a new generation then atomically switches. VC6 improves proofs/restoration/rebuild scheduling; it does not postpone closure required by VC4C.

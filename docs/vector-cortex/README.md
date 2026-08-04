# Vector Cortex Implementation Package

**Status:** in progress (VC0 ✅, VC1A/VC1B ✅, VC1C next); no sprint is complete without durable reviewer-accepted evidence.

## Read order

1. [Implementation readiness](IMPLEMENTATION_READINESS.md)
2. [Contracts](CONTRACTS.md) and [Architecture](ARCHITECTURE.md)
3. [Model asset](MODEL_ASSET.md), [Residual codec](RESIDUAL_CODEC.md), [Security/privacy](SECURITY_PRIVACY.md)
4. [Triad resilience](TRIAD_RESILIENCE.md), [Conformance](CONFORMANCE.md), [Evaluation](EVALUATION.md)
5. [Master plan](SPRINT_PLAN.md), active [phase](phases/), active [sprint](sprints/)
6. Use [evidence template](EVIDENCE_TEMPLATE.md); create `evidence/<SPRINT>.md` only during execution.

## Locked program decisions

- EventV2 preserves original bytes/digest and every occurrence; NFC is derived comparison only.
- VC4C conservative dependency/contradiction closure gates VC5. VC6 is advanced restoration/repair.
- VC5A owns PromptDagV1 schema, builder, validator, fixtures and stable ordering.
- Learned A is ineligible until [MODEL_ASSET](MODEL_ASSET.md) qualification; trigram B and lexical C remain live.
- Exact text never comes from embeddings. Exact/residual bytes and true numeric erasure parity follow [RESIDUAL_CODEC](RESIDUAL_CODEC.md).
- VC5B owns ProviderProfileV1 base registry; full outbound request is hashed by default; unknown profiles bypass crystals. VC7 adds economics.
- Crystals key covered ranges/digest and dependency high-water, not global frontier.
- Rollout requires duration **and** powered samples/events. Shadow savings are estimates; causal cache claims require randomized session-level provider telemetry.
- All flags are positive, default ON, and `=0` disables. Zero runtime network/model download.
- New writes maintain compatibility journal; downgrade uses verified exporter copy, never stale legacy state.
- TypeScript is reference. This repo publishes neutral fixtures; Rust remains an external Rad repository artifact.

## Dependency and status

`VC0 → VC1 → VC2 → VC3 → VC4 (mandatory closure) → VC5 live → VC6 optimization → VC7 cache → VC8 adaptation/parity`.

| Phase | Exit | Status |
| --- | --- | --- |
| VC0 | measured replay and universal safety envelope | ✅ done (VC0A, VC0B, VC0C) |
| VC1 | exact v2 ledger, compatibility journal, conformance | ✅ done (VC1A, VC1B, VC1C) |
| VC2 | qualified learned A plus live B/C | 🟡 in progress (VC2A ✅, VC2B ✅, VC2C next) |
| VC3 | deterministic capability-gated topology | planned |
| VC4 | byte-faithful reconstruction and mandatory closure | planned |
| VC5 | validated DAG live rollout | planned |
| VC6 | exact restoration and derived repair | planned |
| VC7 | provider-honest range crystals and causal economics | planned |
| VC8 | consent adaptation and external Rust parity | planned |

Current backend facts defer to root `CLAUDE.md` and as-built source. Existing `PLAN.md` better-sqlite wording is stale and non-normative. Status changes require independent attestation in `docs/vector-cortex/evidence/<SPRINT>.md`.

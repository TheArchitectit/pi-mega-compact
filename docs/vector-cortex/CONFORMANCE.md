# Vector Cortex V2 Conformance

## Fixture root and manifest

Neutral artifacts live only under `conformance/vector-cortex/v2/`: `manifest.json`, `schemas/`, and the sprint-owned domain directories enumerated below. The v2 manifest is authoritative: a domain directory is valid only when listed with an owner sprint and schema version; the checker rejects any directory/file absent from that manifest.

| Phase domains | Directories |
| --- | --- |
| VC0 | `evaluation/`, `replay/`, `resilience/` |
| VC1 | `events/`, `ledger/`, `conformance/`, `minhash/`, `migrations/` |
| VC2 | `encoder-runtime/`, `encoder-heads/`, `encoder-qualification/`, `model/` |
| VC3 | `cortex-store/`, `topology/`, `topology-query/` |
| VC4 | `shards/`, `residual/`, `reconstruction/` |
| VC5 | `prompt-dag/`, `planner/`, `render/`, `provider/`, `rollout/` |
| VC6 | `closure-optimization/`, `restoration/`, `healing-controller/` |
| VC7 | `cache-crystals/`, `cache-economics/`, `cache-diagnostics/` |
| VC8 | `outcomes/`, `adaptive-policy/`, `cross-language/` |
| VC9 | `setup-dashboard/` |
| ML5 | `bench-assets/`, `encoder-health/`, `cortex-improvement/`, `runtime-selection/` |
| PC | `prompt-dag-v2/`, `striping-telemetry/`, `cache-visibility/`, `rollout-validation/` |
| DEDUP-ATTR | `dedup-attribution/` |
| ENC | `encoder-decision/`, `encoder-trunk/`, `encoder-heads-real/`, `encoder-promotion/`, `encoder-demotion/`, `encoder-budget/` |
| DASH | `dashboard-consolidation/` |
| COS-FP | `cosine-fp/` |
| REPO | `repo-corpus/` |
| DOC | (none — pure-docs phase; no conformance fixtures) |

`manifest.json` lists fixture ID, relative path, SHA-256, schema/algorithm version, producer, expected result/error code, and license. `scripts/vector-cortex-conformance.mjs --check` fails for an absent/unlisted/extra file, digest drift, schema error, duplicate ID, or noncanonical JSON. VC1C adds package inclusion policy and verifies fixture paths in `npm pack --dry-run` output; it never creates a tarball.

Canonical JSON is UTF-8, NFC keys, sorted keys by UTF-8 bytes, shortest JSON number representation, no NaN/Infinity/negative zero, arrays ordered by contract, and final LF. Binary fields are unpadded base64. SHA-256 is over the declared canonical bytes. Event original bytes remain authoritative per [CONTRACTS](CONTRACTS.md), including invalid UTF-8.

## Required fixture families

- `EVT-001..030`: duplicate occurrence, invalid UTF-8, NFC-equivalent/different bytes, tool IDs, seq gaps.
- `DAG-001..030`: stable order, synthetic ties, edge direction, spans, cycle, incompatibility, tool split; `PLN-001..020`: mandatory closure overflow and deterministic optional portfolio selection.
- `M4-001..030`: published MinHashV2 seeds, exact high-bit u64 arithmetic, signature/band bytes, version isolation, interrupted backfill/resume.
- `RES-001..050`: codec, quantization corrections, 0..4 erasures, corrupt shard, admission accounting.
- `PRO-001..030`: full request hash, allowed exclusion, unknown profile bypass, covered-range/high-water keys.
- `TRI-001..030`: breaker clocks/restart/hysteresis and spool drain/ack/dedup/gaps.
- migrations `M2..M7`: interruption, resume, quarantine, old/new cross-read.

## Migrations and downgrade

M2 occurrence-v2 (VC1B) fixes `src/mirror/mirror.test.ts` documented duplicate loss and creates compatibility journal. M3 effective-cut-v2 (VC0B) freezes `min(boundarySafeCut,committedSeq,capturedHighWater)`. M4 minhash-v2 (VC1C) versions `src/dedup/l1-minhash.ts` precision, shingles, seeds, signature/bands. M5 request-hash-v2 (VC7B/C) replaces request-prefix identity with full canonical outbound request. M6 router-generation-v2 (VC3C, consumed VC7C) fixes `src/tieredRouter.ts::invalidateSession` with structured session/generation/range keys. M7 pressure-v2 (VC8B) unifies `src/config.ts::PressureBand` and all persisted/dashboard/Rust values.

All migrations are copy-validate-switch, resumable and idempotent; preserve predecessor one release. Compatibility journal/export protocol is normative in [CONTRACTS](CONTRACTS.md). `MIG-DOWN-001` launches a pinned old-binary fixture against an exported copy after new v2 writes and proves count/order/bytes or explicit unrepresentable report; old binary opening active v2 must fail safely.

## Commands

```bash
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node --test dist/vector-cortex/conformance.test.js
npm pack --dry-run
```

The implementation adds the scripts/tests before these gates are claimed. `docs-check` validates links, 60 sprint/16 phase count, positive flags, exact test commands, migration IDs, and Markdown files <500 lines.

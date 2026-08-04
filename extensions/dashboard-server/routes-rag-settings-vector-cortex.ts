/**
 * dashboard-server/routes-rag-settings-vector-cortex.ts — Vector Cortex SETTINGS.
 *
 * The VC0A..VC5C chain flag inventory, split out of routes-rag-settings-helpers.ts
 * to keep that file under the 400-line extensions/ soft limit. Every VC flag is a
 * user-visible dashboard toggle (never in EXCLUDED_SETTINGS) per the chain spec,
 * and each carries the long description the Setup panel renders as help text.
 *
 * PREVENT-011: no `any` type.
 */

import type { SettingSpec, SettingGroup } from "./routes-rag-settings-types.js";

const boolDirect = (
	key: string,
	label: string,
	description: string,
	def: boolean,
): SettingSpec => ({
	key,
	label,
	description,
	type: "boolean",
	default: def,
	disabledConvention: false,
	requiresLlm: false,
});

/** The Vector Cortex chain flags, as one SETTINGS category. */
export const VECTOR_CORTEX_SETTINGS: SettingGroup = {
	name: "Vector Cortex",
	settings: [
		boolDirect(
			"MEGACOMPACT_VC0A",
			"VC0A Baseline Observability",
			"Structured evaluation observer (MetricEventV1 + latency histogram). OFF = mode C, byte-identical to predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC0B",
			"VC0B Replay Correctness",
			"ReplayCutV2 effective-cut (min of boundary-safe/commit/capture high-water + pair retreat + anchor floor) and M3 effective-cut-v2 migration. OFF = legacy capped replay, byte-identical.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC1A",
			"VC1A Canonical Byte Events",
			"EventV2 byte-authority ledger codec (original bytes + SHA-256, strict UTF-8, derived NFC) and canonical validator (EVT_DIGEST_MISMATCH / EVT_UTF8_TAG_INVALID / EVT_DUPLICATE_ID). OFF = mode C, transcript codec unchanged, byte-identical.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC1B",
			"VC1B Occurrence Ledger + Tool Identity",
			"Neutral occurrence ledger (LedgerReader/Writer/Admin + CompatJournalV1): per-session monotonic seq, tool result references one earlier call, uniqueness by (eventId,digest) only, and the M2 copy-validate-switch downgrade journal. OFF = mode C, ledger unwritten, byte-identical.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC0C",
			"VC0C Live Safety Envelope",
			"TriadResult/Breaker live circuit breaker (60s window, 20 attempts, 30s cooldown, 3 probes, 5min healthy residence) + durable spool before provider invocation; manual reset clears cooldown but never evidence. OFF = mode C, unchanged transcript, byte-identical.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC1C",
			"VC1C Cross-Language Conformance v2",
			"FixtureManifestV2 canonical manifest validator + DowngradeReport deterministic downgrade export + MinHashV2 exact big-integer signatures and the M4 copy/validate/switch minhash-v2 migration (seed table frozen, cross-language byte-exact). OFF = mode C, v1 sync dedup scan unchanged, byte-identical.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC2A",
			"VC2A Offline Model Runtime",
			"ModelManifestV1 digest-before-load ONNX runtime (opset17/batch1/max512) + asset-free trigram demotion. Asset path assets/vector-cortex/encoder-v1 is immutable/digest-pinned. OFF = mode C, byte-identical to predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC2B",
			"VC2B Multi-Head Encoder",
			"VectorSetV1 five L2-normalized heads (384/128/128/64/32) with head-calibration draft + asset-free trigram B (512d) and lexical C fallbacks, plus the per-head emit seam. OFF = mode C, no per-head vectors emitted, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC2C",
			"VC2C Encoder Qualification + Calibration",
			"QualifiedEncoderV1/CalibrationV1: calibration fit on the calibration split only (held-out labels prohibited) + atomic selection across MODEL_ASSET and per-head EVALUATION thresholds (any field failure demotes all of A). OFF = mode C, no qualification/calibration selection, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC3A",
			"VC3A Cortex Store",
			"Capability-gated derived cortex store (CortexReader/Writer/Admin + CortexRecordV1): additive, keyed (sourceHighWater, algorithmVersion, id), immutable records, deterministic generation rebuild + one root digest. OFF = mode C, no cortex records written, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC3B",
			"VC3B Deterministic Topology",
			"Deterministic cortical topology (TopologyV1/EdgeV1): per-(source,head) top-k=16/head calibrated-threshold edges, stable score-desc/then-target-ID sort, dependency directed + contradiction symmetric paired records, one stable generation digest. OFF = mode C, no topology graph built/emitted, predecessor-precise topology view, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC3C",
			"VC3C Topology Query + Router Invalidation",
			"TopologyQueryV1/RouterKeyV2 structured keys (length-delimited, unsigned-byte order, no prefix ambiguity), exact (session,generation) invalidation, stale-generation rejection (TOP_GENERATION_STALE), and the M6 router-generation-v2 copy/validate/switch migration. OFF = mode C, no structured router key / generation invalidation, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC4A",
			"VC4A Dual-Tier Shards",
			"SemanticShardV1/ExactShardV1/ShardManifestV1: partition a session ONLY at complete EventV2 boundaries; exact shards preserve every tool call/result pair, anchor and invalid UTF-8 event as original bytes (pairs never split across exact shards); manifest enforces disjoint sorted ranges + complete protected-span coverage. OFF = mode C, exact anchors/current transcript only, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC4B",
			"VC4B Residual Basis Parity",
			"Residual codec: orthonormal DCT-II basis + int16 block quantization + block-scoped exact correction stream + (9,6) Reed-Solomon parity shards with SHA-256 corruption detection; admission gates on encodedSize <= 95% of exact-compressed size. OFF = mode C, no residual artifact produced, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC4C",
			"VC4C Reconstruction Fidelity",
			"Conservative closure + source-order assembly + reconstruction validator: recursively closes dependencies and whole tool pairs to a fixed point, resolves contradictions by retaining the later exact source resolution, assembles spans solely by source range, and rejects missing anchors / split pairs / digest mismatch / unresolved contradiction. Mandatory token estimate is content-only and handed unchanged to VC5A. OFF = mode C, no closure/validator, byte-identical predecessor (VC4B).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC5A",
			"VC5A PromptDagV1 + Budgeted Planner",
			"Single-session DAG (PromptDagV1) + budgeted 0/1 portfolio planner: builds a stable Kahn-ordered DAG, computes the mandatory dependency/tool/anchor closure before optional selection, returns MANDATORY_CLOSURE_OVER_BUDGET with evidence preserved on overflow, and runs a utility-per-token portfolio that never exceeds the remaining budget. Framing is owned here, not in VC4C. OFF = byte-identical predecessor (VC4C).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC5B",
			"VC5B Validated Renderer + Provider Profiles",
			"Validated prompt renderer: replays VC5A's stable Kahn order verbatim, preserves exact tool bytes (PREVENT-PI-002), places compacted context via the host before_agent_start prepend seam — never role:system (PREVENT-PI-003) — and SHA-256 hashes the entire canonical outbound request before provider invocation. Unknown provider/model cleanly bypasses to the predecessor prompt path. OFF = byte-identical predecessor (VC5A).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC5C",
			"VC5C Live Graduated Rollout",
			"Live graduated rollout: deterministically hashes each session into a stable 10,000-bucket cohort and advances the exposure gate (1/5/25/50/100%) only after a 72h monotonic residency, a powered sample, >=10,000 events, and >=200 sessions — advancing ONE gate at a time. A hard causal/tool/anchor/exact failure freezes promotion and selects the pre-VC path. OFF = byte-identical predecessor (VC5B).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC6A",
			"VC6A Advanced Closure Optimization",
			"Advanced closure optimization: deterministically reduces the already-mandatory VC4C closure by transitive reduction over depends edges, emitting a ClosureProofV2 receipt per closure and a verifier that replays reductions against the conservative oracle (HEAL_PROOF_SET_MISMATCH on selected-set divergence). Protected edges (tool-pair / anchor / contradiction / sole-dependency) are never removed. The optimized selected set is byte-identical to the conservative closure. OFF = byte-identical predecessor (VC5C); arithmetic runs, only the reporter + dashboard seam is suppressed.",
			true,
		),
	],
};

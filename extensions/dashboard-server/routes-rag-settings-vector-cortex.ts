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
		boolDirect(
			"MEGACOMPACT_VC6B",
			"VC6B Exact Source Restoration",
			"Exact source restoration: restores the original bytes of closure spans ONLY from an exact shard (mode A) or a verified ledger range scan (mode B) — never inferred, reconstructed, or paraphrased from embeddings or semantic text. Requests are hard-bounded at 64 spans / 4MiB (HEAL_RESTORE_LIMIT); every span's SHA-256 is recomputed and bytes are inserted only after all requested span metadata validates, so a single bad span fails the whole request closed (HEAL_RESTORE_DIGEST_MISMATCH, HEAL_RESTORE_RANGE_MISMATCH). When no exact source exists (HEAL_RESTORE_SOURCE_MISSING) the old context is omitted and the loss is disclosed (mode C) rather than filled in. OFF = byte-identical predecessor (VC6A).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC6C",
			"VC6C Self-Healing Derived State",
			"Self-healing derived-state controller: detects gaps between each derived subsystem's high-water mark and the durable authority high-water, then rebuilds derived state by copy -> root-digest verification -> atomic pointer switch, so a partially rebuilt subsystem is never made visible. A targeted single-subsystem rebuild is mode A; an ambiguous gap escalates to a full deterministic rebuild (mode B); if both rebuild paths fail the derived state is disabled rather than served stale (mode C). Rebuilds are rate-limited to one per subsystem per 5 minutes with deterministic exponential backoff, so a persistently failing subsystem cannot spin. OFF = byte-identical predecessor (VC6B); no controller runs, so the dashboard reports mode C.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC7A",
			"VC7A Frozen Range Crystals",
			"Frozen range crystals: caches a rendered prompt under an IMMUTABLE key built from the source ranges it covers, the digest of those covered bytes, the validated durable dependency high-water, and the renderer + provider profile — and deliberately NOT the global ledger frontier, so an unrelated append leaves the key unchanged instead of invalidating every crystal on every turn. Any covered-byte, dependency, renderer, or profile change invalidates 100%. Ranges are sorted by source start and overlapping ranges are rejected (CRY_RANGE_OVERLAP) rather than merged. The store is content-addressed and write-once: identical bytes re-written are idempotent, but a same-key/different-bytes write returns CRY_KEY_COLLISION and never overwrites, surfacing renderer non-determinism instead of hiding it. A store hit is mode A, a miss/collision forces a fresh deterministic render (mode B), and an unavailable store bypasses the cache entirely (mode C). OFF = byte-identical predecessor (VC6C); the crystal/store arithmetic still runs, only the reporter + dashboard seam is suppressed.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC7B",
			"VC7B Provider Cache Economics",
			"Provider cache economics: extends the VC5B provider registry with cache economics (read/write price, TTL, minimum prefix, and a mandatory exclusion fixture id). Answers whether reusing a frozen crystal is actually worth it — a cache WRITE typically costs more than an uncached token, so a cache only pays off once a written prefix is re-read enough times before TTL expiry. Net savings are reported (never clamped at zero, so a losing cache stays visible) and every exclusion MUST name a proving conformance fixture or it is rejected (ECON_EXCLUSION_UNPROVEN). A compiled crystal boundary still reuses the VC7A key unchanged, and a randomized session-level experiment assigns arms by a stable hash so a lost assignment journal re-derives the same arm. OFF = byte-identical predecessor (VC7A); the economics/compiler/experiment arithmetic still runs, only the reporter + dashboard seam is suppressed.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC7C",
			"VC7C Cache Diagnostics & Breakers",
			"Cache miss diagnostics + cache-level breakers + the completed M5 request-hash-v2 switch. Every miss is classified into EXACTLY ONE class, tested in a fixed exclusive order — profile, range, dependency, request, generation, then unknown as the terminal fallback — so a single miss is never double-counted and \"unknown\" measures genuine blind spots instead of absorbing known causes. Diagnostics are PAYLOAD-FREE by contract: a miss explains why a specific request failed to hit, so the request bytes, its RequestHashV2 digest, covered ranges, span/covered digests, profile digest, and session id are projected down to per-class counts before they reach any reader. The breaker demotes BEFORE a cache serve — never after — on key collision, stale generation, digest verification failure, or provider-profile mismatch, so a suspect entry is refused rather than served and then retracted. M5 completes the request-hash-v2 migration by copy/validate/switch: v1 and v2 rows are compared and the switch is only taken on ZERO collisions (two v1 rows mapping to one v2 hash blocks it with M5_REQUEST_HASH_COLLISION, and a crash mid-validation resumes and re-detects it), and structured M6 invalidation keys are consumed so an invalidated generation can never serve a crystal. A crystal cache serve is mode A, any breaker condition forces a fresh render (mode B), and disagreement between render and cache diagnostics bypasses all caches (mode C). OFF = byte-identical predecessor (VC7B); the classification/breaker/M5 arithmetic still runs, only the reporter + dashboard seam is suppressed.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC8A",
			"VC8A Consent-Bound Outcomes",
			"Consent-bound outcome ledger and offline learning dataset. Appends payload-free outcome metrics (session/repo/assignment/metrics only) and rejects any payload-bearing field (prompt, response, exact bytes, free text) as OUT_PAYLOAD_FORBIDDEN. Consent is append-only: grants and revocations carry an effective sequence number, and dataset inclusion requires active explicit consent at export time. Dataset manifests group rows by (repo, session) so no group crosses train/calibration/held-out split boundaries. Revocations disappear from future manifests. The manifest digest is reproducible: SHA-256 over canonical sorted rows, input-order independent. A learned-policy dataset is mode A, redacted aggregate stats without consent is mode B, and no learning writes is mode C. OFF = byte-identical predecessor (VC7C); the ledger/consent/dataset arithmetic still runs, only the reporter + dashboard seam is suppressed.",
			true,
		),
	],
};

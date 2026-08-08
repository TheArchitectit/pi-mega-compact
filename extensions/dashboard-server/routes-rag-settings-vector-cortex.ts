/**
 * dashboard-server/routes-rag-settings-vector-cortex.ts — Vector Cortex SETTINGS.
 *
 * The VC0A..VC8C chain flag inventory, split out of routes-rag-settings-helpers.ts
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
		boolDirect(
			"MEGACOMPACT_VC8B",
			"VC8B Shadow Adaptive Policy",
			"Bounded shadow adaptive policy + M7 pressure-v2 migration. Policy actions are from a finite set (admit/dampen/defer/escalate/reject) chosen deterministically by the canonical pressure level; token budgets are clamped into a configured window after the pressure factor. Unknown pressure labels are rejected as POL_PRESSURE_UNKNOWN, never coerced to a neighbour. The shadow engine is structurally incapable of affecting the live path: inputs are deep-copied, the canonical prompt digest is pinned before and after to prove non-mutation, and liveMutations is always zero. M7 migrates legacy pressure labels to the v2 canonical five by copy/validate/switch; an unknown label blocks the switch and keeps the legacy pointer (M7_PRESSURE_UNKNOWN). A shadow decision is mode A, static calibrated policy is mode B (forced by invalid A), and fixed legacy thresholds is mode C (forced by M7 or B failure). OFF = byte-identical predecessor (VC8A); the policy/shadow/migration arithmetic still runs, only the reporter + dashboard seam is suppressed.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC8C",
			"VC8C Canary Platform + Rust Parity",
			"Canary selection and external Rust parity. The selector admits a qualified external Rust artifact only when ABI version, URL metadata, commit, Cargo.lock digest, and platform all match evidence; a Cargo.lock digest mismatch rejects the artifact (RUST_CARGO_DIGEST_MISMATCH). The cross-conformance runner exchanges length-framed neutral records over a local stdin/stdout channel — a subprocess, never a URL (PREVENT-PI-004). A parity mismatch selects TS mode B. A qualified external artifact is mode A, TS reference is mode B, legacy path is mode C. OFF = byte-identical predecessor (VC8B); the selector and cross-conformance arithmetic still run, only the reporter + dashboard seam is suppressed.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC9A",
			"VC9A Setup Cortex Status",
			"Reader-only Setup Cortex status read path (GET /api/setup-cortex-status): surfaces the vector-cortex encoder gate — mode A/B/C, qualification verdict, open blockers, encoder health — to the dashboard Setup tab without closing the ML gate. OFF = byte-identical predecessor (VC8C-era): returns enabled:false / mode:C / status:off.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC9B",
			"VC9B Setup Cortex Actions",
			"Setup Cortex action drivers (POST /api/setup-cortex-action + GET /api/setup-cortex-action-log): confirmation-gated wrappers that fetch-model / bench / verify-asset by spawning only the committed local scripts (scripts/vc2-model-prep/fetch-model.sh, bench-onnx.mjs) or re-reading the committed encoder assets — never payload bytes, no network. Actions gated by an OPEN hard-gate item (HG-1/HG-3) return action_blocked_by_open_item and do NOT spawn. OFF = byte-identical predecessor (VC9A-era): the action POST returns a disabled/404 shape and flag-off bytes are unchanged.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC9C",
			"VC9C SetupTab Cortex Sub-tab",
			"SetupTab Cortex sub-tab (client UI): a Cortex sub-tab inside SetupTab that consumes the VC9A status endpoint (GET /api/setup-cortex-status) + the VC9B action endpoints. It surfaces the encoder mode A/B/C, asset digest prefix, qualification verdict + threshold failures, the open hard-gate blockers, and the confirmation-gated fetch/bench/verify actions. OFF = byte-identical predecessor (VC9B-era): the Cortex sub-tab is filtered from SUB_TABS and the Setup tab renders exactly as before.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_VC9D",
			"VC9D Embedder Detect Consolidation",
			"Embedder-detect consolidation + VC9 workstream roll-up: memoizes /api/setup-detect against the mutable input (resolved binary path + mtime) so consecutive requests reuse the result without re-spawning, and unifies the embedder + cortex sub-tabs' 5s poll contract. OFF = byte-identical predecessor (VC9C-era): detect spawns fresh per request and the embedder poll keeps its previous cadence.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_PC_C",
			"PC-C Dashboard Cache Visibility",
			"Dashboard per-turn prompt-cache visibility: surfaces the per-turn stable-prefix ratio trend (GET /api/prefix-stability) in the CacheTab PrefixStabilityCard. Reads aggregate ratios/counts from the local monitoring events log only — no payload bytes. OFF = byte-identical predecessor (PC-B-era): /api/prefix-stability returns 404 and the CacheTab omits the PrefixStabilityCard.",
			true,
		),
		// guardrails-allow PREVENT-STUB-001: ML5-A (description references the placeholder-weighted VC2C path; real trained-heads load is ML5-A)
		boolDirect(
			"MEGACOMPACT_ML5_A",
			"ML5-A Five-Head Training Load",
			"ML5-A real trained-head loading: loadHeadProjections (trained-heads-v1) feeds selectQualifiedEncoder (trainedHeadsPath atomic demotion) + loadCalibrationV1. ON (default) = a pinned trained-heads path must load for mode A. OFF = loaders return null and selection ignores trainedHeadsPath — byte-identical to the placeholder-weighted VC2C path.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ML5_C",
			"ML5-C Runtime Decision + Packaging",
			"ML5-C runtime backend selection (WASM vs native): selects the ONNX runtime backend based on the ML5-B bench record and platform support. ON (default) = the runtime-selection dispatch runs and emits vector_cortex_runtime_selected. OFF = no selection runs — encoder serves mode B trigram, byte-identical to ML5-B.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ML5_D",
			"ML5-D Dashboard Improve Cortex",
			"ML5-D dashboard 'Improve Cortex' surface: the ModelImprovementCard + POST /api/cortex/improve + GET /api/cortex/improve/status/:jobId. ON (default) = the card renders and Improve launches a local ML5-A training job. OFF = both improve endpoints return 404 and VectorCortexTab omits the card, byte-identical to ML5-C.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ML5_E",
			"ML5-E Nightly Retraining Cron",
			"ML5-E nightly retraining + feedback loop: the user's own post-redaction conversation turns become fresh training signal, the five heads are re-fit nightly via system cron, calibration is re-validated, and mode-A promotion is re-checked without human intervention. The cron is system-configured (crontab -e); the extension never installs or writes a crontab. Candidates are written to ~/.pi/mega-compact-encoder/candidates/ and promoted via the ML5-D Improve Cortex flow. ON (default) = the scripts may be invoked by the system cron. OFF = scripts are never invoked; byte-identical to ML5-D.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_DEDUP_ATTR",
			"Dedup Tier Attribution Rollup",
			"Dedup tier-attribution rollup: per-tier dedup catch shares (L0/L1/L2/new percent of dedup decisions) read from the local events.log dedup_audit stream (GET /api/dedup-tier-attribution). OFF = 404 + no cache file, byte-identical predecessor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_0A",
			"ENC-0a Encoder Backend Decision",
			"ENC-0a learned-encoder backend-decision lock: records the transformers.js/WASM vs onnxruntime-node choice, per-platform install matrix, opset-21 baseline and pinned digests in docs/vector-cortex/encoder-backend-decision.md. OFF = no decision record written / no resolver runs, mode B trigram byte-identical predecessor.",
			true,
		),
		// guardrails-allow PREVENT-STUB-001: ENC-0b (description references the LCG placeholder; real ONNX trunk fetch + inference is ENC-0b)
		boolDirect(
			"MEGACOMPACT_ENC_0B",
			"ENC-0b Real Trunk Fetch & Gated Path",
			"ENC-0b real ONNX trunk fetch + gated inference: replaces the LCG placeholder with the real bge-small int8 model through an ONNX InferenceSession (onnxruntime-web WASM). OFF = LCG placeholder serves byte-identical predecessor output, no ONNX session built.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_0C",
			"ENC-0c Five-Head Supervision Transfer",
			"ENC-0c five-head supervision transfer on the frozen bge-small trunk: when a developer-trained head candidate is staged under ~/.pi/mega-compact-encoder/candidates/, the five heads serve the trained weights. OFF = no candidate is loaded, the heads serve byte-identical ENC-0b survivor defaults.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_0D",
			"ENC-0d Real-Asset Promotion Gate",
			"ENC-0d promotion gate over real trained assets: accepts a {color} real candidate manifest (the ENC-0c trained head weights + the ENC-0b trunk), digest-verifies every staged byte, and atomically swaps the shipped manifest to a green candidate with rollback-to-previous on qualification failure. OFF = accepts no candidate, swaps nothing, emits nothing, shipped manifest stays at the ENC-0c survivor.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_0E",
			"ENC-0e darwin-x64 Demotion Reason",
			"ENC-0e darwin-x64 explicit demotion: on an Intel Mac the runtime demotes to WASM (no native binary upstream); this surfaces a deterministic reason on the runtime-selection event and the Setup Cortex blockers card so an operator sees why mode A is unreachable. OFF = no demotion reason on the event and no Setup card row (the ML5-C WASM demotion itself remains the default, byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_0F",
			"ENC-0f p95 + marginal-RSS Qualification Gate",
			"ENC-0f p95 + marginal-RSS qualification gate (real trained asset → mode A): runs the ENC-0d-promoted trained asset through the bench under --expose-gc, asserts p95 ≤ 40 ms @ 512/4 threads, marginal RSS ≤ 150 MiB (baseline-subtracted), determinism, and opset-21; on pass emits QualificationV1 + flips runtime to qualified mode A, on failure asset stays demoted to mode B. OFF = no qualification gate runs, no QualificationV1 written, runtime keeps serving the ENC-0d survivor (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_0G",
			"ENC-0g Setup Cortex honest state (verdict override + live blockers)",
			"ENC-0g makes the Setup Cortex status route honest: reads the ENC-0f QualificationV1 record (when ENC_0F is ON and a record exists) and lets its verdict override the structural verify for the qualification field; computes the blocker list from (platform, record, manifest head-count) with corrected HG statuses/wording; re-derives VC9B action gating from live blockers. OFF = verdict from verifyEncoderAsset alone, static SETUP_CORTEX_BLOCKERS, static action gating (byte-identical ENC-0f predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_1A",
			"ENC-1a external embedder API key + endpoint Settings fields",
			"ENC-1a adds a Settings-visible field pair for the external embedder endpoint URL + optional Bearer API key, persisted by the setup-configure writer branch to the per-repo .mega-compact.env (MEGACOMPACT_EMBEDDING_URL / MEGACOMPACT_EMBEDDING_KEY). The GET status route echoes the endpoint URL and reports embeddingApiKeySet as a boolean ONLY — the raw key is never returned. OFF = no new GET fields, no writer branch, no new Settings text rows (byte-identical ENC-0g predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_1B",
			"ENC-1b ONNX runtime backend + embedder API settings",
			"ENC-1b completes the embedder API Settings surface (dim / headers / allow-remote persisted to the per-repo .mega-compact.env) and surfaces the ONNX runtime selection knob (MEGACOMPACT_ENCODER_NATIVE) as a toggle plus the current effective backend + demotion reason. OFF = no new GET fields, no writer branch, no new Settings rows or toggle (byte-identical ENC-1a predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_2BUDGET",
			"ENC-2a operator-configurable native install-budget knob",
			"ENC-2a exposes the runtime operator knob MEGACOMPACT_NATIVE_ORT_BUDGET_MIB (default 300 MiB, clamp 8192) as a dashboard Settings field. The knob gates budgetOk in the encoder runtime decision (decision.ts installBudgetMib + runtime-select.ts selectRuntimeBackend). Persisted to the per-repo .mega-compact.env via the setup-configure writer branch; the GET status route surfaces the persisted value AND the effective integer installBudgetMib() resolves to (so the dashboard shows the runtime's actual operand). OFF = no new GET fields, no writer branch, no new Settings rows (byte-identical ENC-1b predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_2A",
			"ENC-2a native onnxruntime install GUIDE (detect + copy-paste)",
			"ENC-2a surfaces the platform-matched native onnxruntime install-guide (three copy-paste steps + script path) on the Setup Cortex sub-tab when the operator opted into the native backend but the effective runtime is still wasm (onnxruntime-node absent). Pure guidance — the extension NEVER executes or fetches (PREVENT-PI-004 unchanged); the committed operator script scripts/encoder/install-native-ort.mjs runs in the USER's shell. OFF = no guide GET fields, no guide-request POST branch, no install card (byte-identical ENC-1b predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_ENC_2B",
			"ENC-2b native ONNX runtime qualification retest (detect + re-qualify)",
			"ENC-2b re-probes and re-qualifies the installed native onnxruntime binding (onnxruntime-node in ~/.pi/mega-compact/native-ort/, operator-installed via the ENC-2a guide): loads the LOCAL on-disk binding, runs a bounded warmup + p95 probe, measures RSS, and computes a fresh qualification verdict against the ENC-0f p95 budget + the operator install-budget. Never downloads or trains (PREVENT-PI-004 / HG-1 unchanged); surfaces nativeOrtRetestResult + nativeOrtBackendEffective on the GET /api/setup-status. OFF = no retest GET fields, no retest POST branch, no retest card (byte-identical ENC-2a predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_COSINE_FP_BENCH",
			"COS-FP-A Synthetic FP Bench",
			"Synthetic FP harness + L2 cosine threshold calibration (COS-FP-A): drives the deterministic synthetic-corpus grid sweep (scripts/cosine-fp/bench.mjs) that measures L2 cosine false-positive rates and emits a recommended default, and serves the reader-only GET /api/cosine-fp-report. Synthetic-corpus-only — never reads real session/ledger bytes. OFF = bench inert, endpoint 404s, no report write, L2_COSINE plain MEGACOMPACT_L2_THRESHOLD (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_COSINE_FP_REAL",
			"COS-FP-R Real-Corpus Validation",
			"Real-corpus L2 cosine FP validation (COS-FP-R): runs the real-corpus grid sweep (scripts/cosine-fp/real-bench.mjs) against donated, consent-approved sessions only (SECURITY_PRIVACY Lifecycle/Consent), scoring FP/FN with Wilson intervals + session-grouped bootstrap, and appends CI-backed per-content-type recommendations to the cosine-threshold report. Runs only when a valid consented corpus exists; absent corpus = no_corpus (normative pre-donation state, nothing written). OFF = script inert, nothing executes, no writes (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_REPO_CORPUS",
			"Cross-Repo Corpus (REPO-A)",
			"Cross-repo corpus preparation (REPO-A): the governed, consent-gated reader-only path that builds a pseudonymous corpus manifest from per-repo events.log slices and serves GET /api/repo-corpus answering which pseudonymous repos/sessions are in the corpus, what cross-repo overlap exists, and whether consent is active for each — counts + IDs + status only, never payload content. Consent is append-only (consent.mjs, CLI/ops-only); revocation freezes the builder + route. OFF = builder refuses to run, reader route 404s, single-repo recall untouched (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_DASH_0A",
			"Dashboard Consolidation — Tab Plan",
			"DASH-0a dashboard tab-audit + consolidation merge plan: records (as typed constants) the collapse of the 13 current TabIds onto the fixed 7 navigational surfaces (Overview, Sessions, Cache+Performance, Memory Graph, Diagnostics, Setup, Admin), plus the deep-link map, a11y nav-map, and responsive plan. Contract-planning only — no component moves, no route change. OFF = the plan module is inert (never imported by the shell); all 13 tab/section top-level files render exactly as today (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_DASH_0B",
			"Dashboard Consolidation — Sessions/Cortex sections",
			"DASH-0b dashboard consolidation execution: (1) the Sessions surface absorbs TurnsTab as a drill-down — a SessionsViews toggle renders the existent session summary/chart/table or the turns view (TurnMemoryView); (2) VectorCortexTab re-groups its flat 14-card layout under 4 <section aria-labelledby> headers (Cortex status / repair / cache / adaptive). OFF = SessionsTab renders only its own body (no toggle, no TurnMemoryView) and VectorCortexTab keeps its flat card layout (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_DASH_0C",
			"Dashboard Consolidation — Cache+Performance / Admin",
			"DASH-0c dashboard consolidation execution: (1) the Cache surface absorbs MetricsTab as a Performance section (CacheTab label becomes 'Cache+Performance'); (2) MaintenanceTab + ConfigTab combine under a new AdminTab delegate-shell with an AdminViews toggle (maintenance/config), and SetupTab hides its Config sub-tab. OFF = CacheTab renders only its cache sections, MetricsTab/MaintenanceTab/ConfigTab render as standalone surfaces, SetupTab keeps its Config sub-tab (byte-identical predecessor).",
			true,
		),
		boolDirect(
			"MEGACOMPACT_DASH_0D",
			"Dashboard Consolidation — Rollup / 7-surface",
			"DASH-0d dashboard consolidation roll-up: App.tsx consolidates its lazy list + TabContent switch onto the 7 fixed navigational surfaces (Overview, Sessions, Cache+Performance, Memory Graph, Diagnostics, Setup, Admin) with an additive hash→surface deep-link router; the duplicate TurnsTab/MetricsTab indirection bodies are reconciled to their canonical homes. OFF = App.tsx reproduces the pre-rollup 13-tab surface set byte-identically (byte-identical DASH-0c predecessor).",
			true,
		),
	],
};

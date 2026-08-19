/**
 * mega-config-types.ts — MegaConfig type-only declarations for the extension.
 *
 * Split out of mega-config.ts (delegate-shell) so the runtime barrel stays under
 * the extensions/ soft line limit. Type-only file: no runtime code, no logic.
 * `import type` keeps the only cross-reference (CompactTier) erased at build,
 * so there is no runtime import cycle.
 */
import type { CompactTier } from "./mega-config.js";

/**
 * Resolved, frozen-at-load config. `tier` is the base compaction PRESET chosen
 * by env (low/medium/high/ultra/mega) — it sets the threshold token budget and
 * is NOT changed at runtime (the /mega-tier command was removed in S24). The
 * *displayed* tier the user sees in the toolbar/dashboard is the LIVE pressure
 * band (see MegaRuntime.pressureBand), which climbs low→mega as context fills.
 */
export interface MegaConfig {
	tier: CompactTier | "custom";
	/**
	 * Compaction threshold as a fraction of the model context window (e.g. 0.70
	 * for "high"). null for `custom` (explicit MEGACOMPACT_THRESHOLD_TOKENS, which
	 * stays an ABSOLUTE token count, never percent-scaled).
	 */
	tierPct: number | null;
	thresholdTokens: number;
	stateDir: string;
	fastGatePct: number;
	anchorUserMessages: number;
	preserveRecent: number;
	/** High-pressure floor for preserveRecent — when context is near the limit
	 *  we compact deeper, but never below this (keeps recent turns for coherence). */
	preserveRecentMin: number;
	/** D.1: minimum context-growth percentage delta before re-compacting instead of
	 *  replaying the cached trim (Default 50). Set via MEGACOMPACT_RECOMPACT_PCT_DELTA.*/
	recompactPctDelta: number;
	auto: boolean;
	autoInline: boolean;
	autoInlineK: number;
	/** S28: auto-continue the agent after a max-output-token length stop by
	 *  reusing the existing S16 resume-nudge. Default true. Off = silent (the
	 *  prior behavior). PREVENT-PI-003: restart via user-role sendUserMessage. */
	autoContinueLengthStop: boolean;
	/** S38: max retries for transient errors (5xx/429/network/max-output-token
	 *  text that is NOT a length stopReason — S28 owns those). Default 5.
	 *  `0` disables all transient retries (reverts to S28-only). */
	autoRetryTransientMax: number;
	/** S38: max retries for permanent errors (auth/config/malformed). Default 1.
	 *  `0` disables permanent-error retries. */
	autoRetryPermanentMax: number;
	/** S38.5: strict race-guard — 30s cooldown + deferred ctx.compact() re-check
	 *  (closes the first-race-in-burst window). Default true. `false` reverts to
	 *  the v0.7.4 synchronous 10s-cooldown behavior. */
	raceGuardStrict: boolean;
	/** S38.6: max consecutive errors before circuit-breaker trips (stops retrying).
	 *  Default 10. When `errorRetryCount` exceeds this across multiple turns,
	 *  the extension stops retrying until a successful turn resets it. */
	maxConsecutiveErrors: number;
	/** S38.7: hard-stop switch — when true, ALL error retries are disabled.
	 *  Default false. Set via env to force S28-only behavior (length-stop continues
	 *  only). */
	errorRetryHardStop: boolean;
	/** R1 (retry redesign): base unit (ms) for errorRetryBackoffMs(count) pacing.
	 *  The schedule is base, 2*base, 4*base, 6*base (cap) — so the default 5000
	 *  yields 5s/10s/20s/30s. errorRetryUntil is now GATING (previously it was
	 *  documented as non-gating); a nudge cannot fire before errorRetryUntil
	 *  elapses. */
	errorRetryBackoffMs: number;
	/** R2: session-global cap on total S38 nudges across ALL bursts. Hitting it
	 *  is terminal for the session — the extension stops nudging entirely,
	 *  independent of the per-burst max and the circuit breaker. Default 3.
	 *  `0` disables (reverts to per-burst + circuit-breaker only). */
	errorRetrySessionMax: number;
	/** R3: consecutive identical error-text count at which a 'transient'
	 *  classification is upgraded to 'poisoned-context' (the stateful repeat
	 *  signal). Default 3. Raise to make the upgrade less aggressive. */
	poisonedContextRepeatThreshold: number;
	/** R10: consecutive transient errors at which a calm "provider outage"
	 *  advisory is sent to the user (distinct from the poisoned /clear advise).
	 *  Default 3. `0` disables the advisory entirely. */
	providerOutageAdviseThreshold: number;
	/** R13: when true (default), poisoned-context and provider-outage advisories
	 *  are dashboard-only (events tab + log) — no user-visible message injection.
	 *  When false, the legacy sendUserMessage path runs (byte-identical pre-R13). */
	advisoryChannel: boolean;
	/** S29: override the auto-compact fire point for tiered configs, as a
	 *  fraction of the context window (e.g. 0.85). null = inherit the tier's
	 *  tierPct (default; preserves existing fire points). The context-handler
	 *  gate fires on context % (reliable), not token count (under-reported),
	 *  so it catches the overshoot that causes max-output-token truncation.
	 *  `custom` (tierPct null) ignores this — it keeps the absolute token gate. */
	autoPctTrigger: number | null;
	dedupSim: number;
	/** RAPTOR hierarchical recall enabled (Fix D). Drives both live recall and
	 *  the durable-trim summary source (root summary). */
	raptorEnabled: boolean;
	/** Legacy v0.4.28 behavior: auto-trigger calls ctx.compact() (which STOPS
	 *  the agent). Default false — the S16 redesign uses the live context-event
	 *  trim + pi native auto-compaction instead (compact and continue). Kept for
	 *  one release as rollback. */
	legacyDurableTrim: boolean;
	/** S27: durable raw-transcript DB mirror (MEGACOMPACT_DB_MIRROR). When on,
	 *  raw message bytes + checkpoint-epoch bookkeeping are appended to the
	 *  SQLite store so a compacted window can be rehydrated locally instead of
	 *  from the pi runtime transcript. Default OFF — additive, no behavior
	 *  change until flipped on. legacyDurableTrim takes precedence (the legacy
	 *  v0.4.28 ctx.compact() path does not emit the S27 mirror hook). */
	dbMirror: boolean;
	/** S49: isolated per-turn store (turns.db). Default ON. OFF = legacy main-db
	 *  turn path (S48 behavior — byte-identical). Mirrors TurnsConfig.TURNS_DB_ENABLED. */
	turnsDbEnabled: boolean;
	/** S51: auto-categorizing wiki (k-means + TF-IDF over real embeddings). Default ON.
	 *  Mirrors TurnsConfig.AUTO_WIKI_ENABLED. Rebuild fires every Nth compaction. */
	autoWikiEnabled: boolean;
	/** Cross-repo recall enabled (S17). Resume + /mega-recall --cross-repo can
	 *  pull checkpoints from OTHER repos via the PGlite HNSW index. Default true. */
	crossRepoEnabled: boolean;
	/** Stricter cosine floor for cross-repo hits (S17). Default 0.90 (trigram) /
	 *  tighter than same-repo so only genuinely-relevant cross-repo context is
	 *  injected. */
	crossRepoCosine: number;
	/** Same-repo recall cosine floor (3WF-3). Default 0.12. SEPARATE from
	 *  `crossRepoCosine` (S17, default 0.90 — stricter, cross-repo only). The
	 *  3-source validator applies this to the top winner; hits below it are
	 *  rejected in favor of the next-ranked candidate or the provenance floor. */
	recallMinCosine: number;
	/** Memory-RAG auto-review enabled (S20). Every memoryReviewInterval turns the
	 *  conversation is auto-reviewed into durable add/replace/remove memories. */
	memoryAutoReview: boolean;
	/** Turn cadence for the auto-review scan (S20). Default 10. */
	memoryReviewInterval: number;
	/** Token ceiling for the re-injected recall block (Fix C). Recall stops
	 *  adding checkpoints once the block would exceed this — bounds read-path
	 *  token cost so it can never net-inflate the window. */
	recallMaxTokens: number;
	/** Phase H: output-error catch. When a model response is truncated mid-OUTPUT
	 *  (S28 stopReason==='length' — "Response was truncated before completion"),
	 *  trip a one-shot forced compaction on the next gate so the model's NEXT
	 *  response has freed input headroom. This closes the small-context-model
	 *  deadlock where the model truncates BELOW the 80% INPUT threshold (so the
	 *  gate never fires → "compact never" → every subsequent response truncates
	 *  too). Default ON; OFF (=0/`=false`) = byte-identical pre-H. */
	outputErrorCompact: boolean;
	/** v0.21.9: output-headroom gate. Fire compaction BEFORE the request
	 *  overflows the model window — when
	 *  `currentTokens + outputReserve + safetyMargin >= contextWindow` —
	 *  instead of waiting for the percent/token fire point (which judges only
	 *  INPUT and never trips on small-window models whose output reserve is a
	 *  large fraction of the window: a 32k window with a 20k maxTokens
	 *  overflows at ~37% INPUT). Percent-based by construction: the reserve is
	 *  a fraction of the model's own window, so the math is identical at every
	 *  window size (32k, 64k, 200k, 1M, 5M). Default ON; OFF (=0/`=false`)
	 *  disables ONLY the pre-fire gate check (the gate reverts to the
	 *  input-only pre-v0.21.9 judgment). NOTE: the shared tail-cap hardenings
	 *  this fix introduced — pair-safe front-drop (the pre-v0.21.9 cap could
	 *  split a toolCall/toolResult pair, PREVENT-PI-002) and the budget floor
	 *  (the old cap silently disabled itself when the reserve exceeded the
	 *  window) — are UNCONDITIONAL guardrail fixes and apply regardless of
	 *  this flag. Headroom-triggered fires are EXEMPT from the ThrashGuard
	 *  (an overflowed session is unrecoverable). */
	overflowHeadroom: boolean;
	/** v0.21.9: fallback output reserve as a fraction of the context window
	 *  when the model's declared maxTokens is absent or implausible (0, or the
	 *  models.json sentinels 1e9/1e38, or >= the window). Clamped [0.1, 0.95];
	 *  default 0.30 (30% of the window). When maxTokens is plausible the
	 *  declared value wins — vLLM-style backends reserve the FULL declared
	 *  maxTokens against the context window, so the reserve must match it. */
	outputReservePct: number;
	/** Inline-dedupe recalled checkpoints against the live window (Fix C): drop
	 *  a hit whose summary is ≥ dedupSim similar to a live message — "dedupe on
	 *  inline/read" so we never re-inject context already resident. */
	windowDedupe: boolean;
	/** S53: Recall Tail Injection — inject staged recall block as a user message at
	 *  the tail of the view when auto is OFF AND no trim action is needed. Default ON
	 *  (true). When false, restores the pre-sprint systemPrompt prepend behavior. */
	recallTailInject: boolean;
	/** 3WF-1: TriggerGuard — re-stage a recall block at the context event seam when
	 *  session_start never fired, so every session has a staged block (recall hits,
	 *  else a provenance floor). Default ON; OFF = byte-identical pre-sprint. */
	threeWayFailback: boolean;
	/** 3WF-2: ThrashGuard re-arm budget as a FRACTION of `effectiveThreshold`.
	 *  After an ineffective compaction (live window did not shrink), the guard
	 *  refuses to re-fire until the live window has grown by at least
	 *  `rearmPct × effectiveThreshold` tokens past the observed baseline. Default
	 *  0.10 (10% of the effective threshold). Env-overridable via
	 *  MEGACOMPACT_THRASH_REARM_PCT. When the effective threshold is unknown
	 *  (+Infinity), the guard skips arming (cannot compute N) and logs instead. */
	thrashRearmPct: number;
	/** A1 PLAN_V2 Phase 2: Message Separation — isolate user/assistant turns
	 *  from volatile tool results so the prompt-cache prefix stays stable.
	 *  PC-A: positive sprint flag, now default ON; flag-OFF (=0) is byte-identical
	 *  to the pre-change OFF state. The single gate lives at the call site
	 *  (tailResult.ts, config.messageSeparation), not inside buildSeparatedPrompt. */
	messageSeparation: boolean;
	/** Sprint A: Mega↔ithacus bridge — gate the child extension + bridge usage
	 *  that tie this extension to ithacus's durable compaction. Positive sprint
	 *  flag, default ON; flag-OFF (=0/`=false`) is byte-identical to pre-bridge
	 *  behavior (the bridge is only consulted when this is ON). */
	ithacusBridge: boolean;
	/** P3: Cache-aware striping (PLAN_V2 Phase 3). Inserts stability-ordered
	 *  cache stripes between summaries and thread. Default OFF. */
	cacheStriping: boolean;
	debug: boolean;
	/** Master reconciliation: TUI shutdown widget (MEGACOMPACT_TUI_WIDGET=0 to disable). */
	tuiWidget: boolean;
	/** S57 B1: Query reformulation via embedding-neighbor keyword expansion. */
	ragQueryReformulation: boolean;
	/** S57 B2: Tiered recall router (L0 cache -> L1 FTS5 -> L2). */
	ragTieredRouter: boolean;
	/** S57 B3: Recall quality metrics (precision/recall scoring + logging). */
	ragRecallMetrics: boolean;
	/** S57 B4: Memory graph traversal (dashboard-oriented). */
	ragMemoryGraph: boolean;
	/** D1: Seed initial wiki topic model from live turns when no context_chunks exist yet. */
	wikiSeedFromTurns: boolean;
	/** D3 Source A: Include structural turn nodes in the memory graph (metadata only, no content). */
	memoryGraphSeedTurns: boolean;
	/** D3 Source B: Include raw_transcript content nodes in the memory graph (requires dbMirror). */
	memoryGraphSeedTurnContent: boolean;
	/** D3 Source C: Include memory review nodes in the memory graph. */
	memoryGraphSeedMemories: boolean;
	/** D3 edges: Stricter cosine floor for cross-type edges (e.g. turn↔checkpoint). */
	memoryGraphCrossTypeThreshold: number;
	/** D3 edges: Cosine floor for within-type semantic edges. */
	memoryGraphWithinTypeThreshold: number;
	/** v0.12: Context health monitoring (drift + output quality + cache poison). Default ON. */
	contextHealth: boolean;
	/** Sub-flag: drift detection (topic drift + error escalation + prefix instability). */
	contextHealthDrift: boolean;
	/** Sub-flag: output quality analysis (repetition, coherence, token salad). */
	contextHealthOutputQuality: boolean;
	/** Sub-flag: tri-layer KV cache poison validation. */
	contextHealthCachePoison: boolean;
	/** v0.12: KV cache poison mitigation — inject prefix break on mismatch. Default OFF. */
	contextHealthMitigate: boolean;
}

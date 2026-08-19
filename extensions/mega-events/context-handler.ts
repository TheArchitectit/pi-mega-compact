/**
 * mega-events/context-handler.ts — the context event handler (auto-trigger).
 *
 * Delegate-shell (extensions split): handles the live-trim compaction pipeline —
 * DB-mirror append, fast-gate threshold check, replay/debounce, pipeline
 * invocation, legacy durable compact, and the live-trim message reconstruction
 * that feeds pi's transformContext. The extracted pieces live in ./context-handler/:
 *  - messageText.ts    (messageContentText — best-effort text extraction)
 *  - tailResult.ts     (buildTailResult — recall-tail injection factory)
 *  - afterCompact.ts   (persistEpochAndMaintain — epoch/wiki/seed/dedup writes)
 *  - dbMirrorAppend.ts (appendMirrorAndLedger — mirror + VC1B ledger append)
 *  - gateCheck.ts      (evaluateGate — S29 fast-gate threshold evaluation)
 *  - pipelineRun.ts    (invokePipeline — adaptive-compression runCompact)
 *  - liveTrim.ts       (buildLiveTrimView — S16 live-trim reconstruction + cap)
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ContextEvent,
} from "@earendil-works/pi-coding-agent";
import { estimateSessionTokens } from "../../src/tokens.js";
import type { MegaRuntime } from "../mega-runtime.js";
import { piCompactWouldNoop } from "../mega-pipeline.js";
import type { MegaConfig } from "../mega-config.js";
import { buildTailResult } from "./context-handler/tailResult.js";
import { runTriggerGuard } from "./context-handler/triggerGuard.js";
import { confirmInjection } from "./context-handler/injectionConfirm.js";
import { persistEpochAndMaintain } from "./context-handler/afterCompact.js";
import { appendMirrorAndLedger } from "./context-handler/dbMirrorAppend.js";
import { evaluateGate, thrashGuardBlocks } from "./context-handler/gateCheck.js";
import {
	markCompactionFired,
	evaluatePendingReduction,
} from "./context-handler/thrashGuard.js";
import { invokePipeline } from "./context-handler/pipelineRun.js";
import { buildLiveTrimView } from "./context-handler/liveTrim.js";

/** Register the context event handler (live-trim auto-trigger). */
export function registerContextHandler(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// ---- Auto-trigger: live trim (compact and continue) + native durable ----
	// S16 redesign: we NO LONGER call ctx.compact() from the auto-trigger by
	// default. That mapped to pi's MANUAL compaction path, which abort()s the
	// in-flight turn (agent-session.js:1345) and stops the agent. Instead:
	//  - LIVE: return { messages: trimmedView } from the context event. This
	//    feeds pi's transformContext (sdk.js:226 → agent-loop.js:180) so the
	//    model sees a compacted window EVERY LLM call, with no abort. The turn
	//    continues. We persist our recall checkpoint (the durable value) first.
	//  - DURABLE: pi's NATIVE auto-compaction fires at agent-end
	//    (agent-session.js:1565), continues (return hasQueuedMessages()), and
	//    emits session_before_compact — where OUR driveNativeCompaction supplies
	//    the summary and pi truncates the transcript on disk. No ctx.compact().
	// Legacy: MEGACOMPACT_LEGACY_DURABLE_TRIM=true restores the v0.4.28 ctx.compact
	// path (kept one release as rollback).
	pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const pct = usage?.percent;
		const messages = event.messages;
		// 3WF-1 TriggerGuard: guarantee a staged recall block on this event even
		// when session_start never fired. One-shot per session; a block already
		// staged by session_start takes precedence (no-op). Run BEFORE building the
		// tail factory so a freshly staged block is composed into THIS event's view.
		// Best-effort — a failure falls through to the pre-sprint path.
		try {
			runTriggerGuard(runtime, config, ctx);
		} catch {
			/* non-fatal */
		}
		// S53: helper to inject the staged recall/memory block as a user-role
		// tail message at any view-return point. Returns undefined when nothing
		// is staged (or the flag is OFF) so the caller falls through to its
		// normal return.
		const composeTail = buildTailResult(runtime, config, messages);
		// 3WF-4 InjectionConfirm: wrap the tail factory so EVERY return point of
		// this handler (gate / replay / debounce / thrash-guard / pipeline /
		// live-trim) is verified — the staged block's marker must be present in
		// the message list pi will send (tail mode), else we re-compose from the
		// runtime's pending blocks and finally fall back to the shared floor.
		// A composition that yields nothing staged (undefined) is passed through
		// untouched, so flag-OFF and no-recall paths are byte-identical.
		const tailResult: typeof composeTail = config.threeWayFailback
			? (msgs) => {
					const view = composeTail(msgs);
					if (!view) return view;
					return confirmInjection(runtime, config, view, ctx.sessionManager.getSessionId());
				}
			: composeTail;
		// Always track context for the dashboard/widget, even when auto is off.
		// (v0.8 regression: !config.auto gate sat above this, leaving ctx stats
		// null -> widget '?% / ?/?' when auto disabled. Track first, THEN gate.)
		// S40 fix: fall back to estimateSessionTokens(view) when the provider
		// doesn't report tokens (e.g. plexus / claude-mythos-5 via OpenRouter).
		// Without this, lastCtxTokens is null -> appendTokenSample (S39) never
		// fires -> Sessions chart + Overview per-repo stack + ContextGauge all
		// show empty/zero. Compute view lazily only when the fallback is needed
		// (at most one engineView call per context event; when auto is on and
		// usage.tokens is present, view is computed once below via reuse).
		const viewForFallback =
			usage?.tokens == null ? runtime.engineView(messages) : null;
		const currentTokens =
			usage?.tokens ??
			(viewForFallback != null
				? estimateSessionTokens(viewForFallback)
				: null) ??
			Math.round(((pct ?? 0) / 100) * (usage?.contextWindow ?? 0));
		runtime.lastCtxTokens = currentTokens ?? null;
		// 3WF-2: consume a pending live-window delta from a prior compaction. If a
		// compaction fired on the previous context event and the live window did
		// not shrink, this arms the ThrashGuard (meta). No-op when none pending.
		try {
			evaluatePendingReduction(runtime, currentTokens ?? 0, config);
		} catch {
			/* non-fatal */
		}
		runtime.lastCtxPercent = pct ?? null;
		// Resolve the model window used by the token gate + live-trim tail-cap.
		// Prefer the provider-reported usage window (authoritative when present);
		// fall back to the captured model snapshot's contextWindow (populated from
		// models.json / pi's model registry) when the provider does not report it
		// via getContextUsage(). plexus (OpenAI-compatible) omits contextWindow in
		// usage, so without this fallback lastCtxWindow is 0 for those providers —
		// which silently disables the live-trim tail-cap (guarded on ctxWindow>0)
		// and the token-gate window math, so mega-compact never reserves output
		// headroom and a 32k model's own output overflows the window each turn.
		// Mirrors the gate's existing pct fallback (gateCheck.ts S27).
		const reportedWindow = usage?.contextWindow ?? 0;
		runtime.lastCtxWindow =
			reportedWindow > 0
				? reportedWindow
				: (runtime.currentModel?.contextWindow ?? 0);
		runtime.snapshot(ctx);
		if (!config.auto) {
			const tailed = tailResult();
			if (tailed) return tailed;
			return;
		}

		const view = viewForFallback ?? runtime.engineView(messages);

		// S27 DB-mirror + VC1B ledger append. Runs BEFORE the fast-gate so every
		// message is captured, even if we don't compact this turn. Non-fatal.
		appendMirrorAndLedger(runtime, config, messages);

		// S29 FAST GATE: drive the auto-trigger off the context percent (see
		// gateCheck.ts). Returns a tailed view when the gate does not pass.
		const gate = evaluateGate(runtime, config, { pct, currentTokens, tailResult });
		if (gate.kind === "return") return gate.view;

		// D.2: Replay MUST be exempt from debounce — replay is free (no compute,
		// no re-write) and prevents unnecessary KV-cache invalidation. Check
		// replay FIRST, before debounce, so two context events <2s apart both
		// return the cached sentinel verbatim (re-stabilises the provider prefix).
		//
		// v0.8.6 cache-stability: replay the cached trim view when still in the
		// same compaction epoch AND context hasn't grown enough to warrant a
		// re-compact. Re-compact only when context grew >=config.recompactPctDelta%
		// of the window (percent basis) or >=50% of the effective threshold
		// (token basis, when percent is unavailable). The cached `cut` is only
		// valid while the transcript grows within the epoch — it is cleared on
		// session_compact (durable truncation) + resetRuntime, so we never replay
		// a stale cut into a truncated transcript (PREVENT-PI-001/002).
		if (
			runtime.trimCache &&
			runtime.trimCache.checkpointId === runtime.rt.lastCheckpointId &&
			runtime.trimCache.cut <= messages.length
		) {
			const grewEnough =
				pct != null && runtime.trimCache.ctxPct != null
					? pct - runtime.trimCache.ctxPct >= config.recompactPctDelta
					: currentTokens - (runtime.trimCache.ctxTokens ?? 0) >=
						runtime.effectiveThreshold * 0.5;
			if (!grewEnough) {
				const recent = messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002: cached `cut` was sanitized once by computeLiveTrimCut (src/boundary.ts) and replayed verbatim; the transcript only grows within an epoch (cache is cleared on durable truncation), so the preserved run still starts on a toolPair-safe index.
				runtime.diagLiveTrimFires++; // trim view returned this call (replay counts as a fire)
				runtime.diagLiveTrimReplays++;
				runtime.snapshot(ctx);
				// v0.8.7: shallow-copy the cached summary so pi's transformContext can't
				// mutate the shared reference across replays (audit P3).
				const replayView = [
					{ ...runtime.trimCache.summaryAgentMsg },
					...recent,
				];
				return tailResult(replayView) ?? { messages: replayView };
			}
			// else: context grew enough → fall through to re-compact (cache is stale)
		}

		// 3WF-2 ThrashGuard: refuse a NEW compaction while armed (an ineffective
		// prior compaction left the live window unshrunk). Sits AFTER the replay
		// block — replay is free and must stay exempt — and BEFORE debounce +
		// invokePipeline (the real fire point), so it covers the percent + token
		// gate paths alike. Umbrella OFF ⇒ never blocks (byte-identical). Returns
		// the tailed view so a staged recall block still rides along.
		if (thrashGuardBlocks(runtime, config, currentTokens)) {
			runtime.diagCtxFastGate++;
			runtime.snapshot(ctx);
			return tailResult() ?? undefined;
		}

		// Debounce so we don't fire on every context event past threshold.
		// (Replay already returned above — only fresh compacts reach this point.)
		const now = Date.now();
		if (now < runtime.debounceUntil) {
			runtime.diagCtxDebounce++;
			return tailResult() ?? undefined;
		}
		runtime.debounceUntil = now + 2000;

		// Adaptive-compression pipeline invocation (see pipelineRun.ts). Returns a
		// tailed view ("return") when compaction skipped; otherwise "proceed" with
		// the result + pressure consumed by the live-trim stage below.
		const pipeline = invokePipeline(pi, runtime, config, ctx, {
			messages,
			pct,
			currentTokens,
			tailResult,
		});
		if (pipeline.kind === "return") return pipeline.view;

		// S27 DB-mirror: write checkpoint_epoch + stamp turn epochs + auto-wiki +
		// topic seed + fire-and-forget dedup. Best-effort + non-fatal.
		await persistEpochAndMaintain(runtime, config, pipeline.ran);

		// 3WF-2: record the live-window baseline at the moment a compaction actually
		// fired, so the NEXT context event can judge whether the window shrank. We
		// use the LIVE currentTokens here (not ran.saved — that is the false
		// stored-checkpoint metric the thrash bug used), matching the spec's
		// "value observed just BEFORE that compaction fired" seam.
		try {
			markCompactionFired(runtime, currentTokens ?? 0);
		} catch {
			/* non-fatal */
		}

		// LEGACY path (rollback): v0.4.28 ctx.compact() + the no-op gate. The
		// manual compact path aborts the in-flight turn — only used behind the flag.
		// Read live from env (in addition to the load-time config) so the flag can be
		// toggled per-test without reloading the module; config.legacyDurableTrim is
		// the cached default. (Mirrors how piCompactWouldNoop re-reads its floor.)
		const legacy =
			config.legacyDurableTrim ||
			process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM === "true" ||
			process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM === "1";
		if (legacy) {
			// COMPACT-DEDUP FIX: same race guard as the agent_end path. Skip when a
			// NATIVE compaction just fired (avoids racing pi and surfacing a spurious
			// "Already compacted" / "Nothing to compact" toast). Uses lastNativeCompactAt
			// (NOT lastCompactAt, which runCompact also stamps for our own checkpoint).
			// S38.5: strict race guard widens the cooldown 10s -> 30s (gated by
			// MEGACOMPACT_RACE_GUARD_STRICT; false reverts to v0.7.4 10s).
			const cooldownMs = config.raceGuardStrict ? 30_000 : 10_000;
			const sinceCompact = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
			if (sinceCompact < cooldownMs || piCompactWouldNoop(ctx)) return;
			// S38.5: defer ctx.compact() with a re-check so pi's about-to-run native
			// _checkCompaction can append its `compaction` branch entry first (closes
			// the first-race-in-burst window). setTimeout(500) — pi's compaction-summary
			// append is async I/O, so queueMicrotask would re-check before it lands.
			// Non-strict (v0.7.4) keeps the synchronous call.
			if (config.raceGuardStrict) {
				const stamp = runtime.rt.lastNativeCompactAt;
				const liveSid = runtime.rt.sessionId;
				setTimeout(() => {
					try {
						if (runtime.rt.sessionId !== liveSid) return; // session reset
						const since2 = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
						if (runtime.rt.lastNativeCompactAt !== stamp && since2 < cooldownMs)
							return;
						if (piCompactWouldNoop(ctx)) return;
						ctx.compact({
							customInstructions: undefined,
						}); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; deferred + re-validated.
					} catch {
						/* non-fatal */
					}
				}, 500);
			} else {
				ctx.compact({
					customInstructions: undefined,
				}); // race-guarded by lastNativeCompactAt cooldown (ctx.compact returns void → not catchable; the cooldown prevents the call)
			}
			return;
		}

		// S16 LIVE trim: collapse the compacted region to a summary + recent anchor.
		// See liveTrim.ts. Non-destructive: pi keeps the real transcript; only this
		// LLM call sees the trimmed window. Returns undefined on unsafe cut/throw —
		// the next context event retries.
		return buildLiveTrimView(runtime, config, ctx, {
			messages,
			view,
			pct,
			currentTokens,
			usageTokens: usage?.tokens,
			pressure: pipeline.pressure,
			ran: pipeline.ran,
			perModelThreshold: gate.perModelThreshold,
			tailResult,
		});
	});
}

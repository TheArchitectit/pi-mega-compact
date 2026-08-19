/**
 * dedup-audit.ts — durable audit trail for dedup tier decisions
 * (external-audit item #2).
 *
 * Before this module a tier decision existed only as the in-process `onTier`
 * callback that paints the live UI; nothing survived the process, so an
 * operator could not answer "which layer collapsed this region, onto what, at
 * what similarity?" — the inputs needed to tune the thresholds in
 * config/dedup.ts. Here each decision is appended to the repo's events.log as
 * one structured JSON line (see `DedupAuditEvent` below).
 *
 * The event type and its append helper live HERE rather than in monitoring.ts:
 * monitoring.ts already owns three concerns (decision events, the dashboard.json
 * metrics snapshot, FP alerting) and sits close to its 300-line soft limit, so
 * co-locating the shape with the only recorder that produces it keeps both files
 * under the headroom gate. monitoring.ts re-exports both for callers (and the
 * dashboard SSE tail) that treat it as the events.log barrel.
 *
 * Design constraints:
 *  - PURE INSTRUMENTATION. Nothing in this file may influence a dedup outcome.
 *  - Best-effort/non-fatal: `logDedupAudit` swallows IO errors, and the emitter
 *    itself is wrapped so a malformed field can never break add().
 *  - Honest fields only: a value is emitted only where the caller actually
 *    computed it. L0/L1 are hash/verify tiers and pass no `similarity`.
 *  - Signal, not chatter: callers emit on DECISIONS (a match, a scored
 *    candidate, the final outcome), never on every "scanning" transition.
 *  - Flag-gated by cfg.DEDUP_AUDIT (default ON; OFF writes nothing at all).
 *
 * PREVENT-PI-004: local filesystem append only, no network.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultEventsPath } from "../monitoring.js";

/**
 * One dedup decision, as persisted to events.log.
 *
 * `ts` is an ISO-8601 string (not the epoch millis DedupDecisionEvent uses):
 * the dashboard SSE tail only forwards lines carrying a `type` discriminator,
 * and its consumers parse the timestamp as a date. Optional fields are omitted
 * rather than nulled — a missing `similarity` means the tier computed no score,
 * which is itself the honest signal (L0/L1 are hash/verify tiers).
 */
export interface DedupAuditEvent {
	/** SSE discriminator — the dashboard streams only typed lines. */
	type: "dedup_audit";
	/** ISO-8601 decision timestamp. */
	ts: string;
	/** Normalized session the region belongs to. */
	sessionId: string;
	/** Which layer produced the decision ("new" = nothing collapsed). */
	tier: "L0" | "L1" | "L2" | "new";
	/** What the layer decided. `skipped` = matched but policy declined to collapse. */
	status: "deduped" | "passed" | "stored" | "skipped";
	/** Checkpoint the region collapsed onto, or the nearest one scored. */
	matchedEntry?: string;
	/** Checkpoint created, when the outcome was a new write. */
	storedEntry?: string;
	/** Cosine similarity — present only where a tier actually scored. */
	similarity?: number;
	/** Why the decision went the way it did (e.g. "contentHash", "mark_only"). */
	dedupReason?: string;
	/** Tokens the original region occupied before compaction. */
	originalTokenEstimate?: number;
	/** Tokens the stored summary occupies. */
	tokenEstimate?: number;
}

/**
 * Append one audit event to events.log (best-effort, never throws).
 *
 * Same append-one-JSON-line contract as monitoring.ts's logDecision — an
 * unwritable path is swallowed so instrumentation can never break add().
 */
export function logDedupAudit(path: string, ev: DedupAuditEvent): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(ev)}\n`, "utf-8");
	} catch {
		/* best-effort — never break the extension on a log failure */
	}
}

/** The slice of VectorStore the audit emitter reads. */
export interface DedupAuditContext {
	/** Per-repo state dir — resolves the events.log the dashboard tails. */
	readonly stateDir: string;
	/** Explicit events.log override (tests / the Sprint-14 monitoring opt-in). */
	readonly eventsPath?: string;
	/** Whether the audit trail is enabled (cfg.DEDUP_AUDIT). */
	readonly auditEnabled: boolean;
}

/** The decision payload a call site supplies; ts/type are filled in here. */
export type DedupAuditInput = Omit<DedupAuditEvent, "type" | "ts">;

/**
 * The per-add() facts every decision in one cascade shares: which session, and
 * the token accounting already computed by the caller.
 */
export interface DedupAuditScope {
	sessionId: string;
	/** Tokens the original region occupied (VectorStore.add's `origTokens`). */
	originalTokenEstimate?: number;
	/** Tokens the stored summary occupies (AddInput.tokenEstimate). */
	tokenEstimate?: number;
}

/**
 * A decision recorder bound to one add() cascade.
 *
 * `deduped` / `passed` / `stored` are the three shapes the cascade actually
 * produces; binding them here keeps VectorStore.add's call sites to one line
 * each (delegate-shell pattern) and keeps the field-honesty rules — which tier
 * may carry a similarity, matched vs. created id — in a single place.
 */
export interface DedupAuditRecorder {
	/** A tier collapsed the region onto `matchedEntry`. */
	deduped(
		tier: "L0" | "L1" | "L2",
		matchedEntry: string,
		dedupReason: string,
		similarity?: number,
	): void;
	/** A tier scored a candidate but did not collapse (threshold near-miss). */
	passed(
		tier: "L0" | "L1" | "L2",
		matchedEntry: string,
		similarity: number,
	): void;
	/**
	 * A tier MATCHED but policy declined the collapse (degenerate-match guard).
	 *
	 * Distinct from `passed`: the threshold WAS cleared, so this line is how an
	 * operator sees that a skeleton checkpoint was prevented from absorbing richer
	 * content — the signal for "the store is healing". `similarity` is carried only
	 * where the tier scored one (L2 does, L1 does not).
	 */
	skipped(
		tier: "L0" | "L1" | "L2",
		matchedEntry: string,
		dedupReason: string,
		similarity?: number,
	): void;
	/** Final outcome: nothing collapsed, a new checkpoint was written. */
	stored(storedEntry: string, dedupReason: string, tokenEstimate: number): void;
}

/** Build a recorder bound to one add() cascade. */
export function dedupAuditRecorder(
	ctx: DedupAuditContext,
	scope: DedupAuditScope,
): DedupAuditRecorder {
	const base = {
		sessionId: scope.sessionId,
		originalTokenEstimate: scope.originalTokenEstimate,
		tokenEstimate: scope.tokenEstimate,
	};
	return {
		deduped: (tier, matchedEntry, dedupReason, similarity) =>
			emitDedupAudit(ctx, {
				...base,
				tier,
				status: "deduped",
				matchedEntry,
				dedupReason,
				...(similarity === undefined ? {} : { similarity }),
			}),
		passed: (tier, matchedEntry, similarity) =>
			emitDedupAudit(ctx, {
				...base,
				tier,
				status: "passed",
				matchedEntry,
				similarity,
			}),
		skipped: (tier, matchedEntry, dedupReason, similarity) =>
			emitDedupAudit(ctx, {
				...base,
				tier,
				status: "skipped",
				matchedEntry,
				dedupReason,
				...(similarity === undefined ? {} : { similarity }),
			}),
		stored: (storedEntry, dedupReason, tokenEstimate) =>
			emitDedupAudit(ctx, {
				...base,
				tier: "new",
				status: "stored",
				storedEntry,
				dedupReason,
				tokenEstimate,
			}),
	};
}

/**
 * Append one dedup decision to events.log.
 *
 * Resolves the target path from the explicit `eventsPath` when a caller opted
 * in (Sprint 14 monitoring / tests), otherwise from the store's own per-repo
 * state dir — production never passes `eventsPath`, so defaulting is what makes
 * the audit trail actually exist on a real device.
 */
export function emitDedupAudit(
	ctx: DedupAuditContext,
	input: DedupAuditInput,
): void {
	if (!ctx.auditEnabled) return;
	try {
		const path = ctx.eventsPath ?? defaultEventsPath(ctx.stateDir);
		logDedupAudit(path, {
			type: "dedup_audit",
			ts: new Date().toISOString(),
			...input,
		});
	} catch {
		/* instrumentation must never break the add() path */
	}
}

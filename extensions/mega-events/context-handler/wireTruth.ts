/**
 * context-handler/wireTruth.ts — invisible-overhead calibration + wire-truth parse.
 *
 * Attempt #9 on the small-context-model overflow loop (2026-08-19 incident,
 * 8 prior attempts). ROOT CAUSE: pi adds a FIXED OVERHEAD H at request time
 * (system prompt + tool definitions + extension systemPrompt prepends) that
 * NEVER appears in the stored transcript. Neither pi's estimateContextTokens nor
 * our estimateSessionTokens/applyTailCap count H. So when the provider 400s with
 * "request (39048 tokens) exceeds the available context size (32768 tokens)" we
 * have been estimating ~18–26k and judging headroom against that — undercounting
 * by ~50%, so the gate never trips correctly and a RAW uncapped view ships → 400
 * again, forever (pi's one-shot overflow recovery only resets on user
 * message_start, so auto-retries burn it permanently).
 *
 * Two mechanisms here:
 *  - parseWireTruth: regex the provider's 400 text into ground-truth
 *    request/available token counts. Pure + unit-tested.
 *  - Per-model overhead EMA: calibrate H from observed samples so the gate and
 *    tail cap can ADD it back. Persisted in the SQLite meta table (copy the
 *    thrashGuard.ts pattern) so it survives restarts and travels with the repo.
 *
 * Non-fatal EVERYWHERE: every store read/write is best-effort, swallowed on
 * failure. Structured JSON logging only (logger + emit dual-sink, mirroring
 * armThrashGuard's 3WF-5 pattern). No console.*, no network, no mocks.
 */
import { getMetaNumber, setMetaNumber } from "../../../src/store/sqlite.js";

/** EMA smoothing factor for the overhead calibration (fixed, no count needed). */
export const OVERHEAD_EMA_ALPHA = 0.4;

/** Safety clamp: an overhead sample may never exceed this fraction of the window. */
export const OVERHEAD_CLAMP_FRACTION = 0.85;

/** Meta key prefix; the model id is appended (meta stores integers only). */
export const OVERHEAD_META_PREFIX = "wire.overhead_ema.";

/**
 * Parse the provider's overflow error text into ground-truth token counts.
 *
 * Matches strings like:
 *   "request (39048 tokens) exceeds the available context size (32768 tokens)"
 *   "request (39,048 tokens) exceeds the available context size (32,768 tokens)"
 *
 * Pure + side-effect free — trivially unit-testable. Returns null when the text
 * does not match the expected shape (e.g. an unrelated error message).
 */
export function parseWireTruth(
	text: string,
): { requestTokens: number; availableTokens: number } | null {
	if (typeof text !== "string" || text.length === 0) return null;
	const m = text.match(
		/request\s*\((\d[\d,]*)\s*tokens\)\s*exceeds the available context size\s*\((\d[\d,]*)\s*tokens\)/i,
	);
	if (!m) return null;
	const requestTokens = Number(m[1]?.replace(/,/g, ""));
	const availableTokens = Number(m[2]?.replace(/,/g, ""));
	if (!Number.isFinite(requestTokens) || !Number.isFinite(availableTokens)) return null;
	if (requestTokens <= 0 || availableTokens <= 0) return null;
	return { requestTokens, availableTokens };
}

/** Build the meta key for a model's overhead EMA (stored ×100, integer). */
function overheadKey(modelId: string): string {
	return OVERHEAD_META_PREFIX + modelId;
}

/**
 * Read the calibrated overhead (tokens) for a model. Returns 0 when absent or
 * unreadable — non-fatal everywhere. When the context window is known, clamps the
 * value into [0, 0.85 × ctxWindow] as a safety against a runaway EMA.
 */
export function readWireOverhead(modelId: string, stateDir: string, ctxWindow = 0): number {
	if (!modelId) return 0;
	try {
		const stored = getMetaNumber(overheadKey(modelId), stateDir);
		if (!Number.isFinite(stored) || stored <= 0) return 0;
		const frac = stored / 100;
		let overhead = frac * (ctxWindow > 0 ? ctxWindow : 1);
		if (ctxWindow > 0) {
			overhead = Math.min(overhead, ctxWindow * OVERHEAD_CLAMP_FRACTION);
		}
		return Math.max(0, overhead);
	} catch {
		return 0; // non-fatal: never fail the agent loop on a store read
	}
}

/**
 * Fold a new overhead sample into the per-model EMA and persist it. Returns the
 * new EMA in tokens (0 when the sample is invalid). First sample initializes the
 * EMA directly (no warm-up). Best-effort: never throws; a store failure is
 * swallowed and the in-memory EMA is still returned.
 *
 * Clamped into [0, 0.85 × ctxWindow] when ctxWindow is known.
 */
export function sampleWireOverhead(
	modelId: string,
	stateDir: string,
	sample: number,
	ctxWindow = 0,
): number {
	if (!modelId) return 0;
	if (!Number.isFinite(sample) || sample <= 0) return 0;
	let ema = sample;
	try {
		const stored = getMetaNumber(overheadKey(modelId), stateDir);
		if (Number.isFinite(stored) && stored > 0) {
			// prev is stored as a fraction ×100; convert back to token space
			// against the window before blending so the EMA is dimensionally
			// consistent (token space in, token space out).
			const prevTokens = (stored / 100) * (ctxWindow > 0 ? ctxWindow : sample);
			ema = OVERHEAD_EMA_ALPHA * sample + (1 - OVERHEAD_EMA_ALPHA) * prevTokens;
		}
		// Convert EMA to a fraction of the window (so the meta value is window-
		// independent + percent-based). When the window is unknown, clamp the
		// stored fraction to a sane [0, OVERHEAD_CLAMP_FRACTION] band so a stale
		// 0-window sample cannot poison a later windowed read.
		let frac = ctxWindow > 0 ? ema / ctxWindow : ema;
		if (ctxWindow > 0) {
			frac = Math.min(frac, OVERHEAD_CLAMP_FRACTION);
		} else {
			frac = Math.min(Math.max(frac, 0), OVERHEAD_CLAMP_FRACTION);
		}
		setMetaNumber(overheadKey(modelId), Math.round(frac * 100), stateDir);
	} catch {
		/* non-fatal: best-effort meta write */
	}
	// Return the token-space EMA (clamped) regardless of whether the persist landed.
	let out = ema;
	if (ctxWindow > 0) out = Math.min(out, ctxWindow * OVERHEAD_CLAMP_FRACTION);
	return Math.max(0, out);
}

/**
 * degenerate-guard.test.ts — the degenerate-match guard (incident 2026-08-19).
 *
 * The pathology being pinned down: a content-free skeleton checkpoint
 * ("Conversation: 64 messages (5 user, 29 assistant, 27 tool). Tools: bash,
 * edit, read.") landed in the store, and because every later compaction produced
 * a structurally identical skeleton, L1 MinHash and L2 cosine matched it every
 * time → deduped:true forever → the store could never heal.
 *
 * These tests exercise the REAL cascade through VectorStore.add() over real temp
 * state dirs (no stubs, no mocks): the matches below are produced by the actual
 * MinHash/trigram and cosine tiers over genuinely skeleton-shaped text, which is
 * what makes them a reproduction rather than a restatement of the guard's code.
 *
 * Hermetic: one fresh temp state dir per store. No network (PREVENT-PI-004).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../vectorStore.js";
import { vectorList } from "../vectorStore.js";
import { closeStore } from "../store/sqlite.js";
import { loadDedupConfig, type DedupConfigShape } from "../config/dedup.js";
import { defaultEventsPath, type DedupAuditEvent } from "../monitoring.js";
import {
	isDegenerateCheckpoint,
	degenerateFloor,
} from "../dedup/degenerate.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-degen-"));
let seq = 0;
const freshDir = (): string => join(baseTmp, `run-${seq++}`);

/** Live config with per-test overrides. */
const cfg = (over: Partial<DedupConfigShape> = {}): DedupConfigShape => ({
	...loadDedupConfig(),
	...over,
});

/** The incident's actual skeleton shape, parameterized so variants stay near-dups. */
const skeleton = (msgs: number, user: number, asst: number, tool: number) =>
	`Conversation: ${msgs} messages (${user} user, ${asst} assistant, ${tool} tool). Tools: bash, edit, read.`;

/** Read the dedup_audit lines a store wrote. */
function auditLines(stateDir: string): DedupAuditEvent[] {
	const path = defaultEventsPath(stateDir);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as DedupAuditEvent)
		.filter((e) => e.type === "dedup_audit");
}

// --- the predicate, calibrated against the incident numbers -----------------

test("degenerate predicate: incident skeleton is degenerate, a normal summary is not", () => {
	const t = cfg();
	// The real incident row: 34 tokens standing in for ~19166.
	assert.equal(degenerateFloor({ originalTokenEstimate: 19166 }, t), 95.83);
	assert.equal(
		isDegenerateCheckpoint(
			{ tokenEstimate: 34, originalTokenEstimate: 19166 },
			t,
		),
		true,
	);
	// A healthy 2k-token summary of a 70k region: 2000 > max(48, 350).
	assert.equal(
		isDegenerateCheckpoint(
			{ tokenEstimate: 2000, originalTokenEstimate: 70000 },
			t,
		),
		false,
	);
});

// --- case 6: missing / zero originalTokenEstimate → absolute floor only -----

test("missing or zero originalTokenEstimate falls back to the absolute floor alone", () => {
	const t = cfg();
	// No original recorded: judged on absolute size only.
	assert.equal(degenerateFloor({}, t), 48);
	assert.equal(degenerateFloor({ originalTokenEstimate: 0 }, t), 48);
	assert.equal(isDegenerateCheckpoint({ tokenEstimate: 34 }, t), true);
	assert.equal(isDegenerateCheckpoint({ tokenEstimate: 100 }, t), false);
	// A 0 original must not make a large summary look degenerate.
	assert.equal(
		isDegenerateCheckpoint({ tokenEstimate: 5000, originalTokenEstimate: 0 }, t),
		false,
	);
	// Non-finite originals are ignored rather than poisoning the floor with NaN.
	assert.equal(
		degenerateFloor({ originalTokenEstimate: Number.NaN }, t),
		48,
	);
});

// --- case 5: threshold boundary --------------------------------------------

test("a stored summary just above the effective floor is NOT degenerate", () => {
	const t = cfg();
	// original 19166 → floor 95.83. 96 clears it, 95 does not.
	assert.equal(
		isDegenerateCheckpoint({ tokenEstimate: 96, originalTokenEstimate: 19166 }, t),
		false,
	);
	assert.equal(
		isDegenerateCheckpoint({ tokenEstimate: 95, originalTokenEstimate: 19166 }, t),
		true,
	);
	// Small original → the absolute floor dominates: 48 is the exact edge.
	assert.equal(
		isDegenerateCheckpoint({ tokenEstimate: 48, originalTokenEstimate: 900 }, t),
		false,
	);
	assert.equal(
		isDegenerateCheckpoint({ tokenEstimate: 47, originalTokenEstimate: 900 }, t),
		true,
	);
});

// --- case 1: the incident reproduction, through the real cascade ------------

test("incident: a richer candidate does NOT collapse onto a degenerate skeleton", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	// The poisoned checkpoint, with the incident's exact token accounting.
	const first = s.add({
		sessionId: "s",
		summary: "skeleton",
		regionText: skeleton(64, 5, 29, 27),
		tokenEstimate: 34,
		originalTokenEstimate: 19166,
		timestamp: 1,
	});
	assert.equal(first.deduped, false);

	// A later compaction whose region is a near-identical skeleton (this is what
	// L1/L2 matched in the incident) but which now carries a RICH summary.
	const healed = s.add({
		sessionId: "s",
		summary: "the real work: refactored the recall path and fixed the L2 threshold",
		regionText: skeleton(66, 6, 30, 28),
		tokenEstimate: 500,
		originalTokenEstimate: 19800,
		timestamp: 2,
	});

	assert.equal(healed.deduped, false, "the guard must decline the collapse");
	assert.notEqual(
		healed.checkpoint.checkpointId,
		first.checkpoint.checkpointId,
		"a NEW checkpoint was written, not the skeleton's timestamp bumped",
	);
	assert.equal(healed.checkpoint.tokenEstimate, 500);
	const rows = vectorList(s, "s");
	assert.equal(rows.length, 2, "the store now holds both rows and can heal");

	// The declined decision is auditable: matched-but-skipped, naming the reason.
	const skippedLines = auditLines(dir).filter((e) => e.status === "skipped");
	assert.equal(skippedLines.length, 1);
	assert.equal(skippedLines[0].dedupReason, "degenerateGuard");
	assert.equal(skippedLines[0].matchedEntry, first.checkpoint.checkpointId);
	assert.ok(
		skippedLines[0].tier === "L1" || skippedLines[0].tier === "L2",
		`a fuzzy tier produced the declined match (got ${skippedLines[0].tier})`,
	);
	closeStore(dir);
});

// --- case 4: flag OFF is byte-identical to the old (buggy) behavior ---------

test("guard OFF reproduces the old behavior: the skeleton still absorbs the richer region", () => {
	const dir = freshDir();
	const s = new VectorStore({
		stateDir: dir,
		config: cfg({ DEDUP_DEGENERATE_GUARD: false }),
	});
	const first = s.add({
		sessionId: "s",
		summary: "skeleton",
		regionText: skeleton(64, 5, 29, 27),
		tokenEstimate: 34,
		originalTokenEstimate: 19166,
		timestamp: 1,
	});
	const swallowed = s.add({
		sessionId: "s",
		summary: "rich summary that the old code discarded",
		regionText: skeleton(66, 6, 30, 28),
		tokenEstimate: 500,
		originalTokenEstimate: 19800,
		timestamp: 2,
	});
	assert.equal(swallowed.deduped, true, "flag OFF = the pre-guard cascade");
	assert.equal(
		swallowed.checkpoint.checkpointId,
		first.checkpoint.checkpointId,
	);
	assert.equal(vectorList(s, "s").length, 1);
	// Nothing is audited as skipped when the guard is off.
	assert.equal(auditLines(dir).filter((e) => e.status === "skipped").length, 0);
	closeStore(dir);
});

// --- case 3: equally-degenerate candidate still collapses ------------------

test("two equal skeletons still collapse: the guard needs a RICHER candidate", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	const first = s.add({
		sessionId: "s",
		summary: "skeleton",
		regionText: skeleton(64, 5, 29, 27),
		tokenEstimate: 34,
		originalTokenEstimate: 19166,
		timestamp: 1,
	});
	// Same size (not richer) → collapsing is harmless and keeps the store from
	// growing one row per compaction while the summarizer is still broken.
	const dup = s.add({
		sessionId: "s",
		summary: "skeleton again",
		regionText: skeleton(66, 6, 30, 28),
		tokenEstimate: 34,
		originalTokenEstimate: 19800,
		timestamp: 2,
	});
	assert.equal(dup.deduped, true);
	assert.equal(dup.checkpoint.checkpointId, first.checkpoint.checkpointId);
	assert.equal(vectorList(s, "s").length, 1);
	closeStore(dir);
});

// --- case 2: no behavior change when the matched checkpoint is healthy ------

test("a non-degenerate matched checkpoint still dedups a matching candidate", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	const region = "the scheduler retried the failed upload after a backoff delay";
	const first = s.add({
		sessionId: "s",
		summary: "healthy summary well above the degenerate floor",
		regionText: region,
		tokenEstimate: 2000,
		originalTokenEstimate: 70000,
		timestamp: 1,
	});
	const dup = s.add({
		sessionId: "s",
		summary: "healthy summary well above the degenerate floor",
		regionText: region,
		tokenEstimate: 2500,
		originalTokenEstimate: 72000,
		timestamp: 2,
	});
	assert.equal(dup.deduped, true, "ordinary dedup is untouched");
	assert.equal(dup.checkpoint.checkpointId, first.checkpoint.checkpointId);
	assert.equal(vectorList(s, "s").length, 1);
	assert.equal(auditLines(dir).filter((e) => e.status === "skipped").length, 0);
	closeStore(dir);
});

// --- the guard is fuzzy-tier only: L0 exact matches must be unaffected ------

test("L0 exact-hash dedup is NOT bypassed by the guard (byte-identical region)", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	const region = skeleton(64, 5, 29, 27);
	const first = s.add({
		sessionId: "s",
		summary: "skeleton",
		regionText: region,
		tokenEstimate: 34,
		originalTokenEstimate: 19166,
		timestamp: 1,
	});
	// Byte-identical content is the same region, not a healing opportunity —
	// re-storing it would be a pure duplicate, so L0 must still collapse.
	const same = s.add({
		sessionId: "s",
		summary: "richer summary of the very same bytes",
		regionText: region,
		tokenEstimate: 500,
		originalTokenEstimate: 19166,
		timestamp: 2,
	});
	assert.equal(same.deduped, true);
	assert.equal(same.checkpoint.checkpointId, first.checkpoint.checkpointId);
	closeStore(dir);
});

// --- the UNIQUE-index hazard the guard must never walk into -----------------

test("declining a match never throws on the (session_id, content_hash) UNIQUE index", () => {
	const dir = freshDir();
	// L0 disabled is the dangerous configuration: without the exact-content check
	// in the guard, a byte-identical richer candidate would decline the L2 match,
	// fall through to INSERT, and violate the partial UNIQUE index — throwing
	// inside add(), which sits on the agent loop.
	const s = new VectorStore({
		stateDir: dir,
		config: cfg({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: true }),
	});
	const region = skeleton(64, 5, 29, 27);
	const first = s.add({
		sessionId: "s",
		summary: "skeleton",
		regionText: region,
		tokenEstimate: 34,
		originalTokenEstimate: 19166,
		timestamp: 1,
	});
	let second: ReturnType<typeof s.add> | undefined;
	assert.doesNotThrow(() => {
		second = s.add({
			sessionId: "s",
			summary: "richer summary of the identical bytes",
			regionText: region,
			tokenEstimate: 900,
			originalTokenEstimate: 19166,
			timestamp: 2,
		});
	}, "add() must not throw when the guard meets an exact-content match");
	// The collapse proceeds: identical bytes are the same region, not healing.
	assert.equal(second?.deduped, true);
	assert.equal(second?.checkpoint.checkpointId, first.checkpoint.checkpointId);
	assert.equal(vectorList(s, "s").length, 1);
	closeStore(dir);
});

// --- L2-only path: prove the guard fires on the cosine tier specifically ----

test("guard fires on the L2 cosine tier with L0/L1 disabled", () => {
	const dir = freshDir();
	const s = new VectorStore({
		stateDir: dir,
		config: cfg({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: true }),
	});
	const first = s.add({
		sessionId: "s",
		summary: "skeleton",
		regionText: skeleton(64, 5, 29, 27),
		tokenEstimate: 34,
		originalTokenEstimate: 19166,
		timestamp: 1,
	});
	// Distinct bytes (a different message tally) but cosine-identical shape: the
	// incident's real form, and the only form the guard may decline (byte-identical
	// content is L0's business — see the exact-match test above).
	const healed = s.add({
		sessionId: "s",
		summary: "rich",
		regionText: skeleton(65, 6, 29, 27),
		tokenEstimate: 900,
		originalTokenEstimate: 19166,
		timestamp: 2,
	});
	assert.equal(healed.deduped, false);
	assert.notEqual(healed.checkpoint.checkpointId, first.checkpoint.checkpointId);
	const skipped = auditLines(dir).find((e) => e.status === "skipped");
	assert.ok(skipped, "the declined L2 match was audited");
	assert.equal(skipped.tier, "L2");
	assert.equal(skipped.dedupReason, "degenerateGuard");
	// L2 scores, so the cosine that cleared the threshold is carried.
	assert.equal(typeof skipped.similarity, "number");
	assert.ok((skipped.similarity as number) >= cfg().L2_COSINE);
	closeStore(dir);
});

test("cleanup", () => {
	rmSync(baseTmp, { recursive: true, force: true });
});

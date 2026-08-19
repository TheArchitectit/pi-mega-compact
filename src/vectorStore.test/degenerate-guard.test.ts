/**
 * degenerate-guard.test.ts — the degenerate-match guard (incident 2026-08-19).
 *
 * The pathology being pinned down: a content-free skeleton checkpoint
 * ("Conversation: 64 messages (5 user, 29 assistant, 27 tool). Tools: bash,
 * edit, read.") landed in the store, and because every later compaction produced
 * a structurally identical skeleton, L1 MinHash and L2 cosine matched it every
 * time → deduped:true forever → the store could never heal.
 *
 * This file: the predicate's calibration + the incident reproduction through
 * the REAL cascade + flag-OFF byte identity. The tier-specific cascade cases
 * (equal skeletons, healthy matches, L0/L2-only paths, the UNIQUE-index hazard)
 * live in degenerate-guard-cascade.test.ts (split per the 300-line src/ soft
 * limit the deploy gate enforces).
 *
 * Hermetic: one fresh temp state dir per store. No network (PREVENT-PI-004).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, vectorList } from "../vectorStore.js";
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

// --- the incident reproduction, through the real cascade --------------------

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

// --- flag OFF is byte-identical to the old (buggy) behavior ------------------

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

test("cleanup", () => {
	rmSync(baseTmp, { recursive: true, force: true });
});

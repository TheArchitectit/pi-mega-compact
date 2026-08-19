/**
 * degenerate-guard-cascade.test.ts — tier-specific cascade behavior of the
 * degenerate-match guard (incident 2026-08-19).
 *
 * Sibling of degenerate-guard.test.ts (predicate calibration + incident
 * reproduction + flag-OFF byte identity), split per the 300-line src/ soft
 * limit the deploy gate enforces. These cases exercise the REAL cascade
 * through VectorStore.add() over real temp state dirs (no stubs, no mocks).
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

const baseTmp = mkdtempSync(join(tmpdir(), "mc-degen-cascade-"));
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

// --- equally-degenerate candidates still collapse ----------------------------

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

// --- no behavior change when the matched checkpoint is healthy ---------------

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

// --- the guard is fuzzy-tier only: L0 exact matches must be unaffected -------

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

// --- the UNIQUE-index hazard the guard must never walk into ------------------

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

// --- L2-only path: prove the guard fires on the cosine tier specifically -----

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

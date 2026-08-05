/**
 * dedup-audit.test.ts — durable dedup audit trail: the DECISIONS (external-audit
 * item #2).
 *
 * Proves the decision data an operator needs to tune thresholds actually
 * survives the process: which layer fired, what it collapsed onto, and at what
 * similarity. Robustness + flag gating live in dedup-audit-gating.test.ts.
 * Hermetic — isolated temp state dirs, no network, no shared store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { VectorStore } from "./vectorStore.js";
import { closeStore } from "./store/sqlite.js";
import { cfg, freshDir, auditLines } from "./dedup-audit.test-helpers.js";

// --- (a) a deduped decision is persisted with tier/matchedEntry/similarity ---

test("L0 exact dedup writes a dedup_audit line naming the matched entry", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	const first = s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the parser cached the compiled regex table",
		tokenEstimate: 40,
		originalTokenEstimate: 900,
		timestamp: 1,
	});
	// Byte-identical region → L0 content-hash tier collapses it.
	const dup = s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the parser cached the compiled regex table",
		tokenEstimate: 40,
		originalTokenEstimate: 900,
		timestamp: 2,
	});
	assert.equal(dup.deduped, true);

	const deduped = auditLines(dir).filter((e) => e.status === "deduped");
	assert.equal(deduped.length, 1, "exactly one dedup decision was made");
	const ev = deduped[0];
	assert.equal(ev.tier, "L0");
	assert.equal(ev.dedupReason, "contentHash");
	// The matched entry is the checkpoint the region actually collapsed onto.
	assert.equal(ev.matchedEntry, first.checkpoint.checkpointId);
	assert.equal(ev.matchedEntry, dup.checkpoint.checkpointId);
	// L0 is a hash tier: it computes no score, so none is invented.
	assert.equal(ev.similarity, undefined);
	assert.equal(ev.originalTokenEstimate, 900);
	assert.equal(ev.sessionId, "sess_s");
	closeStore(dir);
});

test("L2 semantic dedup records the cosine similarity it fired on", () => {
	const dir = freshDir();
	// Disable the exact/near-dup tiers so the L2 cosine path is the one that fires.
	const s = new VectorStore({
		stateDir: dir,
		config: cfg({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: true }),
	});
	const base = "the scheduler retried the failed upload after a backoff delay";
	s.add({ sessionId: "s", summary: "x", regionText: base, timestamp: 1 });
	const dup = s.add({
		sessionId: "s",
		summary: "x",
		regionText: base,
		timestamp: 2,
	});
	assert.equal(dup.deduped, true);
	assert.equal(dup.reason, "contentSimilarity");

	const ev = auditLines(dir).find(
		(e) => e.status === "deduped" && e.tier === "L2",
	);
	assert.ok(ev, "an L2 dedup decision was audited");
	assert.equal(ev.dedupReason, "contentSimilarity");
	assert.equal(typeof ev.similarity, "number");
	// The score must be the real cosine that cleared the configured threshold.
	assert.ok(
		(ev.similarity as number) >= cfg().L2_COSINE,
		`similarity ${ev.similarity} should be >= threshold ${cfg().L2_COSINE}`,
	);
	closeStore(dir);
});

test("an L2 near-miss is audited with the best score actually scanned", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the glacier calved an iceberg into the fjord at dawn",
		timestamp: 1,
	});
	s.add({
		sessionId: "s",
		summary: "x",
		regionText: "quantum entanglement linked two photons in a cryostat",
		timestamp: 2,
	});

	const passed = auditLines(dir).filter(
		(e) => e.tier === "L2" && e.status === "passed",
	);
	assert.equal(passed.length, 1, "the second add scanned one candidate");
	// This is the threshold-tuning datum: how close did we come to collapsing?
	assert.equal(typeof passed[0].similarity, "number");
	assert.ok((passed[0].similarity as number) < cfg().L2_COSINE);
	assert.ok(passed[0].matchedEntry, "names the nearest checkpoint scored");
	closeStore(dir);
});

// --- (b) a stored (new) decision writes the correct "stored" line ------------

test("a genuinely new region writes a stored dedup_audit line", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	const r = s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the archivist unsealed the parchment from the coastal ruin",
		tokenEstimate: 30,
		originalTokenEstimate: 700,
		timestamp: 1,
	});
	assert.equal(r.deduped, false);

	const stored = auditLines(dir).filter((e) => e.status === "stored");
	assert.equal(stored.length, 1);
	const ev = stored[0];
	assert.equal(ev.tier, "new");
	assert.equal(ev.dedupReason, "new");
	// storedEntry is the checkpoint CREATED — never conflated with matchedEntry.
	assert.equal(ev.storedEntry, r.checkpoint.checkpointId);
	assert.equal(ev.matchedEntry, undefined);
	assert.equal(ev.originalTokenEstimate, 700);
	assert.equal(ev.tokenEstimate, 30);
	closeStore(dir);
});

test("MARK_ONLY match is stored but audited with the mark_only reason", () => {
	const dir = freshDir();
	const s = new VectorStore({
		stateDir: dir,
		config: cfg({ L1_ENABLED: true, MARK_ONLY_L1: true, L2_ENABLED: false }),
	});
	s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the parser optimized the hot loop",
		timestamp: 1,
	});
	const b = s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the parser optimized the hot loops",
		timestamp: 2,
	});
	// MARK_ONLY: matched, but deliberately not collapsed.
	assert.equal(b.deduped, false);

	const stored = auditLines(dir).filter((e) => e.status === "stored");
	assert.equal(stored.length, 2);
	assert.equal(stored[1].dedupReason, "mark_only");
	closeStore(dir);
});

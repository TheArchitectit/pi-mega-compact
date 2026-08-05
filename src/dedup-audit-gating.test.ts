/**
 * dedup-audit-gating.test.ts — durable dedup audit trail: ROBUSTNESS + GATING.
 *
 * The audit trail is pure instrumentation, so it must be impossible for it to
 * break add(): an unwritable target is swallowed, and the flag off writes
 * nothing at all while leaving the dedup outcome unchanged. Also pins the SSE
 * wire shape the dashboard tail depends on. The decision-content assertions live
 * in dedup-audit.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { VectorStore } from "./vectorStore.js";
import { loadDedupConfig } from "./config/dedup.js";
import { closeStore } from "./store/sqlite.js";
import { defaultEventsPath, logDedupAudit, type DedupAuditEvent } from "./monitoring.js";
import {
	baseTmp,
	cfg,
	freshDir,
	auditLines,
	unwritablePath,
} from "./dedup-audit.test-helpers.js";

// --- (c) the helper is non-fatal when the path is unwritable ----------------

test("logDedupAudit swallows an unwritable path", () => {
	const ev: DedupAuditEvent = {
		type: "dedup_audit",
		ts: new Date().toISOString(),
		sessionId: "sess_s",
		tier: "L0",
		status: "deduped",
	};
	assert.doesNotThrow(() => logDedupAudit(unwritablePath(), ev));
	assert.doesNotThrow(() => logDedupAudit("", ev));
});

test("add() still succeeds when the audit target is unwritable", () => {
	const dir = freshDir();
	// eventsPath points inside a path that cannot be created → every append fails.
	const s = new VectorStore({
		stateDir: dir,
		config: cfg(),
		eventsPath: unwritablePath(),
	});
	const r = s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the diver surfaced with an amphora from the galleon",
		timestamp: 1,
	});
	// The dedup decision itself is unaffected by the logging failure.
	assert.equal(r.deduped, false);
	assert.ok(r.checkpoint.checkpointId);
	closeStore(dir);
});

// --- (d) flag gating: OFF writes nothing ------------------------------------

test("MEGACOMPACT_DEDUP_AUDIT off → no dedup_audit lines at all", () => {
	const dir = freshDir();
	const s = new VectorStore({
		stateDir: dir,
		config: cfg({ DEDUP_AUDIT: false }),
	});
	const text = "the cartographer plotted the uncharted island";
	s.add({ sessionId: "s", summary: "x", regionText: text, timestamp: 1 });
	const dup = s.add({ sessionId: "s", summary: "x", regionText: text, timestamp: 2 });
	// Behavior is unchanged with the flag off — only the audit trail disappears.
	assert.equal(dup.deduped, true);
	assert.equal(auditLines(dir).length, 0);
	closeStore(dir);
});

test("flag default is ON (env-overridable)", () => {
	assert.equal(loadDedupConfig().DEDUP_AUDIT, true);
	const prev = process.env.MEGACOMPACT_DEDUP_AUDIT;
	try {
		process.env.MEGACOMPACT_DEDUP_AUDIT = "false";
		assert.equal(loadDedupConfig().DEDUP_AUDIT, false);
	} finally {
		if (prev === undefined) delete process.env.MEGACOMPACT_DEDUP_AUDIT;
		else process.env.MEGACOMPACT_DEDUP_AUDIT = prev;
	}
});

// --- wire shape: streams over the existing SSE tail -------------------------

test("audit lines carry the SSE contract shape (type + ISO ts)", () => {
	const dir = freshDir();
	const s = new VectorStore({ stateDir: dir, config: cfg() });
	s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the beekeeper harvested the golden comb",
		timestamp: 1,
	});
	const lines = auditLines(dir);
	assert.ok(lines.length >= 1);
	for (const ev of lines) {
		// /api/events only streams lines carrying a "type" field.
		assert.equal(ev.type, "dedup_audit");
		assert.equal(typeof ev.ts, "string");
		assert.ok(!Number.isNaN(Date.parse(ev.ts)), `ts ${ev.ts} parses as a date`);
	}
	closeStore(dir);
});

test("production path (no explicit eventsPath) still writes the trail", () => {
	const dir = freshDir();
	// Mirrors how MegaRuntime constructs the store: stateDir only.
	const s = new VectorStore({ stateDir: dir });
	s.add({
		sessionId: "s",
		summary: "x",
		regionText: "the shepherd guided the flock to the stone bothy",
		timestamp: 1,
	});
	assert.ok(
		existsSync(defaultEventsPath(dir)),
		"events.log is created from the store's own state dir",
	);
	assert.ok(auditLines(dir).length >= 1);
	closeStore(dir);
});

// --- cleanup ----------------------------------------------------------------

test("dedup audit cleanup", () => {
	rmSync(baseTmp, { recursive: true, force: true });
});

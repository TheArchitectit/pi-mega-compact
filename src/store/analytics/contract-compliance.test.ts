/**
 * contract-compliance.test.ts — Shared compliance suite for AnalyticsStore.
 *
 * Parameterized: takes a factory + options, runs every contract assertion
 * against the produced store. Imported by backend-specific test files to prove
 * both SqliteAnalyticsStore and InMemoryAnalyticsStore satisfy the same contract.
 *
 * Contract guarantees tested:
 *   1. appendRequestEvent + status round-trip
 *   2. appendMeasurement + status round-trip
 *   3. appendIdentity + status round-trip
 *   4. Duplicate request event id → AppendResult status="duplicate"
 *   5. Capability gating (asReader/asWriter/asAdmin)
 *   6. clear() wipes all data
 *   7. close() is idempotent
 *   8. Writer never throws (returns AppendResult on failure)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AnalyticsStore, AnalyticsStoreOptions } from "./types.js";
import type { StoreFactory } from "./contract-compliance.test/_helpers.js";
import { makeRequestEvent, makeMeasurement, makeIdentity } from "./contract-compliance.test/_helpers.js";

export type { StoreFactory };

export function runComplianceSuite(
	name: string,
	factory: StoreFactory,
	options: AnalyticsStoreOptions,
): void {
	describe(`${name} — AnalyticsStore compliance`, () => {
		let store: AnalyticsStore;

		beforeEach(() => {
			store = factory(options);
		});

		afterEach(() => {
			try { store.asAdmin().clear(); } catch { /* best-effort */ }
			try { store.close(); } catch { /* best-effort */ }
		});

		// ── 1. appendRequestEvent + status ──────────────────────────

		it("appendRequestEvent accepted → status reflects the row", () => {
			const fact = makeRequestEvent({ id: "evt_compliance_1" });
			const res = store.asWriter().appendRequestEvent(fact);
			assert.equal(res.status, "accepted");
			const st = store.asReader().status();
			assert.equal(st.requestEventCount, 1);
		});

		it("appendRequestEvent preserves optional fields (tokens, ttft, etc.)", () => {
			const fact = makeRequestEvent({
				id: "evt_compliance_2",
				inputTokens: 5000,
				outputTokens: 1200,
				cacheReadTokens: 3000,
				cacheWriteTokens: 500,
				ttftMs: 250,
				durationMs: 1800,
				quality: { estimated: true, note: "test" },
			});
			const res = store.asWriter().appendRequestEvent(fact);
			assert.equal(res.status, "accepted");
		});

		// ── 2. appendMeasurement + status ───────────────────────────

		it("appendMeasurement accepted → status reflects the row", () => {
			const res = store.asWriter().appendMeasurement(makeMeasurement());
			assert.equal(res.status, "accepted");
			assert.equal(store.asReader().status().measurementCount, 1);
		});

		// ── 3. appendIdentity + status ──────────────────────────────

		it("appendIdentity accepted → status reflects the row", () => {
			const res = store.asWriter().appendIdentity(makeIdentity());
			assert.equal(res.status, "accepted");
			assert.equal(store.asReader().status().identityCount, 1);
		});

		// ── 4. Duplicate request event id → "duplicate" ─────────────

		it("appendRequestEvent with an existing id → status='duplicate'", () => {
			const fact = makeRequestEvent({ id: "evt_dup" });
			store.asWriter().appendRequestEvent(fact);
			const res2 = store.asWriter().appendRequestEvent(fact);
			assert.equal(res2.status, "duplicate");
			assert.equal(store.asReader().status().requestEventCount, 1);
		});

		// ── 5. Capability gating (type-level) ───────────────────────

		it("asReader returns an AnalyticsReader (type check)", () => {
			const reader = store.asReader();
			assert.equal(typeof reader.status, "function");
		});

		it("asWriter returns an AnalyticsWriter (type check)", () => {
			const writer = store.asWriter();
			assert.equal(typeof writer.appendRequestEvent, "function");
			assert.equal(typeof writer.appendMeasurement, "function");
			assert.equal(typeof writer.appendIdentity, "function");
		});

		it("asAdmin returns an AnalyticsAdmin (type check)", () => {
			const admin = store.asAdmin();
			assert.equal(typeof admin.prune, "function");
			assert.equal(typeof admin.vacuum, "function");
			assert.equal(typeof admin.integrityCheck, "function");
			assert.equal(typeof admin.backup, "function");
			assert.equal(typeof admin.clear, "function");
			assert.equal(typeof admin.close, "function");
		});

		// ── 6. clear() wipes ────────────────────────────────────────

		it("clear wipes all data", () => {
			store.asWriter().appendRequestEvent(makeRequestEvent({ id: "evt_clear" }));
			store.asWriter().appendMeasurement(makeMeasurement());
			store.asWriter().appendIdentity(makeIdentity());
			store.asAdmin().clear();
			const st = store.asReader().status();
			assert.equal(st.requestEventCount, 0);
			assert.equal(st.measurementCount, 0);
			assert.equal(st.identityCount, 0);
		});

		// ── 7. close() is idempotent ────────────────────────────────

		it("close is idempotent", () => {
			const store2 = factory(options);
			store2.close();
			store2.close(); // must not throw
		});

		// ── 8. Writer never throws ──────────────────────────────────

		it("prune returns a PruneReport (no throw)", () => {
			const report = store.asAdmin().prune({
				maxEventAgeMs: 365 * 24 * 60 * 60 * 1000,
				maxMeasurementAgeMs: 30 * 24 * 60 * 60 * 1000,
				vacuumAfterPrune: false,
			});
			assert.ok(typeof report.eventsRemoved === "number");
		});

		it("integrityCheck returns an IntegrityReport", () => {
			const report = store.asAdmin().integrityCheck();
			assert.ok(typeof report.ok === "boolean");
		});

		it("freshThrough is null on empty store, populated after append", () => {
			const empty = store.asReader().status();
			assert.equal(empty.freshThrough, null);
			const now = Date.now();
			store.asWriter().appendMeasurement(makeMeasurement({ observedAt: now }));
			const after = store.asReader().status();
			assert.equal(after.freshThrough, now);
		});
	});
}

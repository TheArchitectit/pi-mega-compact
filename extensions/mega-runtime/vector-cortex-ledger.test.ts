/**
 * vector-cortex-ledger.test.ts — VC1B S1 wiring + S2 flag-off gate.
 *
 * Verifies the ingestion seam persists occurrences only when MEGACOMPACT_VC1B
 * is ON: appendMessagesToLedger writes one row per canonical message, maps a
 * stable (event_id,digest), and when the flag is OFF opens NO ledger DB at all
 * (byte-identical predecessor). Real store, no mocks.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openLedgerWriter,
	appendMessagesToLedger,
	messageToLedgerInput,
} from "./vector-cortex-ledger.js";
import { createLedgerStore } from "../../src/vector-cortex/ledger/store.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const key = "MEGACOMPACT_VC1B";
const saved = process.env[key];
after(() => {
	if (saved === undefined) delete process.env[key];
	else process.env[key] = saved;
});

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "vc1b-wire-"));
}
function msg(role: string, content: string): AgentMessage {
	return { role: role as AgentMessage["role"], content } as AgentMessage;
}

describe("VC1B ledger writer wiring (S1) + flag gate (S2)", () => {
	test("flag ON: appendMessagesToLedger persists one occurrence per message", () => {
		process.env[key] = "1";
		const dir = tempDir();
		try {
			const count = appendMessagesToLedger(dir, "w", [
				msg("user", "hi"),
				msg("assistant", "yo"),
			]);
			assert.equal(count, 2, "two accepted occurrences");
			const store = createLedgerStore({ stateDir: dir });
			try {
				assert.equal(store.reader().count("w"), 2, "both persisted");
			} finally {
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("flag OFF: appendMessagesToLedger opens no DB (zero writes, byte-identical)", () => {
		process.env[key] = "0";
		const dir = tempDir();
		try {
			const count = appendMessagesToLedger(dir, "w", [msg("user", "hi")]);
			assert.equal(count, 0, "flag OFF accepts nothing");
			assert.ok(
				!existsSync(join(dir, "vector-cortex", "occurrence-v2.db")),
				"no ledger DB created when disabled",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("flag OFF: openLedgerWriter returns null (no handle to write through)", () => {
		process.env[key] = "0";
		const dir = tempDir();
		try {
			assert.equal(openLedgerWriter(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("messageToLedgerInput maps role/seq and a stable (event_id,digest)", () => {
		process.env[key] = "1";
		const a = messageToLedgerInput(msg("user", "hi"), "s", 0);
		assert.equal(a.seq, 1n);
		assert.equal(a.kind, "user");
		assert.equal(a.session, "s");
		assert.match(a.eventId, /^sha256:/);
		assert.ok(a.sourceBytes.length > 0);
		// Identical content => identical (event_id,digest) so re-observation dedupes.
		const b = messageToLedgerInput(msg("user", "hi"), "s", 1);
		assert.equal(b.eventId, a.eventId);
	});
});

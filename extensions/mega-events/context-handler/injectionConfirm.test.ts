/**
 * context-handler/injectionConfirm.test.ts — 3WF-4 InjectionConfirm (spec tests 1-4).
 *
 * No mocks, no stubs (project rule O1): a REAL VectorStore over a temp stateDir
 * with REAL checkpoints persisted via compactSession, so the floor rung reads a
 * real `vectorList`. Fixtures live in ./injectionConfirm.fixture.ts (soft-cap
 * split, mirroring src/recall/recall3wf.fixture.ts).
 *
 * Spec coverage:
 *  1. staged-block-suppressed fixture -> InjectionVerdict.landed === false and
 *     the recomposed block is present in the returned view.
 *  2. runtime pending blocks absent too -> the shared floor block is present.
 *  3. legacy prepend mode (recallTailInject=false) -> the guard verifies the
 *     returned string contains the block and does NOT crash / does NOT mutate
 *     the view when the message list lacks it.
 *  4. umbrella flag OFF -> tail composition byte-identical (pass-through).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { closeIndexStore } from "../../../src/store/sqlite.js";
import { messageContentText } from "./messageText.js";
import {
	confirmInjection,
	decideInjection,
	blockMarker,
} from "./injectionConfirm.js";
import { buildFloorBlock } from "../../../src/failback/floor.js";
import { vectorList } from "../../../src/vectorStore.js";
import {
	freshStore,
	seed,
	runtimeStub,
	configStub,
	userMsg,
} from "./injectionConfirm.fixture.js";

const dirs: string[] = [];
after(() => {
	closeIndexStore();
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
});

const STAGED = "### Recalled context [1] (relevance 88%)\nthe dedupe race fix";

/** Texts of a view, for containment assertions. */
function texts(view: { messages: readonly unknown[] }): string[] {
	return (view.messages as Parameters<typeof messageContentText>[0][]).map(
		messageContentText,
	);
}

// --- Test 1: staged block suppressed -> landed=false -> recomposed ----------

test("3WF-4/1: suppressed staged block -> landed=false, recomposed block present", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	seed(store, ["dedupe race in the store"]);
	const { runtime, events } = runtimeStub(store, { pendingRecallBlock: STAGED });

	// The pure decision function sees the block missing from the message list.
	const suppressed = [userMsg("plain user turn"), userMsg("another turn")];
	const verdict = decideInjection(
		{ staged: STAGED, tailMode: true },
		texts({ messages: suppressed }),
		true,
	);
	assert.equal(verdict.landed, false);
	assert.equal(verdict.recovered, "recomposed");

	// The caller repairs the view: the block is present after confirmInjection.
	const out = confirmInjection(
		runtime,
		configStub(),
		{ messages: [...suppressed] },
		"sess_inject",
	);
	assert.ok(
		texts(out).some((t) => t.includes(blockMarker(STAGED))),
		"recomposed view must contain the staged block marker",
	);
	assert.equal(out.messages.length, suppressed.length + 1);
	assert.ok(events.some((e) => e.name === "injection_recovered"));
	assert.equal(
		events.find((e) => e.name === "injection_recovered")?.payload.via,
		"recomposed",
	);
});

test("3WF-4/1b: block already present -> landed=true, view untouched", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const { runtime, events } = runtimeStub(store, { pendingRecallBlock: STAGED });
	const landedMsgs = [userMsg("plain user turn"), userMsg(STAGED)];
	const out = confirmInjection(
		runtime,
		configStub(),
		{ messages: landedMsgs },
		"sess_inject",
	);
	assert.deepEqual(out.messages, landedMsgs);
	assert.equal(out.messages.length, 2);
	const confirmed = events.find((e) => e.name === "injection_confirmed");
	assert.equal(confirmed?.payload.landed, true);
	assert.equal(confirmed?.payload.mode, "tail");
	assert.ok(!events.some((e) => e.name === "injection_recovered"));
});

// --- Test 2: no pending blocks either -> floor ------------------------------

test("3WF-4/2: recompose impossible -> shared floor block appended", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	seed(store, ["earlier work on the sqlite migration"]);

	// Pure decision: staged marker missing from the view AND no pending block
	// remains to re-compose from -> the floor rung.
	const verdict = decideInjection(
		{ staged: STAGED, tailMode: true },
		["plain user turn"],
		false,
	);
	assert.equal(verdict.landed, false);
	assert.equal(verdict.recovered, "floor");

	// Integration through the real caller. The block is visible when the marker
	// is captured but consumed before withRecallTail re-reads it — the genuine
	// "staged, injected once, then suppressed downstream" race. The single-shot
	// getter models that consumption; the store + checkpoints are all REAL.
	const { runtime, events } = runtimeStub(store, { pendingRecallBlock: STAGED });
	const racing = new Proxy(runtime, {
		get(target, prop, recv) {
			if (prop === "pendingRecallBlock") {
				const seen = (target as unknown as { _seen?: boolean })._seen;
				(target as unknown as { _seen?: boolean })._seen = true;
				return seen ? undefined : STAGED;
			}
			return Reflect.get(target, prop, recv);
		},
	}) as typeof runtime;
	const out = confirmInjection(
		racing,
		configStub(),
		{ messages: [userMsg("plain user turn")] },
		"sess_inject",
	);
	// The appended text is EXACTLY the shared floor builder's output over the
	// session's real checkpoints (proves the floor rung + shared module).
	const floor = buildFloorBlock(vectorList(store, "sess_inject"));
	assert.equal(out.messages.length, 2, "floor message appended");
	assert.equal(texts(out)[1], floor.text, "floor text is the shared builder's");
	assert.equal(floor.basis, "lastCheckpoint");
	const recovered = events.find((e) => e.name === "injection_recovered");
	assert.equal(recovered?.payload.via, "floor");
	assert.equal(recovered?.payload.basis, "lastCheckpoint");
});

// --- Test 3: legacy prepend mode --------------------------------------------

test("3WF-4/3: prepend mode verifies the return string, never crashes", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	seed(store, ["legacy prepend path"]);
	const { runtime, events } = runtimeStub(store, { pendingRecallBlock: STAGED });
	const cfg = configStub({ recallTailInject: false });

	// Message list LACKS the block (prepend mode never puts it there).
	const msgs = [userMsg("plain user turn")];
	const out = confirmInjection(runtime, cfg, { messages: [...msgs] }, "sess_inject");
	// View is passed through unchanged (no tail append in prepend mode).
	assert.deepEqual(texts(out), texts({ messages: msgs }));
	const ev = events.find((e) => e.name === "injection_confirmed");
	assert.equal(ev?.payload.mode, "prepend");
	assert.equal(ev?.payload.landed, false, "string-contains reports the miss");
	assert.ok(!events.some((e) => e.name === "injection_recovered"));

	// And when the composed value DOES contain the block, landed is true.
	const { runtime: r2, events: e2 } = runtimeStub(store, {
		pendingRecallBlock: STAGED,
	});
	confirmInjection(r2, cfg, { messages: [userMsg(STAGED)] }, "sess_inject");
	assert.equal(
		e2.find((e) => e.name === "injection_confirmed")?.payload.landed,
		true,
	);
});

// --- Test 4: umbrella flag OFF ---------------------------------------------

test("3WF-4/4: umbrella OFF -> byte-identical pass-through, no telemetry", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	seed(store, ["flag off identity"]);
	const { runtime, events } = runtimeStub(store, { pendingRecallBlock: STAGED });
	const msgs = [userMsg("plain user turn"), userMsg("second turn")];
	const view = { messages: msgs };
	const out = confirmInjection(
		runtime,
		configStub({ threeWayFailback: false }),
		view,
		"sess_inject",
	);
	// Same object identity: nothing composed, nothing appended, nothing logged.
	assert.equal(out, view);
	assert.deepEqual(out.messages, msgs);
	assert.equal(events.length, 0, "flag OFF emits no 3WF-4 telemetry");
});

test("3WF-4/4b: nothing staged -> no assertion, view untouched", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const { runtime } = runtimeStub(store);
	const msgs = [userMsg("plain user turn")];
	const out = confirmInjection(runtime, configStub(), { messages: msgs }, "s");
	assert.deepEqual(out.messages, msgs);
	assert.equal(
		decideInjection({ staged: null, tailMode: true }, [], false).landed,
		true,
	);
});

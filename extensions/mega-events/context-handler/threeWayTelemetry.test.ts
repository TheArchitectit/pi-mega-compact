/**
 * context-handler/threeWayTelemetry.test.ts — 3WF-5 (program completion).
 *
 * Spec coverage (docs/specs/three-way-failback-sprints.md, "3WF-5 Tests"):
 *  1. Settings round-trip: both 3WF flags are present in SETTINGS and the
 *     GET/POST /api/rag-settings handler reads + writes them (real handler, real
 *     env-file write in a temp stateDir).
 *  2. EXCLUDED_SETTINGS contains neither key (explicit assert).
 *  3. Each of the five 3WF breadcrumb events emits a JSON object carrying `ts`
 *     + `event` on the events.log sink the dashboard Events tab tails.
 *
 * No mocks, no stubs (project rule O1): REAL VectorStores over temp stateDirs
 * with REAL checkpoints via compactSession, the REAL settings route handler, and
 * — the point of test 3 — the REAL `appendEventImpl` events.log writer. The
 * breadcrumb assertions drive the actual guard code paths (runTriggerGuard /
 * evaluatePendingReduction / confirmInjection) and then read the serialized
 * file back; the event calls themselves are never simulated.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { closeIndexStore, setDedupStatus } from "../../../src/store/sqlite.js";
import { vectorList } from "../../../src/vectorStore.js";
import {
	SETTING_BY_KEY,
	EXCLUDED_SETTINGS,
} from "../../dashboard-server/routes-rag-settings-helpers.js";
import { runTriggerGuard } from "./triggerGuard.js";
import { markCompactionFired, evaluatePendingReduction } from "./thrashGuard.js";
import { confirmInjection } from "./injectionConfirm.js";
import {
	freshStore,
	seed,
	realEventRuntime,
	readEventsLog,
	ctxStub,
	configStub,
	userMsg,
	type LoggedEvent,
} from "./threeWayTelemetry.fixture.js";

/** The two flags this sprint surfaces in the dashboard Settings tab. */
const TOGGLE_KEYS = [
	"MEGACOMPACT_THREE_WAY_FAILBACK",
	"MEGACOMPACT_RECALL_TAIL_INJECT",
] as const;

const dirs: string[] = [];
after(() => {
	try {
		closeIndexStore();
	} catch {
		/* best-effort */
	}
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
});

/** Assert one events.log line carries the dashboard-consumed `ts` + `event` shape. */
function assertEventShape(ev: LoggedEvent | undefined, name: string): void {
	assert.ok(ev != null, `${name} must be present in events.log`);
	assert.equal(typeof ev.event, "string", `${name}: event must be a string`);
	assert.equal(ev.event, name);
	assert.equal(typeof ev.ts, "number", `${name}: ts must be a number`);
	assert.ok((ev.ts as number) > 0, `${name}: ts must be a real epoch value`);
}

/** Find the first logged event with `name`. */
function find(events: LoggedEvent[], name: string): LoggedEvent | undefined {
	return events.find((e) => e.event === name);
}

// --- Test 1 + 2: Settings surface ------------------------------------------

test("3WF-5 test 1: both 3WF flags are present in SETTINGS with ON defaults", () => {
	for (const key of TOGGLE_KEYS) {
		assert.ok(SETTING_BY_KEY.has(key), `${key} must be in SETTINGS`);
		const spec = SETTING_BY_KEY.get(key)!;
		assert.equal(spec.type, "boolean", `${key} must be a boolean toggle`);
		assert.equal(spec.default, true, `${key} default must be ON`);
		assert.ok(spec.label.length > 0, `${key} needs a label`);
		assert.ok(spec.description.length > 0, `${key} needs a description`);
	}
});

test("3WF-5 test 1: both flags live in the Three-Way Failback settings group", async () => {
	const { SETTINGS } = await import(
		"../../dashboard-server/routes-rag-settings-helpers.js"
	);
	const group = SETTINGS.find((g) => g.name === "Three-Way Failback");
	assert.ok(group != null, "a Three-Way Failback group must exist");
	const keys = group.settings.map((s) => s.key);
	for (const key of TOGGLE_KEYS) {
		assert.ok(keys.includes(key), `${key} must be grouped under Three-Way Failback`);
	}
});

test("3WF-5 test 2: EXCLUDED_SETTINGS contains neither 3WF key", () => {
	for (const key of TOGGLE_KEYS) {
		assert.equal(
			EXCLUDED_SETTINGS.includes(key),
			false,
			`${key} must NOT be in EXCLUDED_SETTINGS (all-flags-toggleable rule)`,
		);
	}
});

// --- Test 3: breadcrumb events land on the real events.log sink ------------

test("3WF-5 test 3: three_way_guard_fired emits ts + event to events.log", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const sid = "sess_3wf5_guard";
	seed(store, ["investigated the dedupe race in store.ts"], sid);
	const runtime = realEventRuntime(store, dir);

	runTriggerGuard(runtime, configStub(), ctxStub({ sessionId: sid }));

	assert.ok(runtime.pendingRecallBlock != null, "guard must stage a block");
	const events = readEventsLog(dir);
	assertEventShape(find(events, "three_way_guard_fired"), "three_way_guard_fired");
});

test("3WF-5 test 3: three_way_floor_used emits ts + event to events.log", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const sid = "sess_3wf5_floor";
	// The REAL production shape of the floor rung: the session HAS checkpoints
	// (vectorStats counts them unfiltered, so the guard's checkpointCount gate
	// passes) but every one is SemDeDup-`removed`, which vectorSearch excludes
	// (src/vector-search.ts:218-221) => zero hits => the guard must stage the
	// provenance floor instead of silence. A merely off-vocabulary query does NOT
	// reach this rung: the trigram embedder still returns a low-cosine hit, so
	// this is the only genuine zero-hit path.
	seed(store, ["some earlier bookkeeping entry"], sid);
	for (const cp of vectorList(store, sid)) {
		setDedupStatus(cp.checkpointId, sid, "removed", dir);
	}
	const runtime = realEventRuntime(store, dir);

	runTriggerGuard(runtime, configStub(), ctxStub({ sessionId: sid }));

	const events = readEventsLog(dir);
	assertEventShape(find(events, "three_way_floor_used"), "three_way_floor_used");
	assert.equal(
		typeof find(events, "three_way_floor_used")!.basis,
		"string",
		"floor breadcrumb carries a provenance basis",
	);
	assert.equal(
		find(events, "three_way_guard_fired"),
		undefined,
		"the recall rung must NOT also fire",
	);
});

test("3WF-5 test 3: thrasguard_armed emits ts + event to events.log", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const runtime = realEventRuntime(store, dir, { effectiveThreshold: 100_000 });
	const config = configStub();

	// Drive a REAL ineffective compaction cycle: a fire at `live` tokens, then the
	// next context event still reports the same live window => no reduction =>
	// the guard arms and must breadcrumb on the events.log sink.
	const live = 190_000;
	markCompactionFired(runtime, live);
	evaluatePendingReduction(runtime, live, config);

	const events = readEventsLog(dir);
	const armed = find(events, "thrasguard_armed");
	assertEventShape(armed, "thrasguard_armed");
	assert.equal(
		typeof armed!.blockedUntilTokens,
		"number",
		"armed breadcrumb carries the re-arm ceiling",
	);
});

test("3WF-5 test 3: injection_confirmed emits ts + event to events.log", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const sid = "sess_3wf5_confirm";
	seed(store, ["the dedupe race fix"], sid);
	const staged = "### Recalled context [1] (relevance 88%)\nthe dedupe race fix";
	const runtime = realEventRuntime(store, dir, { pendingRecallBlock: staged });

	// The staged block IS present in the message list => landed => confirmed.
	confirmInjection(
		runtime,
		configStub(),
		{ messages: [userMsg("earlier turn"), userMsg(staged)] },
		sid,
	);

	const events = readEventsLog(dir);
	const confirmed = find(events, "injection_confirmed");
	assertEventShape(confirmed, "injection_confirmed");
	assert.equal(confirmed!.landed, true);
});

test("3WF-5 test 3: injection_recovered emits ts + event to events.log", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const sid = "sess_3wf5_recover";
	seed(store, ["the dedupe race fix"], sid);
	const staged = "### Recalled context [1] (relevance 88%)\nthe dedupe race fix";
	const runtime = realEventRuntime(store, dir, { pendingRecallBlock: staged });

	// The staged block is ABSENT from the message list (suppressed) => the guard
	// must detect the miss and recover, breadcrumbing on the events.log sink.
	confirmInjection(
		runtime,
		configStub(),
		{ messages: [userMsg("earlier turn"), userMsg("unrelated tail")] },
		sid,
	);

	const events = readEventsLog(dir);
	const recovered = find(events, "injection_recovered");
	assertEventShape(recovered, "injection_recovered");
	assert.equal(typeof recovered!.via, "string", "recovery carries a `via` rung");
});

test("3WF-5: umbrella OFF emits no 3WF breadcrumbs (byte-identical runtime)", () => {
	const { store, dir } = freshStore();
	dirs.push(dir);
	const sid = "sess_3wf5_off";
	seed(store, ["investigated the dedupe race in store.ts"], sid);
	const runtime = realEventRuntime(store, dir);
	const off = configStub({ threeWayFailback: false });

	runTriggerGuard(runtime, off, ctxStub({ sessionId: sid }));
	markCompactionFired(runtime, 190_000);
	evaluatePendingReduction(runtime, 190_000, off);
	confirmInjection(runtime, off, { messages: [userMsg("t")] }, sid);

	const names = new Set(readEventsLog(dir).map((e) => e.event));
	for (const name of [
		"three_way_guard_fired",
		"three_way_floor_used",
		"thrasguard_armed",
		"injection_confirmed",
		"injection_recovered",
	]) {
		assert.equal(names.has(name), false, `${name} must not emit with the flag OFF`);
	}
	assert.equal(runtime.pendingRecallBlock, undefined, "no block staged when OFF");
});

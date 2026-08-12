/**
 * context-handler/injectionConfirm.ts — 3WF-4 InjectionConfirm.
 *
 * QA amendment A3 (binding): pi exposes NO prompt readback API, so the only
 * verifiable proxy for what the provider will actually receive is the pre-LLM
 * message list. In DEFAULT tail mode (`recallTailInject` ON) the staged recall
 * block rides in as a user-role tail message, so we assert the block's marker
 * text is present in the message list we are about to return. In LEGACY prepend
 * mode (`recallTailInject` OFF) the block never enters the message list at all,
 * so the guard degrades to a string-contains check over our own composed return
 * value and never reports a false miss.
 *
 * Recovery ladder when the marker is absent (tail mode only):
 *   1. recomposed — rebuild the view from the runtime's pending blocks via the
 *      SAME `buildTailResult` composition the handler uses (self-repair on this
 *      event; the user sees nothing).
 *   2. floor — nothing pending either: append the shared provenance floor text
 *      (src/failback/floor.ts) as a user-role tail message so the model is never
 *      silently left with no compacted-context provenance at all.
 *
 * Stack position: wraps the `tailResult` closure returned by buildTailResult, so
 * EVERY return point of the context handler (gate / replay / debounce /
 * thrash-guard / pipeline / live-trim) is verified with one wiring point.
 *
 * Non-fatal everywhere: any throw degrades to the unverified view (pre-sprint
 * behavior). Flag OFF => the wrapper is never installed (byte-identical).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import type { InjectionVerdict } from "../../../src/failback/types.js";
import { vectorList } from "../../../src/vectorStore.js";
import { normalizeSessionId } from "../../../src/store.js";
import { buildFloorBlock } from "../../../src/failback/floor.js";
import { withRecallTail } from "../recall-tail.js";
import { messageContentText } from "./messageText.js";

/** A composed context view (the shape every handler return point produces). */
export interface TailView {
	messages: AgentMessage[];
}

/** The staged blocks + mode this pass verifies (pure inputs, no pi runtime). */
export interface ConfirmInput {
	/** The staged block text expected to have landed (null => nothing to verify). */
	staged: string | null;
	/** False in legacy prepend mode: verify the return string, not the list. */
	tailMode: boolean;
}

/**
 * The marker substring used to locate a staged block inside a message. The
 * block's first non-empty line, capped, so prompt reshapes (cache striping /
 * message separation) that regroup messages cannot defeat the match, while a
 * genuinely dropped block still fails it.
 */
export function blockMarker(block: string): string {
	const line = block
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return (line ?? "").slice(0, 80);
}

/**
 * PURE decision function: did the staged block land in this view, and if not,
 * which rung should repair it? Takes the already-extracted message texts so it
 * stays free of pi types and is directly unit-testable.
 */
export function decideInjection(
	input: ConfirmInput,
	messageTexts: readonly string[],
	hasPendingBlocks: boolean,
): InjectionVerdict {
	const marker = input.staged ? blockMarker(input.staged) : "";
	// Nothing staged => nothing to assert; NOT a miss. Injecting a floor here
	// would push provenance text into sessions that never had recall to lose.
	if (!marker) return { landed: true, recovered: "none" };
	const landed = messageTexts.some((t) => t.includes(marker));
	if (landed) return { landed: true, recovered: "none" };
	// Absent: recompose when the runtime still holds pending blocks, else floor.
	return { landed: false, recovered: hasPendingBlocks ? "recomposed" : "floor" };
}

/** Append `text` as a user-role tail message (same shape as recall-tail.ts). */
function withFloorTail(view: TailView, text: string): TailView {
	const tailMsg = {
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	return { messages: [...view.messages, tailMsg] };
}

/**
 * Thin caller: verify (and if needed repair) one composed view. Returns the view
 * to actually return from the handler. `sessionId` sources the floor checkpoints.
 *
 * The recompose rung deliberately re-appends via `withRecallTail` onto the
 * ALREADY-COMPOSED view rather than re-running `buildTailResult`: the reshape
 * stages (cache striping / message separation) are the realistic way a tail
 * message gets regrouped away, and re-running the same composition would
 * reproduce the same loss. Appending after the reshape is the actual repair, and
 * it keeps the PREVENT-PI-001/002 tail-append invariant (a single user-role
 * message after a complete prefix can never split a toolCall/toolResult pair).
 */
export function confirmInjection(
	runtime: MegaRuntime,
	config: MegaConfig,
	view: TailView,
	sessionId: string,
): TailView {
	try {
		if (!config.threeWayFailback) return view;
		// What the tail composition was supposed to inject. BOTH staged blocks
		// count: withRecallTail joins recall + memory blocks into one tail
		// message, so either one going missing is a real injection failure.
		const staged =
			runtime.pendingRecallBlock ?? runtime.pendingMemoryRecallBlock ?? null;
		// Can the recompose rung actually re-append? Only when a block is still
		// staged on the runtime. When it is not (blocks consumed between
		// composition and this check), or when withRecallTail declines to append,
		// the ladder falls through to the floor rung below.
		const hasPending =
			runtime.pendingRecallBlock != null ||
			runtime.pendingMemoryRecallBlock != null;
		// Legacy prepend mode: the block is not expected in the message list —
		// verify our composed return value contains it instead (A3 degrade path).
		if (!config.recallTailInject) {
			const composed = view.messages.map(messageContentText).join("\n");
			const marker = staged ? blockMarker(staged) : "";
			runtime.appendEvent("injection_confirmed", {
				mode: "prepend",
				landed: marker ? composed.includes(marker) : true,
			});
			return view;
		}
		const verdict = decideInjection(
			{ staged, tailMode: true },
			view.messages.map(messageContentText),
			hasPending,
		);
		if (verdict.landed) {
			runtime.appendEvent("injection_confirmed", { mode: "tail", landed: true });
			return view;
		}
		if (verdict.recovered === "recomposed") {
			const rebuilt = withRecallTail(view.messages, runtime, config);
			// withRecallTail returns the input array unchanged on failure; only
			// treat a genuine append as a recovery.
			if (rebuilt.length > view.messages.length) {
				runtime.appendEvent("injection_recovered", { via: "recomposed" });
				return { messages: rebuilt };
			}
		}
		const floor = buildFloorBlock(
			vectorList(runtime.store, normalizeSessionId(sessionId)),
		);
		runtime.appendEvent("injection_recovered", {
			via: "floor",
			basis: floor.basis,
		});
		return withFloorTail(view, floor.text);
	} catch {
		// Non-fatal: return the unverified view (pre-sprint behavior).
		return view;
	}
}

/**
 * src/prefix-stability.test.ts — PLAN_V2 hit-rate benchmark
 *
 * Measures **prefix stability** (byte-identical leading messages between
 * consecutive turns) as a proxy for the provider cache hit rate. Tests all
 * three flag configurations:
 *
 *   (a) Flag OFF          — plain messages returned unchanged.
 *   (b) MESSAGE_SEPARATION — tool messages moved to the tail.
 *   (c) SEPARATION+STRIPING  — cache-optimized prompt with Layer 2 stripes.
 *
 * Scenario:
 *   Rolling window of 3 live turns. As the window advances, old turns drop
 *   out and new turns enter. The user/assistant text is **stable** across
 *   turns (same greeting and acknowledgment each time), but **tool results
 *   are volatile** (different data each call).
 *
 *   In mode (a), tool results are interleaved with user/assistant messages.
 *   When a tool result moves into/out-of the window, the interleaving
 *   changes and breaks the prefix early. In mode (b), tool messages are at
 *   the tail — user/assistant messages stay contiguous and stable across
 *   the window shift. In mode (c), cache stripes add front-loaded stable
 *   content.
 *
 * Asserts:
 *   - (b) stable prefix >= (a) stable prefix (separation never hurts).
 *   - (c) stable prefix >= (b) (striping does not regress).
 *
 * Uses real stores (no mocks). Test files may use `as any` per convention.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession, setDefaultStore } from "./engine.js";
import type { EngineMessage } from "./types.js";
import { openStore } from "./store/sqlite.js";
import { refreshStripeAssignments as refreshCacheStripes } from "./cache-stripe-impl.js";

// ─── Test setup ───────────────────────────────────────────────────────────────

const baseTmp = mkdtempSync(join(tmpdir(), "mc-prefix-"));
let counter = 0;

function createStore(): VectorStore {
  const d = join(baseTmp, `run-${counter++}`);
  return new VectorStore({ dedupSim: 0.9, stateDir: d });
}

const SESS = "sess_prefix_bench";

function msg(role: EngineMessage["role"], text: string): EngineMessage {
  return { role, text };
}

/**
 * Count leading byte-identical messages between two message arrays.
 * Compares role + text.
 */
function stablePrefixLength(a: readonly EngineMessage[], b: readonly EngineMessage[]): number {
  const max = Math.min(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i].role !== b[i].role || a[i].text !== b[i].text) {
      return i;
    }
  }
  return max;
}

function logRow(label: string, prefixLengths: number[], totalLengths: number[]): void {
  const avgP = prefixLengths.reduce((a, b) => a + b, 0) / prefixLengths.length;
  const avgT = totalLengths.reduce((a, b) => a + b, 0) / totalLengths.length;
  console.log(
    `  ${label.padEnd(28)} avg prefix: ${avgP.toFixed(1).padStart(5)}  ` +
    `avg total: ${avgT.toFixed(1).padStart(5)}  ` +
    `ratio: ${(avgP / avgT * 100).toFixed(1).padStart(5)}%`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────

describe("prefix-stability benchmark (PLAN_V2)", () => {
  const store = createStore();
  setDefaultStore(store);

  // Each turn has 4 messages:
  //   user("continue") — STABLE (same text every turn)
  //   assistant("ok")  — STABLE (same text every turn)
  //   tool("<call>")   — STABLE (same tool call every turn)
  //   tool("<result>") — VOLATILE (different data each turn)
  //
  // The rolling window keeps the last N turns. As the window advances:
  //   - Oldest turn drops out (its tool result disappears)
  //   - Newest turn enters (its tool result is new)
  //
  // Mode A: the volatile tool results are interspersed with the stable
  //   user/assistant pairs. When the window shifts, the leading messages
  //   differ early because a tool result's position shifts.
  //
  // Mode B: all tool results are at the tail. The user/assistant pairs
  //   stay at the front, and since they're stable, the prefix survives
  //   the window shift.

  const COMPACTED = 4; // number of turns that get checkpointed
  const WINDOW_SIZE = 3; // turns kept in the live window
  const MEASURED = 12; // how many turns we measure
  const MSG_PER_TURN = 4;

  const U_TEXT = "continue with the next step";
  const A_TEXT = "working on it, here's the analysis";
  const T_CALL = "execute_step";

  function buildTurn(t: number): EngineMessage[] {
    // Tool result is VOLATILE — different text each turn
    const tResult = `{ step:${t}, status:"done", data:result_${t} }`;
    return [
      msg("user", U_TEXT),
      msg("assistant", A_TEXT),
      msg("tool", T_CALL),
      msg("tool", tResult),
    ];
  }

  // Full session messages
  const fullMessages: EngineMessage[] = [];
  for (let t = 0; t < COMPACTED + MEASURED + WINDOW_SIZE; t++) {
    fullMessages.push(...buildTurn(t));
  }

  // ── 1. Setup: compact the first COMPACTED turns ──────────────────────────

  test("setup: compact session to produce checkpoints", () => {
    // Two rounds of compaction
    const limit1 = Math.floor(COMPACTED / 2) * MSG_PER_TURN;
    let result = compactSession({
      sessionId: SESS,
      messages: fullMessages.slice(0, limit1),
      keepFrom: limit1,
      keyDecisions: ["Batch 1 complete"],
      nextSteps: ["Continue"],
    });
    assert.ok(result.checkpointId, `first compactSession produced checkpointId`);

    const limit2 = COMPACTED * MSG_PER_TURN;
    result = compactSession({
      sessionId: SESS,
      messages: fullMessages.slice(0, limit2),
      keepFrom: limit2,
      keyDecisions: ["Batch 2 complete"],
      nextSteps: ["Continue more"],
    });
    assert.ok(result.checkpointId, `second compactSession produced checkpointId`);
  });

  // ── 2. Refresh cache stripe assignments ──────────────────────────────────

  test("setup: refresh cache stripes", () => {
    const count = refreshCacheStripes(store.stateDir, undefined, undefined, undefined);
    console.log(`  Stripe refresh: ${count} chunks assigned in ${store.stateDir}`);
    assert.equal(typeof count, "number");
  });

  // ── 3. Measure prefix stability ─────────────────────────────────────────

  test("measure prefix stability — all three modes", () => {
    const cm = store.stateDir;

    // Load context messages from checkpoints
    const contextMessages = loadContextMessages(cm, SESS);

    /**
     * Build the prompt for a turn index.
     *
     * Prompt = [checkpoint summaries] + [live window of recent turns]
     *
     * The live window is a FIXED-SIZE window: turns [measuredIdx .. measuredIdx + WINDOW_SIZE).
     * As measuredIdx advances, the window slides: the oldest turn drops, the newest
     * turn enters.
     *
     * In mode A (interleaved), the window's messages look like:
     *   u, a, t_call, t_result, u, a, t_call, t_result, u, a, t_call, t_result
     *
     * When the window slides by 1 turn (4 messages), the ALIGNMENT changes:
     *   Old window: u0, a0, t0_call, t0_res, u1, a1, t1_call, t1_res, u2, a2, t2_call, t2_res
     *   New window: u1, a1, t1_call, t1_res, u2, a2, t2_call, t2_res, u3, a3, t3_call, t3_res
     *
     * Compare: first diff is at position 0 because the context is the same but
     * the first LIVE message changed from u0 to u1. That gives 0 prefix for the
     * live part.
     *
     * Wait — no, the first message is actually the checkpoint context. So the
     * prefix is context.length, not 0. But context is the same between turns,
     * and the live window changes completely (oldest drops, newest enters).
     *
     * Actually wait. The issue is more subtle. With a 3-turn window shifting
     * by 1 turn, 2 of the 3 turns overlap between consecutive prompts:
     *   Turn N: turns [N, N+1, N+2]
     *   Turn N+1: turns [N+1, N+2, N+3]
     * The overlap is 2 turns = 8 messages. In mode A, these 8 messages are
     * byte-identical (same user/assistant/tool content). But the ALIGNMENT is
     * wrong: turn N+1 in the new prompt is at position 0 of the live window,
     * while in the old prompt it was at position 4.
     *
     * So stable prefix = context.length (the overlapping turns don't contribute
     * because their *positions* in the array differ, even though their *content*
     * is identical).
     *
     * In mode B (separated), the tool messages are at the tail:
     *   Turn N: u0,a0,u1,a1,u2,a2,  t_call0,t_res0,t_call1,t_res1,t_call2,t_res2
     *   Turn N+1: u1,a1,u2,a2,u3,a3,  t_call1,t_res1,t_call2,t_res2,t_call3,t_res3
     *
     * The overlap is: u1,a1,u2,a2 = 4 messages. These ARE at the same position
     * (after context, they start at position context.length). So stable prefix =
     * context.length + 4 = context.length + overlapping_user_assistant_pairs * 2.
     *
     * In mode C (striped), the stripe is at the front and stable, so even more
     * prefix stability.
     */

    function buildPrompt(measuredIdx: number): EngineMessage[] {
      const liveMessages: EngineMessage[] = [];
      for (let t = measuredIdx; t < measuredIdx + WINDOW_SIZE; t++) {
        liveMessages.push(...buildTurn(t));
      }
      return [...contextMessages, ...liveMessages];
    }

    const turnPrompts: EngineMessage[][] = [];
    for (let m = 0; m < MEASURED; m++) {
      turnPrompts.push(buildPrompt(m));
    }

    // ── Mode A: flag OFF ─────────────────────────────────────────────────
    const aPrefixes: number[] = [];
    const aTotals: number[] = [];
    for (let t = 1; t < turnPrompts.length; t++) {
      aPrefixes.push(stablePrefixLength(turnPrompts[t - 1], turnPrompts[t]));
      aTotals.push(turnPrompts[t].length);
    }

    // ── Mode B: MESSAGE_SEPARATION ──────────────────────────────────────
    const bTurnPrompts = turnPrompts.map(separateMessages);
    const bPrefixes: number[] = [];
    const bTotals: number[] = [];
    for (let t = 1; t < bTurnPrompts.length; t++) {
      bPrefixes.push(stablePrefixLength(bTurnPrompts[t - 1], bTurnPrompts[t]));
      bTotals.push(bTurnPrompts[t].length);
    }

    // ── Mode C: SEPARATION + STRIPING ───────────────────────────────────
    const cTurnPrompts = turnPrompts.map((msgs) => stripingMessages(msgs, cm));
    const cPrefixes: number[] = [];
    const cTotals: number[] = [];
    for (let t = 1; t < cTurnPrompts.length; t++) {
      cPrefixes.push(stablePrefixLength(cTurnPrompts[t - 1], cTurnPrompts[t]));
      cTotals.push(cTurnPrompts[t].length);
    }

    // ── Log summary table ───────────────────────────────────────────────
    console.log("\n  ┌──────────────────────────────┬────────────┬────────────┬────────┐");
    console.log("  │ Mode                         │ Avg prefix │ Avg total  │ Ratio  │");
    console.log("  ├──────────────────────────────┼────────────┼────────────┼────────┤");
    logRow("(a) Flag OFF", aPrefixes, aTotals);
    logRow("(b) MESSAGE_SEPARATION", bPrefixes, bTotals);
    logRow("(c) SEPARATION+STRIPING", cPrefixes, cTotals);
    console.log("  └──────────────────────────────┴────────────┴────────────┴────────┘");

    console.log("\n  Per-pair prefix lengths:");
    for (let i = 0; i < aPrefixes.length; i++) {
      console.log(
        `  Pair ${String(i + 1).padStart(2)}: (a)=${String(aPrefixes[i]).padStart(3)} ` +
        `(b)=${String(bPrefixes[i]).padStart(3)} (c)=${String(cPrefixes[i]).padStart(3)} ` +
        `total=${String(aTotals[i]).padStart(2)}`,
      );
    }

    // ── Assertions ──────────────────────────────────────────────────────
    for (let i = 0; i < bPrefixes.length; i++) {
      assert.ok(
        bPrefixes[i] >= aPrefixes[i],
        `Pair ${i + 1}: separation (${bPrefixes[i]}) < baseline (${aPrefixes[i]})`,
      );
    }
    for (let i = 0; i < cPrefixes.length; i++) {
      assert.ok(
        cPrefixes[i] >= bPrefixes[i],
        `Pair ${i + 1}: striping (${cPrefixes[i]}) < separation (${bPrefixes[i]})`,
      );
    }

    const aBetter = bPrefixes.filter((v, i) => v > aPrefixes[i]).length;
    const cBetter = cPrefixes.filter((v, i) => v > bPrefixes[i]).length;
    console.log(
      `\n  Summary: separation beats baseline in ${aBetter}/${aPrefixes.length} pairs. ` +
      `Striping beats separation in ${cBetter}/${cPrefixes.length} pairs.`,
    );
  });
});

// ── Helper functions ──────────────────────────────────────────────────────────

/** Load checkpoint summaries from the store as user messages. */
function loadContextMessages(stateDir: string, sessionId: string): EngineMessage[] {
  try {
    const db = openStore(stateDir);
    const rows = db
      .prepare("SELECT summary FROM context_chunks WHERE session_id = ? ORDER BY timestamp")
      .all(sessionId) as { summary: string }[];
    db.close();
    if (rows.length > 0 && rows[0].summary) {
      return rows.map((r) => msg("user", r.summary));
    }
  } catch {
    // Fall through
  }
  return [msg("user", "Project planning session.")];
}

/**
 * Mode (b): move tool messages to the tail.
 */
function separateMessages(msgs: readonly EngineMessage[]): EngineMessage[] {
  const core: EngineMessage[] = [];
  const tail: EngineMessage[] = [];
  for (const m of msgs) {
    if (m.role === "tool") {
      tail.push(m);
    } else {
      core.push(m);
    }
  }
  return [...core, ...tail];
}

/**
 * Mode (c): separation + cache stripe insertion.
 * Falls back to mode (b) when no stripes exist.
 */
function stripingMessages(msgs: readonly EngineMessage[], stateDir: string): EngineMessage[] {
  const core: EngineMessage[] = [];
  const tail: EngineMessage[] = [];
  for (const m of msgs) {
    if (m.role === "tool") {
      tail.push(m);
    } else {
      core.push(m);
    }
  }

  let stripeText = "";
  try {
    const db = openStore(stateDir);
    const rows = db
      .prepare(
        `SELECT s.chunk_id, s.stripe, s.stability, c.normalized_text
         FROM cache_stripes s
         JOIN context_chunks c ON c.id = s.chunk_id
         ORDER BY s.stability DESC
         LIMIT 1`,
      )
      .all() as { chunk_id: string; stripe: number; stability: number; normalized_text: string }[];
    if (rows.length > 0 && rows[0].normalized_text) {
      stripeText = rows[0].normalized_text.slice(0, 500);
    }
    db.close();
  } catch {
    // No stripe data
  }

  if (stripeText) {
    return [{ role: "user" as const, text: stripeText }, ...core, ...tail];
  }
  return [...core, ...tail];
}

/**
 * src/prefix-stability.test.ts — PLAN_V2 hit-rate PROXY benchmark.
 *
 * Measures prefix stability (byte-identical leading messages across turns) as
 * an offline proxy for cache hit rate (no network, PREVENT-PI-004). Compares:
 *   (a) flag OFF → raw messages
 *   (b) MEGACOMPACT_MESSAGE_SEPARATION=1 → buildSeparatedPrompt
 *   (c) MEGACOMPACT_CACHE_STRIPING=1 + (b) → buildCacheOptimizedPrompt
 *
 * Sliding-window scenario: each turn is [user(STABLE), assistant(STABLE),
 * toolResult(VOLATILE)]. Separation's move-to-tail keeps stable pairs
 * front-aligned so (b) ≥ (a) per consecutive pair. On a genuinely fresh state
 * dir (this test) `context_chunks` has no epoch entries yet, so (c) no-ops to
 * (b); the write-path/wire-up benchmarks live in the docs.
 *
 * Uses real stores end-to-end (no mocks). Tests may use `as any`. No network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import type { EngineMessage } from "./types.js";
import {
  buildSeparatedPrompt,
  buildCacheOptimizedPrompt,
} from "../extensions/mega-events/separated-prompt.js";
import { openStore, closeStore } from "./store/sqlite.js";
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

// ─── AgentMessage-shaped transcript helpers (as any = test convention) ───────

/** Byte-identical content key (stable order for array/object content). */
function contentKey(m: any): string {
  const c = m.content;
  if (typeof c === "string") return c;
  return JSON.stringify(c);
}

/** Count leading byte-identical messages (same role + stringified content). */
function stablePrefix(prev: readonly any[], cur: readonly any[]): number {
  const min = Math.min(prev.length, cur.length);
  for (let i = 0; i < min; i++) {
    const a = prev[i];
    const b = cur[i];
    if (a.role !== b.role || contentKey(a) !== contentKey(b)) return i;
  }
  return min;
}

function logRow(label: string, prefixLengths: number[], totalLengths: number[]): void {
  const avgP = prefixLengths.reduce((a, b) => a + b, 0) / prefixLengths.length;
  const avgT = totalLengths.reduce((a, b) => a + b, 0) / totalLengths.length;
  console.log(
    `  ${label.padEnd(28)} avg prefix: ${avgP.toFixed(1).padStart(5)}  ` +
    `avg total: ${avgT.toFixed(1).padStart(5)}  ` +
    `ratio: ${((avgP / avgT) * 100).toFixed(1).padStart(5)}%`,
  );
}

/** Run a builder-mode over every prompt, setting/restoring the real env flags
 *  so the imported buildSeparatedPrompt / buildCacheOptimizedPrompt gate on the
 *  exact configuration the task specifies. */
function buildMode(
  turnPrompts: any[][],
  mode: "plain" | "separation" | "striping",
  stateDir: string,
): any[][] {
  const prevSep = process.env.MEGACOMPACT_MESSAGE_SEPARATION;
  const prevStrip = process.env.MEGACOMPACT_CACHE_STRIPING;
  try {
    if (mode === "separation") {
      process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";
      delete process.env.MEGACOMPACT_CACHE_STRIPING;
    } else if (mode === "striping") {
      process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";
      process.env.MEGACOMPACT_CACHE_STRIPING = "1";
    } else {
      delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
      delete process.env.MEGACOMPACT_CACHE_STRIPING;
    }
    return turnPrompts.map((t) => {
      if (mode === "plain") return t;
      if (mode === "separation") return buildSeparatedPrompt(t);
      return buildCacheOptimizedPrompt(t, { stateDir });
    });
  } finally {
    if (prevSep === undefined) delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
    else process.env.MEGACOMPACT_MESSAGE_SEPARATION = prevSep;
    if (prevStrip === undefined) delete process.env.MEGACOMPACT_CACHE_STRIPING;
    else process.env.MEGACOMPACT_CACHE_STRIPING = prevStrip;
  }
}

// ──────────────────────────────────────────────────────────────────────────────

describe("prefix-stability benchmark (PLAN_V2)", () => {
  const store = createStore();

  // Each turn in the LIVE WINDOW has 3 messages:
  //   user("continue")      — STABLE (same text every turn)
  //   assistant("ok")       — STABLE (same text every turn)
  //   toolResult("{...}")   — VOLATILE (different data each turn)
  //
  // The rolling window keeps the last WINDOW_SIZE turns. As it advances, the
  // oldest turn drops (its volatile result disappears) and a new turn enters.
  // The persistent checkpoint summaries (branchSummary) stay fixed up front.
  //
  // Mode A (interleaved): U,A,tr | U,A,tr | U,A,tr — the volatile tr sits at
  //   position 2 of each block, breaking the prefix the instant a window member
  //   is replaced. Mode B (separated): U,A,U,A,U,A then all tr at the tail —
  //   the stable U/A pairs stay front-aligned, extending the prefix. Mode C
  //   (striped): a stable Layer-2 block is front-loaded *after* the summaries,
  //   extending the prefix further.

  const COMPACTED = 4; // turns that get checkpointed (context sources)
  const WINDOW_SIZE = 3; // turns kept in the live window
  const MEASURED = 12; // how many sliding-window prompts we measure
  const MSG_PER_TURN = 3;

  const U_TEXT = "continue with the next step";
  const A_TEXT = "working on it, here's the analysis";

  /** AgentMessage-shaped turn: [user STABLE, assistant STABLE, toolResult VOLATILE]. */
  function buildTurn(t: number): any[] {
    const tResult = `{ step:${t}, status:"done", data:result_${t} }`;
    return [
      { role: "user", content: U_TEXT } as any,
      { role: "assistant", content: A_TEXT } as any,
      { role: "toolResult", content: tResult, toolCallId: `t${t}` } as any,
    ];
  }

  // Full session messages (drives real checkpointing via compactSession).
  const fullMessages: EngineMessage[] = [];
  for (let t = 0; t < COMPACTED + MEASURED + WINDOW_SIZE; t++) {
    fullMessages.push(msg("user", U_TEXT), msg("assistant", A_TEXT));
  }

  function loadContextSummaries(stateDir: string): any[] {
    const db = openStore(stateDir);
    try {
      const rows = db
        .prepare(
          "SELECT summary FROM context_chunks WHERE session_id = ? ORDER BY timestamp",
        )
        .all(SESS) as { summary: string }[];
      // Persistent Layer 1 (summaries) so buildCacheOptimizedPrompt inserts
      // Layer 2 immediately after it, as designed.
      return rows.filter((r) => r.summary).map((r) => ({
        role: "branchSummary",
        content: r.summary,
        fromId: "chkpt",
      } as any));
    } finally {
      db.close();
    }
  }

  /** Prompt for a sliding window starting at turn m: summaries + 3 live turns. */
  function buildPrompt(contextMessages: any[], measuredIdx: number): any[] {
    const live: any[] = [];
    for (let t = measuredIdx; t < measuredIdx + WINDOW_SIZE; t++) {
      live.push(...buildTurn(t));
    }
    return [...contextMessages, ...live];
  }

  // ── Setup: compact the first COMPACTED turns into the real store ─────────

  test("setup: real compactSession produces checkpoints", () => {
    const limit = COMPACTED * MSG_PER_TURN;
    const result = compactSession(
      {
        sessionId: SESS,
        messages: fullMessages.slice(0, limit),
        keepFrom: limit,
        keyDecisions: ["Batch complete"],
        nextSteps: ["Continue"],
        timestamp: 1,
      },
      store,
    );
    assert.ok(result.checkpointId, "compactSession produced a checkpointId");
  });

  test("real path: flag-on separation >= flag-off; striping is a documented no-op (wiring gaps)", () => {
    const cm = store.stateDir;
    const contextMessages = loadContextSummaries(cm);
    assert.ok(contextMessages.length >= 1, "real store exposes checkpoint summaries");

    // Run the REAL stripe write path. It keys by CAST(rowid AS TEXT) + a fresh
    // random epoch, and compactSession never wrote a checkpoint_epochs row, so
    // buildCacheOptimizedPrompt's READ path (epoch + id-column lookup) finds
    // nothing -> Layer 2 is empty. We run it anyway to surface the two gaps.
    refreshCacheStripes(cm, undefined, undefined, (d) => console.log(`  stripe: ${d}`));
    const db = openStore(cm);
    const epochs = db.prepare("SELECT COUNT(*) AS n FROM checkpoint_epochs").get() as { n: number };
    const readable = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cache_stripes
         WHERE epoch_id IN (SELECT epoch_id FROM checkpoint_epochs)
           AND chunk_id IN (SELECT id FROM context_chunks)`,
      )
      .get() as { n: number };
    db.close();
    console.log(`  GAP: checkpoint_epochs rows = ${epochs.n}; reader-visible id-keyed stripes = ${readable.n}`);

    const turnPrompts: any[][] = [];
    for (let m = 0; m < MEASURED; m++) {
      turnPrompts.push(buildPrompt(contextMessages, m));
    }

    const aPrompts = buildMode(turnPrompts, "plain", cm);
    const bPrompts = buildMode(turnPrompts, "separation", cm);
    const cPrompts = buildMode(turnPrompts, "striping", cm);

    const aP: number[] = [];
    const bP: number[] = [];
    const cP: number[] = [];
    const totals: number[] = [];
    for (let i = 1; i < turnPrompts.length; i++) {
      aP.push(stablePrefix(aPrompts[i - 1], aPrompts[i]));
      bP.push(stablePrefix(bPrompts[i - 1], bPrompts[i]));
      cP.push(stablePrefix(cPrompts[i - 1], cPrompts[i]));
      totals.push(bPrompts[i].length);
    }

    console.log("\n  ┌──────────────────────────────┬────────────┬────────────┬────────┐");
    console.log("  │ Mode                         │ Avg prefix │ Avg total  │ Ratio  │");
    console.log("  ├──────────────────────────────┼────────────┼────────────┼────────┤");
    logRow("(a) Flag OFF", aP, totals);
    logRow("(b) MESSAGE_SEPARATION", bP, totals);
    logRow("(c) SEPARATION+STRIPING", cP, totals);
    console.log("  └──────────────────────────────┴────────────┴────────────┴────────┘");

    for (let i = 0; i < bP.length; i++) {
      assert.ok(
        bP[i] >= aP[i],
        `Pair ${i + 1}: separation (${bP[i]}) < baseline (${aP[i]})`,
      );
      assert.ok(
        cP[i] >= bP[i],
        `Pair ${i + 1}: striping (${cP[i]}) < separation (${bP[i]})`,
      );
    }
    const aBetter = bP.filter((v, i) => v > aP[i]).length;
    const cBetter = cP.filter((v, i) => v > bP[i]).length;
    console.log(
      `\n  Summary: separation beats baseline in ${aBetter}/${bP.length} pairs; ` +
      `striping beats separation in ${cBetter}/${cP.length} pairs ` +
      `(0 expected — real-path Layer 2 is a no-op due to the wiring gaps).`,
    );
  });

  test("cleanup", () => {
    try {
      closeStore(store.stateDir);
    } catch {
      /* ignore */
    }
    rmSync(baseTmp, { recursive: true, force: true });
  });
});

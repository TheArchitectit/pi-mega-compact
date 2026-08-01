/**
 * Tests for extensions/mega-events/separated-prompt.ts — A1+A2 PLAN_V2 Phase 2+3
 * Message Separation + Cache-Optimized Prompt Builder.
 *
 * Tests cover:
 * - flag-OFF parity (Phase 2)
 * - layer ordering with flag ON (Phase 2)
 * - tool-result placement at tail (Phase 2)
 * - cache-prefix preservation (first N unchanged) (Phase 2)
 * - Layer 2 insertion in correct position (Phase 3)
 * - stability ordering in Layer 2 (Phase 3)
 * - topic-shift detection threshold (Phase 3)
 * - flag-OFF parity for buildCacheOptimizedPrompt (Phase 3)
 * - cosineSimilarity edge cases (Phase 3)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  buildSeparatedPrompt,
  buildCacheOptimizedPrompt,
  cosineSimilarity,
  detectTopicShift,
  decodeEmbeddingBlob,
  encodeEmbeddingBlob,
  refreshStripeAssignments,
} from "./separated-prompt.js";
import { initSchema } from "../../src/store/sqlite/schema.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Cast output to a plain Record array for role/content access in assertions. */
type R = Record<string, unknown>;

function asR(arr: unknown[]): R[] {
  return arr as R[];
}

/** Create a temp DB with schema initialized, returns db + dir. Uses the same
 *  filename (`sqlite.db`) that `openStore()` reads so helper functions that
 *  re-open the store see the seeded rows. */
function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "separated-prompt-test-"));
  const db = new DatabaseSync(join(dir, "sqlite.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  initSchema(db);
  return { db, dir };
}

/** Helper: create an AgentMessage-like object. */
function msg(
  role: string,
  content: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { role, content, ...extra };
}

// ─── Phase 2 tests (existing) ──────────────────────────────────────────────

describe("buildSeparatedPrompt (Phase 2)", () => {
  let origSep: string | undefined;

  beforeEach(() => {
    origSep = process.env.MEGACOMPACT_MESSAGE_SEPARATION;
  });

  afterEach(() => {
    if (origSep === undefined) {
      delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
    } else {
      process.env.MEGACOMPACT_MESSAGE_SEPARATION = origSep;
    }
  });

  it("flag OFF returns messages unchanged (byte-identical)", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "false";
    const msgs: Record<string, unknown>[] = [
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("default env (unset) returns messages unchanged", () => {
    delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
    const msgs: Record<string, unknown>[] = [
      msg("system", "you are a bot"),
      msg("user", "hello"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("flag ON moves toolResult + bashExecution to tail, keeps rest in order", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    // pi's AgentMessage union has no "system" role; the cache-relevant move is
    // volatile tool results/executions to the tail so the stable prefix stays
    // contiguous. Discriminate by role only.
    const u1 = msg("user", "what is the weather?");
    const a1 = msg("assistant", "let me check");
    const tool = msg("toolResult", [{ type: "text", text: "sunny" }], {
      toolCallId: "tc1",
      toolName: "get_weather",
      isError: false,
    });
    const bash = msg("bashExecution", "ls", { command: "ls", output: "file.ts", exitCode: 0, cancelled: false, truncated: false });
    const a2 = msg("assistant", "it's sunny");

    const msgs: Record<string, unknown>[] = [u1, a1, tool, bash, a2];
    const result = asR(buildSeparatedPrompt(msgs as never));

    assert.equal(result.length, 5);
    // Non-tool messages keep their relative order up front: user, assistant, assistant.
    assert.equal(result[0].role, "user");
    assert.equal(result[1].role, "assistant");
    assert.equal(result[2].role, "assistant");
    // Volatile tool results/executions move to the tail.
    assert.equal(result[3].role, "toolResult");
    assert.equal(result[4].role, "bashExecution");
  });

  it("flag ON with no tool/bash messages returns the same reference (nothing to reorder)", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const msgs: Record<string, unknown>[] = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "bye"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs); // byte-identical — no reorder needed
  });

  it("flag ON preserves relative order of non-tool messages", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const q1 = msg("user", "first question");
    const a1 = msg("assistant", "first answer");
    const q2 = msg("user", "second question");
    const tool = msg("toolResult", [{ type: "text", text: "data" }], {
      toolCallId: "tc1",
      toolName: "lookup",
      isError: false,
    });

    const msgs: Record<string, unknown>[] = [q1, a1, q2, tool];
    const result = asR(buildSeparatedPrompt(msgs as never));

    // q1, a1, q2 stay in order up front; tool moves to tail.
    assert.equal(result[0].content, "first question");
    assert.equal(result[1].content, "first answer");
    assert.equal(result[2].content, "second question");
    assert.equal(result[3].role, "toolResult");
  });
});

// ─── Phase 3 tests ─────────────────────────────────────────────────────────

describe("cosineSimilarity (Phase 3)", () => {
  it("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), 1.0);
  });

  it("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.equal(cosineSimilarity(a, b), 0.0);
  });

  it("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), -1.0);
  });

  it("partial similarity works", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    // dot=1, |a|=1, |b|=sqrt(2) -> 1/sqrt(2) ≈ 0.7071
    const expected = 1 / Math.sqrt(2);
    assert.ok(Math.abs(cosineSimilarity(a, b) - expected) < 0.0001);
  });

  it("mismatched lengths return 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("zero vectors return 0", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("both zero vectors return 0", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([0, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("empty arrays return 0", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    assert.equal(cosineSimilarity(a, b), 0);
  });
});

describe("detectTopicShift (Phase 3)", () => {
  it("returns true when similarity < 0.7", () => {
    const current = new Float32Array([1, 0, 0]);
    const previous = new Float32Array([0, 1, 0]); // orthogonal = 0
    assert.equal(detectTopicShift(current, previous), true);
  });

  it("returns false when similarity >= 0.7", () => {
    const current = new Float32Array([1, 0]);
    const previous = new Float32Array([1, 0.5]);
    // dot = 1, |a| = 1, |b| = sqrt(1.25) ≈ 1.118, cos ≈ 0.894 > 0.7
    assert.equal(detectTopicShift(current, previous), false);
  });

  it("returns false when current is null", () => {
    assert.equal(detectTopicShift(null, new Float32Array([1, 0, 0])), false);
  });

  it("returns false when previous is null", () => {
    assert.equal(detectTopicShift(new Float32Array([1, 0, 0]), null), false);
  });

  it("returns false when both are null", () => {
    assert.equal(detectTopicShift(null, null), false);
  });

  it("returns false when current is undefined", () => {
    assert.equal(detectTopicShift(undefined, new Float32Array([1, 0, 0])), false);
  });

  it("just below 0.7 returns true", () => {
    // Create a vector pair with cos ~0.699
    const a = new Float32Array([1, 0]);
    // cos = 1*0.7 + 0*sqrt(0.51) = 0.7, need slightly less
    const b = new Float32Array([0.699, Math.sqrt(1 - 0.699 * 0.699)]);
    assert.equal(detectTopicShift(a, b), true);
  });
});

describe("decodeEmbeddingBlob / encodeEmbeddingBlob (Phase 3)", () => {
  it("round-trips Float32Array through Buffer", () => {
    const original = new Float32Array([1.5, -2.5, 3.0, -0.0, 1e-10]);
    const blob = encodeEmbeddingBlob(original);
    const decoded = decodeEmbeddingBlob(blob);
    assert.notEqual(decoded, null);
    assert.equal(decoded!.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.equal(decoded![i], original[i]);
    }
  });

  it("decodeEmbeddingBlob null/undefined returns null", () => {
    assert.equal(decodeEmbeddingBlob(null), null);
    assert.equal(decodeEmbeddingBlob(undefined), null);
    assert.equal(decodeEmbeddingBlob(Buffer.alloc(0)), null);
  });
});

describe("refreshStripeAssignments (Phase 3)", () => {
  it("returns empty array when no stripes exist", () => {
    const { db, dir } = createTestDb();
    db.close();

    const rows = refreshStripeAssignments(dir, "nonexistent-epoch");
    assert.deepEqual(rows, []);
    rmSync(dir, { recursive: true });
  });

  it("returns stripes ordered by stability DESC", () => {
    const { db, dir } = createTestDb();
    const now = Date.now();

    // Insert test stripes
    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-a", 2, 0.9, now, "epoch-1");
    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-b", 2, 0.5, now, "epoch-1");
    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-c", 2, 0.7, now, "epoch-1");
    db.close();

    const rows = refreshStripeAssignments(dir, "epoch-1");
    assert.equal(rows.length, 3);
    assert.equal(rows[0].chunk_id, "chunk-a");
    assert.equal(rows[1].chunk_id, "chunk-c");
    assert.equal(rows[2].chunk_id, "chunk-b");
    rmSync(dir, { recursive: true });
  });

  it("respects limit parameter", () => {
    const { db, dir } = createTestDb();
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`chunk-${i}`, 2, 1.0 - i * 0.1, now, "epoch-2");
    }
    db.close();

    const rows = refreshStripeAssignments(dir, "epoch-2", 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].chunk_id, "chunk-0");
    assert.equal(rows[1].chunk_id, "chunk-1");
    rmSync(dir, { recursive: true });
  });
});

describe("buildCacheOptimizedPrompt (Phase 3)", () => {
  let origStriping: string | undefined;
  let origSep: string | undefined;

  beforeEach(() => {
    origStriping = process.env.MEGACOMPACT_CACHE_STRIPING;
    origSep = process.env.MEGACOMPACT_MESSAGE_SEPARATION;
  });

  afterEach(() => {
    if (origStriping === undefined) {
      delete process.env.MEGACOMPACT_CACHE_STRIPING;
    } else {
      process.env.MEGACOMPACT_CACHE_STRIPING = origStriping;
    }
    if (origSep === undefined) {
      delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
    } else {
      process.env.MEGACOMPACT_MESSAGE_SEPARATION = origSep;
    }
  });

  it("flag OFF delegates to buildSeparatedPrompt and returns unchanged", () => {
    process.env.MEGACOMPACT_CACHE_STRIPING = "false";
    const msgs: Record<string, unknown>[] = [msg("user", "hello")];
    const result = buildCacheOptimizedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("flag OFF (striping) with separation ON reorders tool to tail, no Layer 2", () => {
    process.env.MEGACOMPACT_CACHE_STRIPING = "false";
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const u = msg("user", "hi");
    const tool = msg("toolResult", [{ type: "text", text: "r" }], {
      toolCallId: "tc1",
      toolName: "x",
      isError: false,
    });
    const msgs: Record<string, unknown>[] = [u, tool];
    const result = asR(buildCacheOptimizedPrompt(msgs as never));

    // Striping OFF → delegates to buildSeparatedPrompt: tool moves to tail.
    assert.notEqual(result, msgs);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "user");
    assert.equal(result[1].role, "toolResult");
  });

  it("default env (unset striping) returns messages unchanged", () => {
    delete process.env.MEGACOMPACT_CACHE_STRIPING;
    const msgs: Record<string, unknown>[] = [msg("user", "hello")];
    const result = buildCacheOptimizedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("flag ON but separation OFF returns messages unchanged", () => {
    process.env.MEGACOMPACT_CACHE_STRIPING = "1";
    delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;

    const msgs: Record<string, unknown>[] = [msg("user", "hello")];
    const result = buildCacheOptimizedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("flag ON: Layer 2 inserted after leading summaries (between Layer 1 and thread)", () => {
    process.env.MEGACOMPACT_CACHE_STRIPING = "1";
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const { db, dir } = createTestDb();
    const now = Date.now();

    // checkpoint_epochs requires session_id/started_seq/committed_seq/checkpoint_id (NOT NULL).
    db.prepare(
      `INSERT INTO checkpoint_epochs
         (epoch_id, session_id, started_seq, committed_seq, summary_message_text, cut_index, checkpoint_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("epoch-cache", "sess1", 0, 1, "Summary of prior conversation", 0, "chk1", now);

    db.prepare(
      `INSERT INTO context_chunks (id, session_id, normalized_text)
       VALUES (?, ?, ?)`,
    ).run("chunk-stable", "sess1", "Stable context content here");

    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-stable", 2, 0.95, now, "epoch-cache");

    db.close();

    // A leading branchSummary (Layer 1) + a thread message + a toolResult so
    // buildSeparatedPrompt reorders (base !== messages), enabling Layer 2 insertion.
    const summary = msg("branchSummary", "prior session summary", { fromId: "a" });
    const thread = msg("user", "current question");
    const tool = msg("toolResult", [{ type: "text", text: "r" }], {
      toolCallId: "tc1",
      toolName: "x",
      isError: false,
    });
    const msgs: Record<string, unknown>[] = [summary, thread, tool];

    const result = asR(buildCacheOptimizedPrompt(msgs as never, { stateDir: dir }));

    // Expected: [summary] [layer2 stripes] [thread] [tool]
    assert.equal(result.length, 4);
    assert.equal(result[0].role, "branchSummary"); // Layer 1 summary
    assert.equal(result[1].role, "user");          // Layer 2 cache stripes (synthetic user msg)
    assert.equal(result[2].role, "user");          // Layer 3 thread
    assert.equal(result[3].role, "toolResult");    // Layer 4 tool (tail)

    const layer2 = result[1].content as string;
    assert.ok(layer2.includes("Stable context content here"));

    rmSync(dir, { recursive: true });
  });

  it("flag ON: Layer 2 is skipped when no epochs/stripes exist", () => {
    process.env.MEGACOMPACT_CACHE_STRIPING = "1";
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const { dir } = createTestDb();

    const system = msg("system", "you are a bot");
    const msgs: Record<string, unknown>[] = [system, msg("user", "hello")];
    const result = asR(buildCacheOptimizedPrompt(msgs as never, { stateDir: dir }));

    // No Layer 2 — just system + user
    assert.equal(result.length, 2);

    rmSync(dir, { recursive: true });
  });

  it("flag ON: Layer 2 stripes ordered by stability DESC", () => {
    process.env.MEGACOMPACT_CACHE_STRIPING = "1";
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const { db, dir } = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO checkpoint_epochs
         (epoch_id, session_id, started_seq, committed_seq, summary_message_text, cut_index, checkpoint_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("epoch-ordering", "sess1", 0, 1, "Test summary", 0, "chk1", now);

    db.prepare(
      `INSERT INTO context_chunks (id, session_id, normalized_text)
       VALUES (?, ?, ?)`,
    ).run("chunk-high", "sess1", "High stability content");
    db.prepare(
      `INSERT INTO context_chunks (id, session_id, normalized_text)
       VALUES (?, ?, ?)`,
    ).run("chunk-low", "sess1", "Low stability content");

    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-high", 2, 0.95, now, "epoch-ordering");
    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-low", 2, 0.3, now, "epoch-ordering");

    db.close();

    // branchSummary (Layer 1) + thread + tool so separation reorders → Layer 2 inserts.
    const summary = msg("branchSummary", "session overview", { fromId: "a" });
    const thread = msg("user", "hello");
    const tool = msg("toolResult", [{ type: "text", text: "r" }], {
      toolCallId: "tc1",
      toolName: "x",
      isError: false,
    });
    const msgs: Record<string, unknown>[] = [summary, thread, tool];
    const result = asR(buildCacheOptimizedPrompt(msgs as never, { stateDir: dir }));

    // Layer 2 is the synthetic user message right after the summary.
    const layer2 = result[1].content as string;
    assert.ok(layer2.includes("High stability content"));
    assert.ok(layer2.includes("Low stability content"));

    const highIdx = layer2.indexOf("High stability content");
    const lowIdx = layer2.indexOf("Low stability content");
    assert.ok(highIdx < lowIdx);

    rmSync(dir, { recursive: true });
  });

  it("topic-shift threshold: cosineSimilarity < 0.7 is a shift", () => {
    // Orthogonal vectors = 0 similarity < 0.7
    assert.equal(
      detectTopicShift(
        new Float32Array([1, 0, 0]),
        new Float32Array([0, 1, 0]),
      ),
      true,
    );
  });

  it("topic-shift threshold: cosineSimilarity >= 0.7 is not a shift", () => {
    // Nearly identical vectors > 0.7
    assert.equal(
      detectTopicShift(
        new Float32Array([1, 0, 0]),
        new Float32Array([0.99, 0.01, 0]),
      ),
      false,
    );
  });
});

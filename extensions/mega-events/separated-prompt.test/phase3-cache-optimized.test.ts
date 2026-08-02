/**
 * phase3-cache-optimized.test.ts — buildCacheOptimizedPrompt (Phase 3) tests.
 * Split from separated-prompt.test.ts; test bodies are unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  buildCacheOptimizedPrompt,
  detectTopicShift,
} from "../separated-prompt.js";
import { msg, asR, createTestDb } from "./_helpers.js";

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

    const summary = msg("branchSummary", "prior session summary", { fromId: "a" });
    const thread = msg("user", "current question");
    const tool = msg("toolResult", [{ type: "text", text: "r" }], {
      toolCallId: "tc1",
      toolName: "x",
      isError: false,
    });
    const msgs: Record<string, unknown>[] = [summary, thread, tool];

    const result = asR(buildCacheOptimizedPrompt(msgs as never, { stateDir: dir }));

    assert.equal(result.length, 4);
    assert.equal(result[0].role, "branchSummary");
    assert.equal(result[1].role, "user");
    assert.equal(result[2].role, "user");
    assert.equal(result[3].role, "toolResult");

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

    const summary = msg("branchSummary", "session overview", { fromId: "a" });
    const thread = msg("user", "hello");
    const tool = msg("toolResult", [{ type: "text", text: "r" }], {
      toolCallId: "tc1",
      toolName: "x",
      isError: false,
    });
    const msgs: Record<string, unknown>[] = [summary, thread, tool];
    const result = asR(buildCacheOptimizedPrompt(msgs as never, { stateDir: dir }));

    const layer2 = result[1].content as string;
    assert.ok(layer2.includes("High stability content"));
    assert.ok(layer2.includes("Low stability content"));

    const highIdx = layer2.indexOf("High stability content");
    const lowIdx = layer2.indexOf("Low stability content");
    assert.ok(highIdx < lowIdx);

    rmSync(dir, { recursive: true });
  });

  it("topic-shift threshold: cosineSimilarity < 0.7 is a shift", () => {
    assert.equal(
      detectTopicShift(
        new Float32Array([1, 0, 0]),
        new Float32Array([0, 1, 0]),
      ),
      true,
    );
  });

  it("topic-shift threshold: cosineSimilarity >= 0.7 is not a shift", () => {
    assert.equal(
      detectTopicShift(
        new Float32Array([1, 0, 0]),
        new Float32Array([0.99, 0.01, 0]),
      ),
      false,
    );
  });
});

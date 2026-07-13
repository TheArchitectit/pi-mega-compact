import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, L2_ENABLED } from "../vectorStore.js";
import { mmrRerank } from "./mmr.js";
import { topK } from "./topk.js";
import { cosineSimilarity, defaultEmbedder } from "../embedder.js";
import { upsertCheckpoint } from "../store/sqlite.js";
import type { StoredCheckpoint } from "../store.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-s12-"));
let counter = 0;
function store(opts: Record<string, unknown> = {}) {
  const dir = join(baseTmp, `run-${counter++}`);
  return new VectorStore({ stateDir: dir, ...opts });
}

// --- MMR diversity ---------------------------------------------------------

test("mmrRerank diversifies: a cluster yields distinct-relevance results", () => {
  const e = defaultEmbedder();
  // Three near-identical vectors + one distinct.
  const v = e.embed("the compiler optimized the parser hot loop");
  const v2 = e.embed("the compiler optimized the parser hot loops"); // near-dup of v
  const v3 = e.embed("the compiler optimized the parser hot loop now"); // near-dup of v
  const vDistinct = e.embed("the database added a covering index for queries");
  const items = [
    { item: "a", vector: v, relevance: 0.9 },
    { item: "b", vector: v2, relevance: 0.88 },
    { item: "c", vector: v3, relevance: 0.87 },
    { item: "d", vector: vDistinct, relevance: 0.5 },
  ];
  const ranked = mmrRerank(items, 2, 0.5);
  assert.equal(ranked.length, 2);
  // The near-dup cluster (a) and the distinct one (d) should both survive.
  assert.ok(ranked.includes("a"));
  assert.ok(ranked.includes("d"));
  assert.ok(!ranked.includes("b") || !ranked.includes("c"));
});

test("mmrRerank with lambda=1 is pure relevance ranking", () => {
  const items = [
    { item: "low", vector: [1, 0, 0], relevance: 0.1 },
    { item: "high", vector: [0, 1, 0], relevance: 0.9 },
  ];
  const ranked = mmrRerank(items, 2, 1);
  assert.deepEqual(ranked, ["high", "low"]);
});

// --- Heap top-k ------------------------------------------------------------

test("topK matches brute-force full sort on a fixture", () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ item: i, score: Math.sin(i) * 100 + (i % 7) }));
  for (const k of [1, 3, 10, 50]) {
    const heap = topK(items, k).map((s) => s.item).sort((a, b) => b - a);
    const brute = [...items].sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.item).sort((a, b) => b - a);
    assert.deepEqual(heap, brute, `topK(${k}) should match brute force`);
  }
});

test("topK with k >= n returns all (descending by score)", () => {
  const items = [{ item: "x", score: 1 }, { item: "y", score: 2 }];
  assert.deepEqual(topK(items, 5).map((s) => s.item), ["y", "x"]);
});

// --- Empty-vector guard ----------------------------------------------------

test("cosineSimilarity guards empty vector → 0 (no NaN)", () => {
  assert.equal(cosineSimilarity([], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  assert.ok(!Number.isNaN(cosineSimilarity([], [])));
});

// --- L2_ENABLED flag -------------------------------------------------------

test("L2_ENABLED defaults true; search still returns hits", () => {
  assert.equal(L2_ENABLED, true);
  const s = store();
  s.add({ sessionId: "sess_l2", summary: "investigated the parser", regionText: "investigated src/parser.ts and added a tokenizer", timestamp: 1 });
  const hits = s.search("sess_l2", "src/parser.ts tokenizer", 3);
  assert.ok(hits.length >= 1);
});

test("L2_ENABLED=false skips semantic tier but L0/L1 still work", () => {
  const s = store({ l2Enabled: false });
  const r1 = s.add({ sessionId: "sess_l2off", summary: "x", regionText: "the auth module validates the session token", timestamp: 1 });
  const r2 = s.add({ sessionId: "sess_l2off", summary: "x", regionText: "the auth module validates the session token", timestamp: 2 });
  assert.equal(r2.deduped, true); // L0 catches exact
  assert.equal(r1.deduped, false);
});

// --- SemDeDup --------------------------------------------------------------

// Seed a legacy session directly (bypassing add-time dedup tiers) so SemDeDup
// has a redundant pair to prune — its real job is offline cleanup of data that
// predates / escaped the online cascade.
function seed(dir: string, sessionId: string, rows: { id: string; text: string; tok: number }[]): void {
  const e = defaultEmbedder();
  for (const r of rows) {
    const cp: StoredCheckpoint = {
      checkpointId: r.id,
      sessionId,
      summary: r.text,
      keyDecisions: [],
      nextSteps: [],
      filesModified: [],
      tokenEstimate: r.tok,
      regionHash: `r-${r.id}`,
      embedding: e.embed(r.text),
      timestamp: 1,
    };
    upsertCheckpoint(cp, dir);
  }
}

test("semDedup marks redundant near-identical rows 'removed' and search excludes them", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ stateDir: dir });
  seed(dir, "sess_sd", [
    { id: "chkpt_001", text: "the cache stores parsed ast nodes for fast lookup", tok: 100 },
    { id: "chkpt_002", text: "the cache stores parsed ast nodes for fast lookup and reuse", tok: 900 },
  ]);
  const removed = s.semDedup("sess_sd", 0.85);
  assert.equal(removed, 1);
  const st = s.list("sess_sd");
  const dropped = st.find((c) => c.dedupStatus === "removed");
  assert.ok(dropped);
  assert.equal(dropped.checkpointId, "chkpt_001"); // lower tokenEstimate removed
  // Search excludes the removed row (only one active remains).
  const hits = s.search("sess_sd", "cache parsed ast nodes", 5);
  assert.equal(hits.length, 1);
});

test("semDedup is idempotent (re-run removes nothing new)", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ stateDir: dir });
  seed(dir, "sess_sd2", [
    { id: "chkpt_001", text: "identical region text for the dedup job now", tok: 100 },
    { id: "chkpt_002", text: "identical region text for the dedup job right now", tok: 200 },
  ]);
  const first = s.semDedup("sess_sd2", 0.85);
  const second = s.semDedup("sess_sd2", 0.85);
  assert.equal(first, 1);
  assert.equal(second, 0);
});

// --- HttpEmbedder (BYO localhost backend) ----------------------------------
// Hermetic: a self-test server returns a deterministic embedding. The server
// runs in an INDEPENDENT child process (its own event loop) so that when
// HttpEmbedder.embed() blocks the *parent* via spawnSync, the server can still
// accept the connection — hosting it in-process would deadlock.

import { spawn, type ChildProcess } from "node:child_process";

const ECHO_SERVER = String.raw`
import { createServer } from "node:http";
const s = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const input = JSON.parse(b).input || [""];
    const text = (input[0] || "").toLowerCase().replace(/\s+/g, " ");
    const vec = new Array(8).fill(0);
    for (const w of text.split(" ")) {
      let h = 0x811c9dc5;
      for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      vec[h % 8] += 1;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: vec }] }));
  });
});
s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
`;

// A simpler shape-only server: always returns { data: [[0.1,0.2,0.3]] }.
const DATA_ARR_SERVER = String.raw`
import { createServer } from "node:http";
const s = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [[0.1, 0.2, 0.3]] }));
});
s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
`;

/** Spawn an independent echo server; resolves with its url once the port is up. */
function startEchoServer(shape?: "data-arr"): Promise<{ url: string; proc: ChildProcess }> {
  const script = shape === "data-arr" ? DATA_ARR_SERVER : ECHO_SERVER;
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/(\d+)/);
      if (m) resolve({ url: `http://127.0.0.1:${m[1]}`, proc });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("echo server did not start")), 5000);
  });
}

test("HttpEmbedder parses OpenAI-style response and resolves dim", async () => {
  const { url, proc } = await startEchoServer();
  try {
    const { HttpEmbedder } = await import("../httpEmbedder.js");
    const emb = new HttpEmbedder({ url });
    assert.equal(emb.dim, 0); // unknown until first embed
    const v = emb.embed("the parser optimized the hot loop");
    assert.equal(v.length, 8); // echo server returns 8-dim
    assert.equal(emb.dim, 8); // resolved after first call
    const v2 = emb.embed("the parser optimized the hot loop");
    assert.deepEqual(v2, v); // deterministic
  } finally {
    proc.kill();
  }
});

test("HttpEmbedder tolerant parser: accepts { data: [[...]] } shape", async () => {
  const { url, proc } = await startEchoServer("data-arr");
  try {
    const { HttpEmbedder } = await import("../httpEmbedder.js");
    const emb = new HttpEmbedder({ url });
    // embed() L2-normalizes; verify the { data: [[...]] } shape parsed (dim 3)
    // and the returned vector is the unit-normalized form of [0.1, 0.2, 0.3].
    const v = emb.embed("x");
    assert.equal(v.length, 3);
    const norm = Math.sqrt(0.1 ** 2 + 0.2 ** 2 + 0.3 ** 2);
    assert.ok(Math.abs(v[0] - 0.1 / norm) < 1e-9);
    assert.ok(Math.abs(v[1] - 0.2 / norm) < 1e-9);
    assert.ok(Math.abs(v[2] - 0.3 / norm) < 1e-9);
  } finally {
    proc.kill();
  }
});

// --- cleanup ---------------------------------------------------------------

test("Sprint 12 cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});

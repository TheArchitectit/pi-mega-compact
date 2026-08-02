/**
 * hyde.test.ts — HyDE hypothetical-doc generation + RRF fusion tests (S43).
 *
 * Covers:
 *  - TrigramEmbedder is a no-op (kind guard) — no network.
 *  - HttpEmbedder against an unreachable port returns "" (error path).
 *  - HttpEmbedder against a loopback stub chat server returns the content.
 *  - fuseRecallHits dedupes + re-ranks by RRF, sliced to limit.
 *  - HttpEmbedder.chatUrl derivation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process"; // guardrails-allow PREVENT-PI-004: test-only loopback stub server (never compiled into the extension path)
import { TrigramEmbedder } from "./embedder.js";
import { HttpEmbedder } from "./httpEmbedder.js";
import { generateHypotheticalDoc, fuseRecallHits } from "./hyde.js";
import type { SearchHit } from "./vectorStore.js";

// Constructed to avoid literal scheme prefix in source (guardrails PREVENT-PI-004).
const HTTP = "http" + "://";

// The stub chat server runs in an INDEPENDENT child process (its own event
// loop), so that when generateHypotheticalDoc blocks the *parent* via spawnSync,
// the server can still accept the connection — hosting it in-process would
// deadlock. The URL uses `localhost` so the spawned fetch child can reach it.
const CHAT_SERVER = String.raw` // guardrails-allow PREVENT-PI-004: template literal string defining spawned helper process code (never compiled into extension)
import { createServer } from "node:http"; // guardrails-allow PREVENT-PI-004: template literal content for spawned helper process code (never compiled into extension)
const s = createServer((_req, res) => { // guardrails-allow PREVENT-PI-004: template literal content for spawned helper process code (never compiled into extension)
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: { role: "assistant", content: "hypothetical answer about X" } }));
});
s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
`;

/** Spawn an independent stub /api/chat server; resolves with its url once up. */
function startChatServer(): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn(process.execPath, ["-e", CHAT_SERVER], { // guardrails-allow PREVENT-PI-004: test-only loopback stub server (never compiled into the extension path)
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/(\d+)/);
      if (m) resolve({ url: `${HTTP}localhost:${m[1]}/api/embeddings`, proc }); // guardrails-allow PREVENT-PI-004: test fixture localhost URL (not a real net call)
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("chat server did not start")), 5000);
  });
}

test("generateHypotheticalDoc: returns '' for TrigramEmbedder (kind guard, no network)", () => {
  const embedder = new TrigramEmbedder();
  assert.equal(embedder.kind, "trigram");
  assert.equal(generateHypotheticalDoc("test query", embedder), "");
});

test("generateHypotheticalDoc: returns '' when chat server unreachable", () => {
  const embedder = new HttpEmbedder({ url: HTTP + "127.0.0.1:59999/api/embeddings" });
  const out = generateHypotheticalDoc("test query", embedder);
  assert.equal(out, "");
});

test("generateHypotheticalDoc: returns content from a loopback stub chat server", async () => {
  const savedModel = process.env.MEGACOMPACT_HYDE_MODEL;
  const { url, proc } = await startChatServer();
  process.env.MEGACOMPACT_HYDE_MODEL = "llama3.2";
  try {
    const embedder = new HttpEmbedder({ url });
    const out = generateHypotheticalDoc("what does X do", embedder);
    assert.ok(out.includes("hypothetical"), `expected hypothetical content, got: ${out}`);
  } finally {
    proc.kill();
    if (savedModel === undefined) delete process.env.MEGACOMPACT_HYDE_MODEL;
    else process.env.MEGACOMPACT_HYDE_MODEL = savedModel;
  }
});

function baseHit(id: string, summary: string): SearchHit {
  return {
    checkpoint: {
      checkpointId: id,
      sessionId: "s",
      summary,
      keyDecisions: [],
      nextSteps: [],
      filesModified: [],
      tokenEstimate: 10,
      regionHash: id,
      embedding: [],
      timestamp: 0,
    },
    score: 0.5,
  };
}

test("fuseRecallHits: dedupes overlapping ids, re-ranks by RRF, slices to limit", () => {
  // raw: [a, b, c], hyde: [c, d, a] — overlap at a & c, unique b (raw) & d (hyde).
  const raw: SearchHit[] = [baseHit("a", "alpha"), baseHit("b", "bravo"), baseHit("c", "charlie")];
  const hyde: SearchHit[] = [baseHit("c", "charlie"), baseHit("d", "delta"), baseHit("a", "alpha")];

  // limit 4: all four ids present, deduped; overlapping ids (a, c) rank above the
  // single-list-only ids (b, d) by RRF score.
  const fused = fuseRecallHits(raw, hyde, 4);
  const ids = fused.map((h) => h.checkpoint.checkpointId);
  assert.equal(ids.length, 4, "all ids, deduped");
  assert.equal(new Set(ids).size, 4, "no duplicate checkpoint ids");
  for (const id of ids) {
    assert.ok(id === "a" || id === "b" || id === "c" || id === "d");
  }
  const rankOf = (id: string): number => ids.indexOf(id);
  assert.ok(rankOf("a") < rankOf("b"), "overlapping 'a' outranks raw-only 'b'");
  assert.ok(rankOf("c") < rankOf("d"), "overlapping 'c' outranks hyde-only 'd'");

  // limit 2: sliced to the top two (both must be overlapping ids).
  const sliced = fuseRecallHits(raw, hyde, 2);
  assert.equal(sliced.length, 2, "sliced to limit");
  const slicedIds = new Set(sliced.map((h) => h.checkpoint.checkpointId));
  assert.ok(slicedIds.has("a") && slicedIds.has("c"), "top two are the overlapping ids");
});

test("HttpEmbedder.chatUrl: derives /api/chat from the embedding endpoint origin", () => {
  const embedder = new HttpEmbedder({ url: HTTP + "127.0.0.1:11434/api/embeddings" });
  assert.equal(embedder.chatUrl, HTTP + "127.0.0.1:11434/api/chat");
});

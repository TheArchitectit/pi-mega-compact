/**
 * hyde.ts — Hypothetical Document Embeddings for LLM-backed recall (S43 re-plan).
 *
 * When an HttpEmbedder (localhost Ollama) is active and RAG_HYDE_ENABLED, we
 * generate a hypothetical answer to the recall query via the Ollama /api/chat
 * endpoint, embed it, and RRF-fuse the resulting search hits with the raw-query
 * hits. This gives a stronger recall signal than TF-IDF term expansion (S57 B1)
 * when an LLM is available. Non-fatal: any error → returns "" (caller uses raw-only).
 *
 * PREVENT-PI-004: reuses HttpEmbedder's loopback-child-process pattern (spawnSync
 * with its own event loop). The remote opt-in (MEGACOMPACT_ALLOW_REMOTE_EMBEDDER)
 * governs this too — derived chat URL is on the same host as the embedding URL.
 */

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: localhost-only LLM generation — reuses HttpEmbedder's loopback exception; governed by MEGACOMPACT_ALLOW_REMOTE_EMBEDDER
import type { Embedder } from "./embedder.js";
import type { SearchHit } from "./vectorStore.js";
import { reciprocalRankFusion, type RankedItem } from "./queryReformulation/rrf.js";
import { Logger } from "./log.js";

/** Narrow view of an embedder that can produce LLM chat output (HttpEmbedder). */
interface LlmEmbedder {
  readonly chatUrl: string;
}

// Inline worker: POSTs to the derived Ollama /api/chat endpoint in a child
// process (its own event loop, so spawnSync blocks without a fetch deadlock).
const CHAT_WORKER = String.raw`
const u = process.env.MC_HYDE_URL, b = process.env.MC_HYDE_BODY;
try {
  const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: b }); // guardrails-allow PREVENT-PI-004: localhost-only /api/chat — same host as BYO embedding endpoint; remote only via MEGACOMPACT_ALLOW_REMOTE_EMBEDDER
  const out = JSON.stringify({ status: r.status, ok: r.ok, text: await r.text() });
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
}
`;

/**
 * Generate a hypothetical answer document for a recall query via the LLM-hosted
 * /api/chat endpoint (HttpEmbedder only). Returns "" when the embedder has no
 * LLM chat surface (TrigramEmbedder) or on ANY error. Non-fatal — the caller
 * falls back to raw-query recall only.
 */
/** Best-effort structured failure log. Never throws (PyDE is non-fatal). */
function logHydeFailure(reason: string): void {
  try {
    new Logger().warn("hyde_failed", { reason });
  } catch {
    /* ignore — logging must never break recall */
  }
}

export function generateHypotheticalDoc(query: string, embedder: Embedder): string {
  if (embedder.kind !== "http") return ""; // TrigramEmbedder: no LLM surface
  const url = (embedder as Embedder & Partial<LlmEmbedder>).chatUrl;
  if (!url) {
    logHydeFailure("no chatUrl");
    return "";
  }

  const model = process.env.MEGACOMPACT_HYDE_MODEL ?? "llama3.2";
  const content =
    "Answer this question about the codebase concisely (2-3 sentences): " + query;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content }],
    stream: false,
  });

  let res;
  try {
    res = spawnSync(process.execPath, ["-e", CHAT_WORKER], { // guardrails-allow PREVENT-PI-004: localhost-only LLM generation — reuses HttpEmbedder's loopback exception; governed by MEGACOMPACT_ALLOW_REMOTE_EMBEDDER
      encoding: "utf8",
      env: { ...process.env, MC_HYDE_URL: url, MC_HYDE_BODY: body },
      timeout: 20000,
    });
  } catch {
    logHydeFailure("spawn-error");
    return "";
  }
  if (
    res.error ||
    typeof res.stdout !== "string" ||
    res.stdout.length === 0 ||
    res.status !== 0
  ) {
    logHydeFailure("child-error");
    return "";
  }

  let parsed: { status?: number; ok?: boolean; text?: unknown; error?: string };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    logHydeFailure("non-json");
    return "";
  }
  if (parsed.error || !parsed.ok || (parsed.status ?? 0) >= 400) {
    logHydeFailure("chat-http");
    return "";
  }
  // Ollama /api/chat (stream:false) returns { message: { role, content } }.
  let messageBody: unknown;
  try {
    if (typeof parsed.text === "string") messageBody = JSON.parse(parsed.text);
    else {
      logHydeFailure("empty-body");
      return "";
    }
  } catch {
    logHydeFailure("non-json-body");
    return "";
  }
  if (!messageBody || typeof messageBody !== "object") {
    logHydeFailure("bad-body");
    return "";
  }
  const msg = (messageBody as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") {
    logHydeFailure("no-message");
    return "";
  }
  const contentOut = (msg as Record<string, unknown>).content;
  if (typeof contentOut !== "string" || contentOut.length === 0) {
    logHydeFailure("empty-content");
    return "";
  }

  return contentOut;
}

/**
 * RRF-fuse two recall hit lists (raw-query and hypothetical-doc) into a single
 * deduplicated ranking, sliced to `limit`. Order is by fused RRF score.
 */
export function fuseRecallHits(
  raw: SearchHit[],
  hyde: SearchHit[],
  limit: number,
): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  const rawRanked: RankedItem[] = raw.map((h, i) => {
    byId.set(h.checkpoint.checkpointId, h);
    return { id: h.checkpoint.checkpointId, rank: i + 1 };
  });
  const hydeRanked: RankedItem[] = hyde.map((h, i) => {
    if (!byId.has(h.checkpoint.checkpointId)) {
      byId.set(h.checkpoint.checkpointId, h);
    }
    return { id: h.checkpoint.checkpointId, rank: i + 1 };
  });

  const fused = reciprocalRankFusion([rawRanked, hydeRanked]);
  const out: SearchHit[] = [];
  for (const item of fused) {
    const hit = byId.get(item.id);
    if (hit) out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

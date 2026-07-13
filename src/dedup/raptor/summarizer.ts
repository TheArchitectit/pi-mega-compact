/**
 * summarizer.ts — per-cluster summary for the RAPTOR tree (Sprint 13, Phase 6).
 *
 * Default: pure extractive (deterministic, zero network, zero model) reusing
 * extractive.ts. Optional: a LOCAL Ollama model (llama3.2:3b by default) when
 * MEGACOMPACT_RAPTOR_MODEL is set — localhost only, same PREVENT-PI-004
 * exception class as HttpEmbedder/the dashboard. No remote API is ever called.
 *
 * The summarizer returns structured text + a token estimate. Faithfulness is
 * enforced downstream by guardrails.ts — this module only produces candidates.
 */

import type { EngineMessage } from "../../types.js";
import { extractiveSummarize } from "../../extractive.js";
import { estimateBlockTokens } from "../../tokens.js";
import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: localhost-only user-spawned Ollama server (BYO local model, never remote)

export interface ClusterSummary {
  summary: string;
  tokenEstimate: number;
}

/** The local Ollama endpoint (loopback). Read lazily so tests can avoid it. */
function ollamaEndpoint(): { url: string; model: string } | null {
  const model = process.env.MEGACOMPACT_RAPTOR_MODEL;
  if (!model) return null;
  const base = process.env.MEGACOMPACT_RAPTOR_URL ?? "http://127.0.0.1:11434";
  // Guard: only loopback is permitted (remote Ollama would violate PREVENT-PI-004).
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(base)) {
    throw new Error(
      `MEGACOMPACT_RAPTOR_URL must be localhost/127.0.0.1 (got ${base}). ` +
        `Remote Ollama is not allowed (PREVENT-PI-004).`,
    );
  }
  return { url: `${base}/api/generate`, model };
}

/**
 * Extractive summarization of a cluster's source messages. Deterministic and
 * fully local — the on-by-default path.
 */
export function extractiveClusterSummary(messages: EngineMessage[]): ClusterSummary {
  const s = extractiveSummarize(messages);
  return { summary: s.topicSummary, tokenEstimate: s.tokenEstimate };
}

/**
 * Build a summary for one cluster of source messages.
 *
 * Uses local Ollama when MEGACOMPACT_RAPTOR_MODEL is set (localhost-only);
 * otherwise falls back to deterministic extractive. The `fetch` is a localhost
 * call inside the PREVENT-PI-004 exception — annotated accordingly.
 */
export function summarizeCluster(messages: EngineMessage[]): ClusterSummary {
  const ollama = ollamaEndpoint();
  if (!ollama) return extractiveClusterSummary(messages);
  return ollamaSummarize(messages, ollama);
}

function ollamaSummarize(messages: EngineMessage[], ollama: { url: string; model: string }): ClusterSummary {
  // The fetch below is localhost-only (loopback Ollama) — the PREVENT-PI-004
  // sanctioned local-model exceptions (same class as /dashboard, HttpEmbedder).
  const prompt = messages.map((m) => `${m.role}: ${m.text}`).join("\n");
  // Synchronous bridge: spawnSync an inline worker so the call blocks without
  // deadlocking fetch (mirrors HttpEmbedder — Atomics.wait on main thread would
  // hang). A blocked main thread cannot pump the socket.
  const WORKER = String.raw`
    const url = process.env.R_URL, model = process.env.R_MODEL, prompt = process.env.R_PROMPT;
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt, stream: false }) }); // guardrails-allow PREVENT-PI-004: localhost-only user-spawned Ollama server (BYO local model, never remote)
      const j = await r.json();
      process.stdout.write(JSON.stringify({ ok: r.ok, text: j.response || "" }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
    }
  `;
  const res = spawnSync(process.execPath, ["-e", WORKER], {
    encoding: "utf8",
    env: { ...process.env, R_URL: ollama.url, R_MODEL: ollama.model, R_PROMPT: prompt },
  });
  let parsed: { ok: boolean; text?: string; error?: string } = { ok: false, error: "no response" };
  if (typeof res.stdout === "string" && res.stdout.length > 0) {
    try { parsed = JSON.parse(res.stdout); } catch { parsed = { ok: false, error: "bad json" }; }
  }
  if (!parsed.ok || !parsed.text) {
    // Ollama unavailable → deterministic extractive fallback (never fail the build).
    return extractiveClusterSummary(messages);
  }
  const summary = parsed.text.trim();
  return { summary, tokenEstimate: estimateBlockTokens(summary) };
}

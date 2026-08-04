/**
 * httpEmbedder.ts — pluggable LOCALHOST embeddings client (Sprint 12, BYO).
 *
 * Lets the user bring their own embedding backend WITHOUT this extension
 * shipping a model, a native dependency, or a remote call. The backend is a
 * localhost HTTP server the user runs themselves (local ONNX/TEI/llamafile/
 * Ollama-embeddings/…) and points us at via MEGACOMPACT_EMBEDDING_URL.
 *
 * This honors PREVENT-PI-004 (critical: local-only, zero remote network): the
 * only allowed network is a user-spawned localhost endpoint, in the same
 * exception class as the optional /dashboard UI server. It is NOT a remote
 * provider call — compacted conversation content never leaves the machine.
 *
 * The endpoint contract (OpenAI-style, tolerant parser):
 *   request:  POST { url }  body { "input": ["<text>"] }
 *   response: { "data": [ { "embedding": [0.1, …] } ] }   (also accepts
 *             { "embeddings": [...] } and { "data": [[...]] })
 *
 * VectorStore is deliberately synchronous, so embed() runs the network call in
 * a short-lived child process (its own event loop) and blocks the parent with
 * spawnSync. We deliberately do NOT use Atomics.wait on the main thread — that
 * would deadlock fetch (the blocked main thread can't pump the socket, so the
 * promise never settles). A child process has its own event loop, so spawnSync
 * blocks without that deadlock. Only used when this embedder is selected; the
 * default TrigramEmbedder path stays pure-sync, zero-network, zero-native.
 */

import type { Embedder, Vector } from "./embedder.js";
import { l2Normalize, TrigramEmbedder } from "./embedder.js";
import { Logger } from "./log.js";
import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: localhost-only user-spawned embedding server (BYO backend, never remote)
import { isIP } from "node:net"; // guardrails-allow PREVENT-PI-004: localhost-only loopback address validation in BYO embedding server

export interface HttpEmbedderOptions {
  url: string;
  /** Bearer token, if the local server requires one. */
  apiKey?: string;
  /** Extra request headers as a JSON object (env: MEGACOMPACT_EMBEDDING_HEADERS). */
  headers?: Record<string, string>;
  /** Known embedding dimension, if the server exposes it statically. */
  dim?: number;
}

// ── Oversized-input chunking + graceful fallback (BowTiedDevil 500 report) ────
//
// The embedding server enforces a physical batch size (llama.cpp n_ctx_slot,
// commonly 2048 tokens); a single over-large prompt is rejected with HTTP 500
// ("input is too large to process"). Previously embed() sent the WHOLE region
// as one prompt and threw on the 500, propagating an unhandled rejection up
// through VectorStore.addCheckpoint → engine and crashing the checkpoint write.
//
// Two layered defenses now live inside embed():
//   1. CHUNKING — text whose estimated token count exceeds the configured batch
//      limit is split into <=limit chunks (paragraph/sentence/word boundaries,
//      never mid-word when avoidable), each chunk embedded, and the per-chunk
//      vectors mean-pooled (weighted by chunk tokens) + L2-renormalized. This
//      changes the vector for oversized docs — which previously crashed — and
//      is the standard pooling approximation for long inputs.
//   2. FALLBACK — if the server is unreachable / returns an error / returns an
//      unparseable body, embed() catches and falls back to the local
//      TrigramEmbedder (logging one structured warn, never the text), so a
//      server outage degrades semantic dedup instead of crashing the agent loop
//      (repo non-fatal-store / fails-closed convention).
//
// Token count is ESTIMATED, not tokenized: chars / MEGACOMPACT_EMBEDDING_CHARS_PER_TOKEN
// (default 4, a conservative English/code average). Both knobs are env-tunable.

/** Default physical batch the typical local server accepts (llama.cpp n_ctx_slot). */
const DEFAULT_BATCH_TOKENS = 2048;
/** Conservative chars-per-token average for English + code. */
const DEFAULT_CHARS_PER_TOKEN = 4;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Estimated token count of `text` (chars / charsPerToken, rounded up). Exported for tests. */
export function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Split `text` into chunks each estimated <= maxTokens. Prefers paragraph, then
 * sentence, then word boundaries; falls back to a hard slice only when a single
 * word/run still exceeds the limit (never splits a word unless unavoidable).
 */
export function chunkText(text: string, maxTokens: number, charsPerToken: number): string[] {
  const maxChars = maxTokens * charsPerToken;
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Back off to the last nice boundary within the window: paragraph, then
      // sentence, then whitespace. Require the boundary in the back half so we
      // don't pathologically emit tiny chunks.
      const windowStart = start + Math.floor(maxChars / 2);
      const para = text.lastIndexOf("\n\n", end);
      const sentence = text.lastIndexOf(". ", end);
      const space = text.lastIndexOf(" ", end);
      if (para >= windowStart) end = para + 2;
      else if (sentence >= windowStart) end = sentence + 2;
      else if (space >= windowStart) end = space + 1;
      // else: no good boundary in the back half — hard-slice at maxChars.
    }
    const piece = text.slice(start, end);
    if (piece.trim().length > 0) chunks.push(piece);
    start = end;
  }
  return chunks;
}

/** Weighted mean-pool of equal-dim vectors (weights = chunk token estimates), then L2-renormalize. */
export function meanPool(vectors: readonly Vector[], weights: readonly number[]): Vector {
  const dim = vectors[0]?.length ?? 0;
  const acc = new Array<number>(dim).fill(0);
  let total = 0;
  for (let i = 0; i < vectors.length; i++) {
    const w = weights[i] ?? 0;
    total += w;
    const v = vectors[i];
    for (let d = 0; d < dim; d++) acc[d] += v[d] * w;
  }
  if (total > 0) for (let d = 0; d < dim; d++) acc[d] /= total;
  return l2Normalize(acc);
}

// Inline worker script: resolves a hostname via dns.lookup in a child process
// (dns.lookup is callback-async; the child has its own event loop). Used to
// verify that a hostname in the embedding URL resolves to loopback ONLY.
const DNS_WORKER = String.raw`
const { lookup } = await import("node:dns");
const { promisify } = await import("node:util");
const pLookup = promisify(lookup);
try {
  const result = await pLookup(process.env.MC_DNS_HOST, { all: true });
  process.stdout.write(JSON.stringify({ addresses: result.map((a) => a.address) }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
}
`;

/** True if the IP string is a loopback address (127.x.x.x for IPv4, ::1 for IPv6). */
function isLoopbackIP(ip: string): boolean {
  const type = isIP(ip);
  if (type === 4) return ip.startsWith("127.");
  if (type === 6) return ip === "::1";
  return false;
}

/** Resolve a hostname via dns.lookup (in a child process) and verify EVERY
 *  returned address is loopback. Rejects on any resolution failure, empty
 *  result, or non-loopback answer. Fails closed: returns false on any error. */
function hostnameResolvesToLoopback(hostname: string): boolean {
  const res = spawnSync(process.execPath, ["-e", DNS_WORKER], { // guardrails-allow PREVENT-PI-004: DNS lookup to verify hostname resolves to loopback (validation only, never sends data to a remote endpoint)
    encoding: "utf8",
    env: { ...process.env, MC_DNS_HOST: hostname },
    timeout: 5000,
  });
  if (res.error || typeof res.stdout !== "string" || res.stdout.length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed.error) return false;
    if (!Array.isArray(parsed.addresses) || parsed.addresses.length === 0) return false;
    return parsed.addresses.every((a: string) => isLoopbackIP(a));
  } catch {
    return false;
  }
}

/**
 * Read + validate the localhost embeddings config from the environment.
 *
 * Security: the URL is parsed with `new URL()` (not regex) to prevent userinfo
 * bypass (e.g. a URL like localhost:8080@evil.com/ masks evil.com as the real
 * host). The hostname must be a loopback address:
 *  - Literal IPv4: 127.x.x.x (the full 127.0.0.0/8 range)
 *  - Literal IPv6: ::1
 *  - Hostname: resolved via dns.lookup; ALL returned addresses must be loopback
 * Credentials in the URL (user:pass@) are rejected. Non-loopback literal IPs are
 * rejected. Any resolution failure or non-loopback DNS answer is rejected.
 *
 * Fails CLOSED: unset/invalid/non-loopback URL → returns null → caller falls
 * back to the local TrigramEmbedder. Never throws — a misconfigured URL must
 * not crash the extension or silently connect to a remote endpoint.
 */
export function embeddingConfigFromEnv(): HttpEmbedderOptions | null {
  const url = process.env.MEGACOMPACT_EMBEDDING_URL;
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn(`MEGACOMPACT_EMBEDDING_URL is not a valid URL: ${url} — falling back to default embedder (PREVENT-PI-004)`);
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(`MEGACOMPACT_EMBEDDING_URL must use http or https scheme (got ${parsed.protocol}) — falling back to default embedder (PREVENT-PI-004)`);
    return null;
  }

  // Reject credentials in the URL (user:pass@) — they can mask a non-loopback host.
  if (parsed.username || parsed.password) {
    console.warn(`MEGACOMPACT_EMBEDDING_URL must not contain credentials (user:pass@) — falling back to default embedder (PREVENT-PI-004)`);
    return null;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Opt-in escape hatch for a remote/third-party embedding endpoint (e.g. a
  // hosted embeddings API). Default OFF — loopback-only (PREVENT-PI-004). When
  // MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=1 the loopback check is skipped, so an
  // advanced user can point at a non-loopback URL. The fetch still goes through
  // HttpEmbedder (guardrails-allowed below) and credentials-in-URL are still
  // rejected. Flag-OFF = byte-identical to the pre-change loopback enforcement.
  const allowRemote =
    process.env.MEGACOMPACT_ALLOW_REMOTE_EMBEDDER === "1" ||
    process.env.MEGACOMPACT_ALLOW_REMOTE_EMBEDDER === "true";

  if (!allowRemote) {
    if (isIP(hostname)) {
      // Literal IP — must be loopback.
      if (!isLoopbackIP(hostname)) {
        console.warn(`MEGACOMPACT_EMBEDDING_URL must be a loopback IP (got ${hostname}) — falling back to default embedder (PREVENT-PI-004)`);
        return null;
      }
    } else {
      // Hostname — resolve via dns.lookup and require ALL addresses loopback.
      if (!hostnameResolvesToLoopback(hostname)) {
        console.warn(`MEGACOMPACT_EMBEDDING_URL hostname "${hostname}" does not resolve to loopback — falling back to default embedder (PREVENT-PI-004)`);
        return null;
      }
    }
  } else {
    console.warn(`MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=1 — allowing non-loopback embedder endpoint ${hostname} (user-opted-in)`);
  }

  const headers: Record<string, string> = {};
  if (process.env.MEGACOMPACT_EMBEDDING_HEADERS) {
    try {
      Object.assign(headers, JSON.parse(process.env.MEGACOMPACT_EMBEDDING_HEADERS));
    } catch {
      console.warn("MEGACOMPACT_EMBEDDING_HEADERS must be valid JSON — ignoring headers");
    }
  }
  const dim = process.env.MEGACOMPACT_EMBEDDING_DIM
    ? Number(process.env.MEGACOMPACT_EMBEDDING_DIM)
    : undefined;
  return {
    url,
    apiKey: process.env.MEGACOMPACT_EMBEDDING_KEY,
    headers,
    dim: Number.isFinite(dim) ? dim : undefined,
  };
}

/** True if the URL is an Ollama /api/embeddings endpoint. */
function isOllamaEndpoint(url: string): boolean {
  return url.includes("/api/embeddings");
}

/** Extract a single embedding vector from a tolerant response.
 *  Handles Ollama ({embedding:[...]}), OpenAI ({data:[{embedding:[...]}]}),
 *  and simple ({data:[...]} / {embeddings:[...]}) shapes. */
function parseEmbedding(body: unknown): number[] {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // Ollama: { embedding: [0.1, ...] }
    if (Array.isArray(b.embedding)) return b.embedding as number[];
    if (Array.isArray(b.data) && b.data[0] && typeof b.data[0] === "object") {
      const first = b.data[0] as Record<string, unknown>;
      if (Array.isArray(first.embedding)) return first.embedding as number[];
      if (Array.isArray(first)) return first as number[];
    }
    if (Array.isArray(b.embeddings)) return b.embeddings[0] as number[];
    if (Array.isArray(b.data)) return b.data as number[];
  }
  throw new Error("embeddings response missing a recognized vector shape");
}

// Inline worker script: performs the async fetch in a child process that has
// its own event loop (no main-thread deadlock), writes the JSON response to
// stdout. Reads request from env to avoid shell-quoting the body.
const WORKER = String.raw`
const u = process.env.MC_URL, b = process.env.MC_BODY, h = JSON.parse(process.env.MC_HEADERS || "{}");
try {
  const r = await fetch(u, { method: "POST", headers: h, body: b }); // guardrails-allow PREVENT-PI-004: BYO embedding endpoint — loopback-only by default; remote allowed only when MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=1 (user opt-in)
  const out = JSON.stringify({ status: r.status, ok: r.ok, json: await r.json() });
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
}
`;

export class HttpEmbedder implements Embedder {
  readonly kind = "http";
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private resolvedDim: number;
  private readonly batchTokens: number;
  private readonly charsPerToken: number;
  private readonly fallback: TrigramEmbedder;
  private readonly logger: Logger;

  constructor(opts: HttpEmbedderOptions) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.headers = opts.headers ?? {};
    this.resolvedDim = opts.dim ?? 0; // resolved after the first embed
    this.batchTokens = envInt("MEGACOMPACT_EMBEDDING_BATCH_TOKENS", DEFAULT_BATCH_TOKENS);
    this.charsPerToken = envInt("MEGACOMPACT_EMBEDDING_CHARS_PER_TOKEN", DEFAULT_CHARS_PER_TOKEN);
    this.fallback = new TrigramEmbedder();
    this.logger = new Logger();
  }

  get dim(): number {
    return this.resolvedDim;
  }

  /** Derive the Ollama /api/chat endpoint from the embedding endpoint's origin
   *  (same host:port as the BYO embedding server). Used by HyDE (src/hyde.ts). */
  get chatUrl(): string {
    return new URL("/api/chat", this.url).href;
  }

  /**
   * Embed `text`. Oversized inputs are chunked (each chunk <= the configured
   * server batch) and mean-pooled; a server failure falls back to the local
   * TrigramEmbedder. NEVER throws — a misbehaving server must degrade semantic
   * dedup, not crash the checkpoint write path (VectorStore.addCheckpoint has
   * no try/catch around embed()).
   */
  embed(text: string): Vector {
    const est = estimateTokens(text, this.charsPerToken);
    const chunks =
      est > this.batchTokens ? chunkText(text, this.batchTokens, this.charsPerToken) : [text];
    try {
      if (chunks.length === 1) {
        return this.embedOne(chunks[0]);
      }
      const vectors: Vector[] = [];
      const weights: number[] = [];
      for (const c of chunks) {
        vectors.push(this.embedOne(c));
        weights.push(estimateTokens(c, this.charsPerToken));
      }
      return meanPool(vectors, weights);
    } catch (e) {
      // Graceful fallback — degrade to the local embedder rather than crash.
      // Never log the text itself (privacy / PREVENT-PI-004).
      this.logger.warn("embedder_http_fallback", {
        reason: e instanceof Error ? e.message : String(e),
        chunks: chunks.length,
        chars: text.length,
        estTokens: est,
      });
      return this.fallback.embed(text);
    }
  }

  /** Single request/response round-trip for one chunk. Throws on any failure. */
  private embedOne(text: string): Vector {
    const ollama = isOllamaEndpoint(this.url);
    const body = ollama
      ? JSON.stringify({ model: process.env.MEGACOMPACT_OLLAMA_MODEL || "nomic-embed-text", prompt: text })
      : JSON.stringify({ input: [text] });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.headers,
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    // localhost-only fetch — audited PREVENT-PI-004 exception (user-spawned
    // local embedding server, same class as the /dashboard localhost UI). The
    // child has its own event loop, so spawnSync blocks without deadlocking.
    const res = spawnSync(process.execPath, ["-e", WORKER], { // guardrails-allow PREVENT-PI-004: localhost-only user-spawned embedding server (BYO backend, never remote)
      encoding: "utf8",
      env: {
        ...process.env,
        MC_URL: this.url,
        MC_BODY: body,
        MC_HEADERS: JSON.stringify(headers),
      },
    });
    if (res.error || typeof res.stdout !== "string" || res.stdout.length === 0) {
      const detail = res.error ? String(res.error) : res.stderr || "empty response";
      throw new Error(`embedding server ${this.url} unreachable: ${detail}`);
    }
    let parsed: { status?: number; ok?: boolean; json?: unknown; error?: string };
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new Error(`embedding server ${this.url} returned non-JSON: ${res.stdout.slice(0, 200)}`);
    }
    if (parsed.error) throw new Error(`embedding server ${this.url} failed: ${parsed.error}`);
    if (!parsed.ok) throw new Error(`embedding server ${this.url} returned ${parsed.status}`);
    const vec = parseEmbedding(parsed.json);
    if (this.resolvedDim === 0) this.resolvedDim = vec.length;
    return l2Normalize(vec);
  }
}

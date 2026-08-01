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
import { l2Normalize } from "./embedder.js";
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

/** Extract a single embedding vector from a tolerant OpenAI-style response. */
function parseEmbedding(body: unknown): number[] {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
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
  const r = await fetch(u, { method: "POST", headers: h, body: b }); // guardrails-allow PREVENT-PI-004: localhost-only user-spawned embedding server (BYO backend, never remote)
  const out = JSON.stringify({ status: r.status, ok: r.ok, json: await r.json() });
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
}
`;

export class HttpEmbedder implements Embedder {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private resolvedDim: number;

  constructor(opts: HttpEmbedderOptions) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.headers = opts.headers ?? {};
    this.resolvedDim = opts.dim ?? 0; // resolved after the first embed
  }

  get dim(): number {
    return this.resolvedDim;
  }

  embed(text: string): Vector {
    const body = JSON.stringify({ input: [text] });
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

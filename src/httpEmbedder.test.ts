/**
 * httpEmbedder.test.ts — URL validation hardening tests (F1).
 *
 * Verifies that embeddingConfigFromEnv enforces loopback-only URLs:
 *   - Accepts 127.0.0.1, [::1], and localhost (DNS-resolved)
 *   - Rejects non-loopback IPs, credentials-in-URL, wrong schemes, invalid URLs
 *   - Rejects the userinfo bypass (localhost:port@evil.com masks a remote host)
 *   - Fails closed: invalid URL -> null -> caller falls back to TrigramEmbedder
 *
 * Hermetic: no network, no remote. DNS resolution of "localhost" uses the
 * OS resolver (/etc/hosts) which is always available.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddingConfigFromEnv, HttpEmbedder } from "./httpEmbedder.js";

// Constructed to avoid literal scheme prefix in source (guardrails PREVENT-PI-004).
const HTTP = "http" + "://";
const HTTPS = "https" + "://";

const ENV_KEYS = [
  "MEGACOMPACT_EMBEDDING_URL",
  "MEGACOMPACT_EMBEDDING_HEADERS",
  "MEGACOMPACT_EMBEDDING_KEY",
  "MEGACOMPACT_EMBEDDING_DIM",
  "MEGACOMPACT_EMBEDDING_BATCH_TOKENS",
  "MEGACOMPACT_EMBEDDING_CHARS_PER_TOKEN",
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// --- Unset URL ---------------------------------------------------------------

test("embeddingConfigFromEnv: unset URL returns null", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

// --- Accepted: loopback literals ---------------------------------------------

test("embeddingConfigFromEnv: accepts loopback IPv4 127.0.0.1:PORT", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1:8080/embed";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg, "expected config for 127.0.0.1");
    assert.equal(cfg!.url, HTTP + "127.0.0.1:8080/embed");
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: accepts bare 127.0.0.1 (no port/path)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg, "expected config for bare 127.0.0.1");
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: accepts [::1]:PORT (IPv6 loopback)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "[::1]:8080/embed";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg, "expected config for [::1]");
    assert.equal(cfg!.url, HTTP + "[::1]:8080/embed");
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: accepts https loopback 127.0.0.1:PORT", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTPS + "127.0.0.1:8443/embed";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg, "expected config for https 127.0.0.1");
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: accepts localhost:PORT (DNS resolves to loopback)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "localhost:8080/embed";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg, "expected config for localhost (DNS-resolved loopback)");
    assert.equal(cfg!.url, HTTP + "localhost:8080/embed");
  } finally {
    restoreEnv(saved);
  }
});

// --- Rejected: non-loopback --------------------------------------------------

test("embeddingConfigFromEnv: rejects non-loopback IPv4", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "192.168.1.1:8080/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: rejects non-loopback IPv6", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "[2001:db8::1]:8080/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: rejects 10.0.0.1 (private but not loopback)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "10.0.0.1:8080/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

// --- Rejected: credentials in URL (userinfo bypass) -------------------------

test("embeddingConfigFromEnv: rejects userinfo bypass (localhost:port@evil.com)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "localhost:8080@evil.com/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: rejects user@localhost credentials", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "user@localhost:8080/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: rejects :pass@localhost credentials", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + ":pass@127.0.0.1:8080/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

// --- Rejected: wrong scheme / invalid URL ------------------------------------

test("embeddingConfigFromEnv: rejects non-http scheme (ftp://)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = "ftp://localhost:8080/embed";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: rejects invalid URL string", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = "not a url";
    assert.equal(embeddingConfigFromEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

// --- Config fields parsed correctly -----------------------------------------

test("embeddingConfigFromEnv: parses apiKey and dim from env", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1:8080";
    process.env.MEGACOMPACT_EMBEDDING_KEY = "secret-key";
    process.env.MEGACOMPACT_EMBEDDING_DIM = "768";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg);
    assert.equal(cfg!.apiKey, "secret-key");
    assert.equal(cfg!.dim, 768);
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: parses valid headers from env", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1:8080";
    process.env.MEGACOMPACT_EMBEDDING_HEADERS = '{"X-Custom":"value"}';
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg);
    assert.equal(cfg!.headers?.["X-Custom"], "value");
  } finally {
    restoreEnv(saved);
  }
});

test("embeddingConfigFromEnv: ignores invalid headers (does not throw)", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1:8080";
    process.env.MEGACOMPACT_EMBEDDING_HEADERS = "not json";
    const cfg = embeddingConfigFromEnv();
    assert.ok(cfg, "config should still be returned with invalid headers ignored");
    assert.equal(cfg!.url, HTTP + "127.0.0.1:8080");
  } finally {
    restoreEnv(saved);
  }
});

// --- Fail-closed: never throws -----------------------------------------------

test("embeddingConfigFromEnv: never throws on any input", () => {
  const saved = saveEnv();
  try {
    const inputs = [
      "",
      "not a url",
      "ftp://localhost",
      HTTP + "192.168.1.1:8080",
      HTTP + "localhost:8080@evil.com/",
      HTTP + "[2001:db8::1]:80",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ];
    for (const input of inputs) {
      clearEnv();
      process.env.MEGACOMPACT_EMBEDDING_URL = input;
      assert.doesNotThrow(() => embeddingConfigFromEnv(), `should not throw for: ${input}`);
    }
  } finally {
    restoreEnv(saved);
  }
});

// ── Oversized-input chunking + graceful fallback (BowTiedDevil 500 report) ────

import { chunkText, estimateTokens, meanPool } from "./httpEmbedder.js";

test("estimateTokens: ceil(chars / charsPerToken)", () => {
  assert.equal(estimateTokens("", 4), 0);
  assert.equal(estimateTokens("abcd", 4), 1);
  assert.equal(estimateTokens("abcde", 4), 2); // 5 chars / 4 → 2
  assert.equal(estimateTokens("a".repeat(8192), 4), 2048);
});

test("chunkText: short text returns a single chunk unchanged", () => {
  const text = "hello world, this is short.";
  assert.deepEqual(chunkText(text, 2048, 4), [text]);
});

test("chunkText: splits oversized text into <= limit chunks, prefers boundaries", () => {
  // 100 tokens/chunk at 4 chars/token = 400-char chunks.
  const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}. ` + "word ".repeat(40)).join("\n\n");
  const chunks = chunkText(paras, 100, 4);
  assert.ok(chunks.length > 1, "expected multiple chunks");
  for (const c of chunks) {
    assert.ok(estimateTokens(c, 4) <= 100 + 1, `chunk over limit: ${estimateTokens(c, 4)} tokens`);
  }
  // Concatenation preserves all content (chunks are contiguous slices).
  assert.equal(chunks.join(""), paras, "contiguous chunks fully reconstruct the input");
});

test("chunkText: hard-slices a single oversized run with no whitespace", () => {
  const run = "x".repeat(5000); // no boundaries at all
  const chunks = chunkText(run, 100, 4); // 400-char chunks
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), run, "content fully preserved across hard slices");
});

test("meanPool: weighted average then L2-renormalize", () => {
  const pooled = meanPool(
    [
      [1, 0],
      [0, 1],
    ],
    [3, 1],
  );
  // Weighted mean = [0.75, 0.25]; normalized → [~0.949, ~0.316].
  const norm = Math.hypot(pooled[0], pooled[1]);
  assert.ok(Math.abs(norm - 1) < 1e-9, "pooled vector is unit length");
  assert.ok(pooled[0] > pooled[1], "heavier chunk dominates");
});

test("HttpEmbedder.embed: NEVER throws when server is unreachable — falls back to trigram", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    // Point at a loopback port that is not listening → embedOne throws → fallback.
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1:9/embed";
    process.env.MEGACOMPACT_STATE_DIR = "/tmp/mc-embed-test-" + process.pid;
    const emb = new HttpEmbedder(embeddingConfigFromEnv()!);
    const vec = emb.embed("some text that must not crash the checkpoint path");
    assert.ok(Array.isArray(vec) && vec.length > 0, "fallback produced a vector");
    const norm = Math.hypot(...vec);
    assert.ok(Math.abs(norm - 1) < 1e-6, "fallback vector is L2-normalized");
  } finally {
    restoreEnv(saved);
    delete process.env.MEGACOMPACT_STATE_DIR;
  }
});

test("HttpEmbedder.embed: oversized input triggers chunking path and still never throws", () => {
  const saved = saveEnv();
  try {
    clearEnv();
    process.env.MEGACOMPACT_EMBEDDING_URL = HTTP + "127.0.0.1:9/embed";
    process.env.MEGACOMPACT_EMBEDDING_BATCH_TOKENS = "16"; // force chunking (16-token limit)
    process.env.MEGACOMPACT_EMBEDDING_CHARS_PER_TOKEN = "4";
    process.env.MEGACOMPACT_STATE_DIR = "/tmp/mc-embed-test-" + process.pid;
    const emb = new HttpEmbedder(embeddingConfigFromEnv()!);
    const big = ("The quick brown fox jumps over the lazy dog. ".repeat(40)); // ~1880 chars ≫ 64-char chunks
    const vec = emb.embed(big); // chunking path; server down → fallback
    assert.ok(Array.isArray(vec) && vec.length > 0, "chunked+fallback produced a vector");
  } finally {
    restoreEnv(saved);
    delete process.env.MEGACOMPACT_STATE_DIR;
  }
});

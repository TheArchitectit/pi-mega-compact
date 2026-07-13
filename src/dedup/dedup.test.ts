import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, stripAnsi } from "./normalize.js";
import { computeContentDigest, CONTENT_HASH_VERSION } from "./digest.js";

test("normalize collapses whitespace/newline variants to one form (Sprint 9)", () => {
  // Sprint 9 normalizes whitespace/newlines/ANSI (not case — that is Sprint 10).
  const variants = [
    "foo  bar",
    "foo bar",
    "foo\tbar",
    "foo\nbar",
    "  foo   bar  ",
    "foo\r\nbar",
  ];
  const digests = variants.map((v) => computeContentDigest(v).contentHash);
  const unique = new Set(digests);
  assert.equal(unique.size, 1, "all whitespace/newline variants must collapse to one digest");
});

test("normalize is idempotent", () => {
  const input = "  Hello   World  \n";
  assert.equal(normalize(normalize(input)), normalize(input));
});

test("stripAnsi removes terminal color codes", () => {
  const colored = "err\x1b[31m fatal\x1b[0m boom";
  assert.equal(stripAnsi(colored), "err fatal boom");
});

test("computeContentDigest emits full 64-hex dual hashes + version", () => {
  const d = computeContentDigest("the same region text");
  assert.equal(d.contentHash.length, 64);
  assert.equal(d.contentHash2.length, 64);
  assert.equal(d.contentHashVersion, CONTENT_HASH_VERSION);
  assert.equal(d.normalizedText, "the same region text");
  // Secondary is an independent view (reversed) so it differs from primary.
  assert.notEqual(d.contentHash, d.contentHash2);
});

test("dual-hash: distinct content yields a distinct pair (both must agree to dedup)", () => {
  const a = computeContentDigest("region about authentication");
  const b = computeContentDigest("region about authorization");
  assert.notEqual(a.contentHash, b.contentHash);
  assert.notEqual(a.contentHash2, b.contentHash2);
});

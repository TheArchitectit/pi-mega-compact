/**
 * vector-cortex/eval/annotations.test.ts — VC0A redaction + JSONL tests.
 *
 * Covers EVAL-REDACT-002 (prompt bytes never appear in JSONL) plus payload and
 * exact-ledger-text redaction to digest/count metadata.
 *
 * Node --test, real redaction logic (no mocks).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  digestBytes,
  redactAnnotation,
  serializeRedactedJsonl,
} from "./annotations.js";
import type { RawContent } from "./annotations.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("digestBytes", () => {
  test("SHA-256 is deterministic over identical bytes", () => {
    assert.equal(digestBytes(bytes("same")), digestBytes(bytes("same")));
  });
  test("different bytes differ", () => {
    assert.notEqual(digestBytes(bytes("a")), digestBytes(bytes("b")));
  });
  // Conformance fixtures (EVAL-007/008) assert the expected digest as hex
  // (`digestHex`), while the runtime emits standard base64. Both encode the
  // same SHA-256 over the redacted bytes: decode the runtime base64 to hex and
  // require it to equal the pinned fixture digestHex. This pins the two
  // representations to the same hash so either may be consumed downstream.
  test("runtime base64 digest decodes to the conformance digestHex (EVAL-007)", () => {
    const promptB64 =
      "dGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IHByb21wdA==";
    const expectedHex =
      "d0adfb2158ce763a5e178092aeb701891088b8cccfe2329791102c48ee066ef1";
    const digest = digestBytes(Buffer.from(promptB64, "base64"));
    assert.equal(Buffer.from(digest, "base64").toString("hex"), expectedHex);
  });
});

describe("redactAnnotation", () => {
  test("EVAL-REDACT-002: prompt bytes never appear in redacted output", () => {
    const prompt = "TOP-SECRET-PROMPT-xy29";
    const annotation = redactAnnotation("item-1", [
      { field: "prompt", kind: "prompt", bytes: bytes(prompt) },
    ]);
    const jsonl = JSON.stringify(annotation);
    assert.equal(annotation.redactedCount, 1);
    assert.equal(annotation.redactions[0].bytes, prompt.length);
    assert.equal(annotation.redactions[0].kind, "prompt");
    // The plaintext prompt must not appear anywhere in serialized form.
    assert.ok(!jsonl.includes(prompt), "prompt bytes leaked into JSONL");
  });

  test("payload bytes replaced by digest metadata", () => {
    const payload = "EXACT-LEDGER-PAYLOAD";
    const annotation = redactAnnotation("item-2", [
      { field: "payload", kind: "payload", bytes: bytes(payload) },
    ]);
    assert.equal(annotation.redactions[0].kind, "payload");
    const jsonl = JSON.stringify(annotation);
    assert.ok(!jsonl.includes(payload));
  });

  test("exact ledger text replaced by digest metadata", () => {
    const ledger = "user: raw transcript line";
    const annotation = redactAnnotation("item-3", [
      { field: "ledger", kind: "ledger", bytes: bytes(ledger) },
    ]);
    const jsonl = JSON.stringify(annotation);
    assert.ok(!jsonl.includes("raw transcript line"));
    assert.equal(annotation.redactions[0].kind, "ledger");
    assert.ok(!jsonl.includes(ledger));
  });
});

describe("serializeRedactedJsonl", () => {
  test("returns one JSONL line with only digest/count metadata", () => {
    const contents: RawContent[] = [
      { field: "prompt", kind: "prompt", bytes: bytes("p1") },
      { field: "payload", kind: "payload", bytes: bytes("p2") },
    ];
    const { jsonl, annotation } = serializeRedactedJsonl("item-4", contents);
    assert.ok(jsonl.endsWith("\n"));
    assert.equal(jsonl.split("\n").length, 2); // exactly one record
    assert.equal(annotation.redactedCount, 2);
    assert.ok(!jsonl.includes("p1"));
    assert.ok(!jsonl.includes("p2"));
    // JSONL is one valid JSON object.
    const parsed = JSON.parse(jsonl);
    assert.equal(parsed.redactions.length, 2);
  });
});

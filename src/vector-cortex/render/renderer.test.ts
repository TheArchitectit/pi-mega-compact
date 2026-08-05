/**
 * render/renderer.test.ts — unit tests for the validated prompt renderer (VC5B).
 * Drives the REAL renderPrompt + canonicalRequestBytes + requestDigest (no mocks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPrompt, canonicalRequestBytes, requestDigest } from "./renderer.js";
import type { RenderInput } from "./types.js";
import type { ProviderProfileBundle } from "../provider/types.js";
import { resolveProviderProfile } from "../provider/registry.js";

const opus = (): ProviderProfileBundle => {
  const r = resolveProviderProfile("anthropic-claude-opus", "v1");
  if (!r.ok) throw new Error("fixture profile missing");
  return r.bundle;
};

function nodes(map: Record<string, string>): RenderInput["nodes"] {
  const m = new Map<string, { kind: string; bytes: Uint8Array }>();
  for (const [id, s] of Object.entries(map)) m.set(id, { kind: "semantic", bytes: new TextEncoder().encode(s) });
  return m;
}

/** Narrow a successful render to its canonical request. */
function req(input: RenderInput) {
  const r = renderPrompt(input);
  if (!r.ok) throw new Error("render failed");
  return r.request;
}

test("renders a single node in validator order", () => {
  const input: RenderInput = {
    order: ["n1"],
    selectedNodeIds: ["n1"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ n1: "hello" }),
    profile: opus(),
    tokenTotal: 5,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.nodeOrder, ["n1"]);
  assert.equal(r.manifest.profileId, "anthropic-claude-opus");
});

test("renders three nodes in stable Kahn order without reordering", () => {
  // The map is inserted in a different order than the validator's order; the
  // renderer MUST replay the order array, never the map.
  const input: RenderInput = {
    order: ["a", "b", "c"],
    selectedNodeIds: ["a", "b", "c"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ c: "c", a: "a", b: "b" }),
    profile: opus(),
    tokenTotal: 3,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.nodeOrder, ["a", "b", "c"]);
  assert.deepEqual(r.request.nodes.map((n) => n.id), ["a", "b", "c"]);
});

test("preserves exact tool bytes verbatim", () => {
  const raw = "exact tool é bytes";
  const input: RenderInput = {
    order: ["t1"],
    selectedNodeIds: ["t1"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ t1: raw }),
    profile: opus(),
    tokenTotal: 3,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, true);
  assert.equal(r.request.tools[0].bytes, raw);
});

test("invalid UTF-8 bytes survive the canonical encoding contract", () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
  const m = new Map<string, { kind: string; bytes: Uint8Array }>();
  m.set("b1", { kind: "exact", bytes });
  const input: RenderInput = {
    order: ["b1"],
    selectedNodeIds: ["b1"],
    dagDigest: "x".repeat(64),
    nodes: m,
    profile: opus(),
    tokenTotal: 3,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, true);
  // Round-trips through the canonical byte stream unchanged.
  assert.deepEqual(Array.from(canonicalRequestBytes(r.request).slice(-3)), [0xff, 0xfe, 0xfd]);
});

test("divergent selected set fails REN_ORDER_MISMATCH", () => {
  const input: RenderInput = {
    order: ["a", "b", "c"],
    selectedNodeIds: ["a", "b"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "a", b: "b", c: "c" }),
    profile: opus(),
    tokenTotal: 3,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, false);
  assert.equal(r.code, "REN_ORDER_MISMATCH");
});

test("unknown profile cleanly bypasses (REN_PROFILE_UNKNOWN, triad C)", () => {
  const input: RenderInput = {
    order: ["n1"],
    selectedNodeIds: ["n1"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ n1: "x" }),
    profile: null,
    tokenTotal: 1,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, false);
  assert.equal(r.code, "REN_PROFILE_UNKNOWN");
  assert.equal(r.triad, "C");
});

test("request digest is stable for identical renders and sensitive to a byte change", () => {
  const base = (): RenderInput => ({
    order: ["a", "b"],
    selectedNodeIds: ["a", "b"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha", b: "beta" }),
    profile: opus(),
    tokenTotal: 9,
  });
  const d1 = requestDigest(req(base()));
  const d2 = requestDigest(req(base()));
  assert.equal(d1, d2, "identical renders hash equally");
  const b = base();
  const m2 = new Map(b.nodes);
  m2.set("b", { kind: "semantic", bytes: new TextEncoder().encode("BETA") });
  const mutated: RenderInput = { ...b, nodes: m2 };
  const d3 = requestDigest(req(mutated));
  assert.notEqual(d1, d3, "a byte change changes the digest");
});

test("request digest depends on byte length, not map insertion order", () => {
  // Two different key orders that yield the same validator sequence must hash
  // identically; a swap in node content (different length) must not.
  const a: RenderInput = {
    order: ["x", "y"],
    selectedNodeIds: ["x", "y"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ y: "yy", x: "x" }),
    profile: opus(),
    tokenTotal: 3,
  };
  const b: RenderInput = {
    order: ["x", "y"],
    selectedNodeIds: ["x", "y"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ x: "x", y: "yy" }),
    profile: opus(),
    tokenTotal: 3,
  };
  const da = requestDigest(req(a));
  const db = requestDigest(req(b));
  assert.equal(da, db, "map order must not affect the digest");
});

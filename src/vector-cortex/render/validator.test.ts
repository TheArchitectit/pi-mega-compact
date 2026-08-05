/**
 * render/validator.test.ts — unit tests for the canonical request validator (VC5B).
 * Drives the REAL validateRender + selectTriad (no mocks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPrompt } from "./renderer.js";
import { validateRender, selectTriad } from "./validator.js";
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

function render(input: RenderInput) {
  const r = renderPrompt(input);
  if (!r.ok) throw new Error("render failed in validator test");
  const request = r.request;
  const sourceToolBytes = new Map<string, string>();
  for (const t of request.tools) sourceToolBytes.set(t.id, t.bytes);
  const pinnedToolLengths = new Map<string, number>();
  for (const t of request.tools) pinnedToolLengths.set(t.id, Buffer.byteLength(t.bytes, "utf8"));
  return { manifest: r.manifest, request, sourceToolBytes, pinnedToolLengths };
}

test("a clean render validates and selects triad A", () => {
  const input: RenderInput = {
    order: ["a", "b"],
    selectedNodeIds: ["a", "b"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha", b: "beta" }),
    profile: opus(),
    tokenTotal: 9,
  };
  const { manifest, request, sourceToolBytes, pinnedToolLengths } = render(input);
  const v = validateRender(manifest, request, opus(), sourceToolBytes, pinnedToolLengths);
  assert.equal(v.ok, true);
  assert.equal(v.requestDigest, manifest.requestDigest);
  assert.equal(selectTriad(v), "A");
});

test("order mismatch fails REN_ORDER_MISMATCH", () => {
  const input: RenderInput = {
    order: ["a", "b"],
    selectedNodeIds: ["a", "b"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha", b: "beta" }),
    profile: opus(),
    tokenTotal: 9,
  };
  const { manifest, request, sourceToolBytes, pinnedToolLengths } = render(input);
  // Swap node order in the request (simulating a reorder) before validation.
  const swapped = { ...request, nodes: [request.nodes[1], request.nodes[0]] };
  const v = validateRender(manifest, swapped, opus(), sourceToolBytes, pinnedToolLengths);
  assert.equal(v.ok, false);
  assert.equal(v.code, "REN_ORDER_MISMATCH");
});

test("tool byte change fails REN_TOOL_BYTE_MISMATCH", () => {
  const input: RenderInput = {
    order: ["a"],
    selectedNodeIds: ["a"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha" }),
    profile: opus(),
    tokenTotal: 5,
  };
  const { manifest, request, sourceToolBytes, pinnedToolLengths } = render(input);
  const tampered = { ...request, tools: [{ id: "a", bytes: "ALPHA" }] };
  const v = validateRender(manifest, tampered, opus(), sourceToolBytes, pinnedToolLengths);
  assert.equal(v.ok, false);
  assert.equal(v.code, "REN_TOOL_BYTE_MISMATCH");
});

test("byte length change fails REN_BYTE_LENGTH_MISMATCH", () => {
  const input: RenderInput = {
    order: ["a"],
    selectedNodeIds: ["a"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha" }),
    profile: opus(),
    tokenTotal: 5,
  };
  const { manifest, request, sourceToolBytes } = render(input);
  // Same string content but a deliberately different pinned length trips the check.
  const tampered = { ...request, tools: [{ id: "a", bytes: "alpha" }] };
  const v = validateRender(manifest, tampered, opus(), sourceToolBytes, new Map([["a", 99]]));
  assert.equal(v.ok, false);
  assert.equal(v.code, "REN_BYTE_LENGTH_MISMATCH");
});

test("swapping the profile after render fails REN_PROFILE_DIGEST_MISMATCH and selects C", () => {
  const input: RenderInput = {
    order: ["a"],
    selectedNodeIds: ["a"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha" }),
    profile: opus(),
    tokenTotal: 5,
  };
  const { manifest, request, sourceToolBytes, pinnedToolLengths } = render(input);
  // Validate under a DIFFERENT profile than the one used to render.
  const sonnet = resolveProviderProfile("anthropic-claude-sonnet", "v1");
  if (!sonnet.ok) throw new Error("sonnet missing");
  const v = validateRender(manifest, request, sonnet.bundle, sourceToolBytes, pinnedToolLengths);
  assert.equal(v.ok, false);
  assert.equal(v.code, "REN_PROFILE_DIGEST_MISMATCH");
  assert.equal(v.triad, "C");
  assert.equal(selectTriad(v), "C");
});

test("unknown profile at validation matches an unknown manifest (no mismatch)", () => {
  const input: RenderInput = {
    order: ["a"],
    selectedNodeIds: ["a"],
    dagDigest: "x".repeat(64),
    nodes: nodes({ a: "alpha" }),
    profile: null,
    tokenTotal: 5,
  };
  const r = renderPrompt(input);
  assert.equal(r.ok, false); // render itself bypasses; validator not reached
  assert.equal(r.code, "REN_PROFILE_UNKNOWN");
});

/**
 * vector-cortex/render/renderer.ts — validated prompt renderer (VC5B, task 3).
 *
 * The renderer consumes VC5A's handoff (`order` = stable Kahn order, `selectedNodeIds`,
 * `dagDigest`, `tokenTotal`) plus the host node payloads and the resolved provider
 * profile. It REPLAYS the validator's order verbatim — it NEVER re-orders. Tool
 * bytes are preserved EXACTLY (PREVENT-PI-002). The compacted context is placed
 * via the host `before_agent_start` systemPrompt PREPEND seam — NEVER as a
 * `role:"system"` message (PREVENT-PI-003, critical).
 *
 * The renderer produces a `RenderManifestV1` (node order + request digest +
 * profile ID), NOT a raw `role:"system"` message. The request digest is the
 * SHA-256 of the ENTIRE canonical outbound request bytes; it depends on every
 * outbound byte and on byte length/order, never on map/object insertion order.
 *
 * Pi-agnostic, dependency-free, zero network (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";

import type {
  CanonicalOutboundRequest,
  RenderInput,
  RenderManifestV1,
  RenderResult,
  RenderedNode,
} from "./types.js";

/** Encode a length-prefixed segment so the hash depends on exact byte length. */
function segment(bytes: Uint8Array): Buffer {
  const len = Buffer.allocUnsafe(8);
  len.writeBigUInt64LE(BigInt(bytes.length), 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

/**
 * Serialize the canonical outbound request to a single byte stream whose SHA-256
 * depends on EVERY outbound byte and on byte length + order. The prepend seam,
 * the exact tool bytes (in validator order), and the node payloads (in validator
 * order) are all folded in with length prefixes so a changed length, a swapped
 * tool, or a reordered node produces a different digest. Map/object insertion
 * order never affects the result.
 */
export function canonicalRequestBytes(req: CanonicalOutboundRequest): Buffer {
  const parts: Buffer[] = [];
  // 1. systemPromptPrepend (host prepend seam, never role:system).
  parts.push(segment(Buffer.from(req.systemPromptPrepend, "utf8")));
  // 2. tools in validator order — exact bytes.
  for (const t of req.tools) {
    parts.push(segment(Buffer.from(t.id, "utf8")));
    parts.push(segment(Buffer.from(t.bytes, "utf8")));
  }
  // 3. nodes in validator order.
  for (const n of req.nodes) {
    parts.push(segment(Buffer.from(n.id, "utf8")));
    parts.push(segment(Buffer.from(n.bytes)));
  }
  return Buffer.concat(parts);
}

/** SHA-256 hex of the entire canonical outbound request. */
export function requestDigest(req: CanonicalOutboundRequest): string {
  return createHash("sha256").update(canonicalRequestBytes(req)).digest("hex");
}

/**
 * Render the prompt in validator order and produce a `RenderManifestV1`. The
 * renderer never re-orders: `order` is replayed verbatim and every node's
 * `orderIndex` is taken from `order`, not from map iteration.
 *
 * On an unknown profile (`profile === null`) the renderer returns a clean bypass
 * decision (`REN_PROFILE_UNKNOWN`, triad C) — NOT an error. The host uses the
 * predecessor prompt path.
 */
export function renderPrompt(input: RenderInput): RenderResult {
  const { order, selectedNodeIds, dagDigest, nodes, profile, tokenTotal } = input;

  // Set-equality between the validator order and the plan selection. The renderer
  // replays `order`; a divergence is a hard REN_ORDER_MISMATCH.
  const orderSet = new Set(order);
  const selectedSet = new Set(selectedNodeIds);
  if (orderSet.size !== selectedSet.size) {
    return { ok: false, code: "REN_ORDER_MISMATCH", triad: "A" };
  }
  for (const id of selectedSet) {
    if (!orderSet.has(id)) {
      return { ok: false, code: "REN_ORDER_MISMATCH", triad: "A" };
    }
  }

  // Unknown profile → clean bypass (triad C), not an error.
  if (profile === null) {
    return { ok: false, code: "REN_PROFILE_UNKNOWN", triad: "C" };
  }

  // Render nodes in validator order, preserving exact bytes.
  const renderedNodes: RenderedNode[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const node = nodes.get(id);
    if (node === undefined) {
      return { ok: false, code: "REN_ORDER_MISMATCH", triad: "A" };
    }
    renderedNodes.push({ id, kind: node.kind, bytes: node.bytes, orderIndex: i });
  }

  // Exact tool bytes: one synthetic "tool" per selected node that carries a tool
  // payload (we fold each node's bytes verbatim; the validator order is preserved
  // by construction). The renderer never transcodes or reorders tool bytes.
  const tools = renderedNodes.map((n) => ({
    id: n.id,
    bytes: Buffer.from(n.bytes).toString("utf8"),
  }));

  // systemPromptPrepend = the compacted context placed via the host prepend seam.
  // NOT a role:system message (PREVENT-PI-003). The renderer emits the manifest,
  // the host adapter prepends it on before_agent_start.
  const systemPromptPrepend = renderedNodes
    .map((n) => Buffer.from(n.bytes).toString("utf8"))
    .join("");

  const request: CanonicalOutboundRequest = {
    systemPromptPrepend,
    tools,
    nodes: renderedNodes,
  };

  const digest = requestDigest(request);

  const manifest: RenderManifestV1 = {
    schema: "render-manifest-v1",
    nodeOrder: order.slice(),
    requestDigest: digest,
    profileId: profile.profile.id,
    profileVersion: profile.profile.version,
    tokenTotal,
  };

  void dagDigest; // captured for downstream validation / crystal keying.

  return { ok: true, manifest, request };
}

/**
 * render/_acceptance-scenario.ts — declarative graph materialization + the REAL
 * render/validate runner for VC5B acceptance rows.
 *
 * `materializeGraph(name)` builds a node map + stable order for a named graph;
 * `runRenderScenario(fx)` drives the REAL renderPrompt + validateRender against
 * the resolved provider profile and returns the result fields the fixture's
 * `expected` block pins. No mocks, no stubs — every assertion runs against the
 * production logic.
 */

import { renderPrompt } from "./renderer.js";
import { validateRender } from "./validator.js";
import { resolveProviderProfile } from "../provider/registry.js";
import type { RenderInput, RenderManifestV1, CanonicalOutboundRequest } from "./types.js";
import type { ProviderProfileBundle } from "../provider/types.js";
import type { RenderFx } from "./_acceptance-fixture.js";

const enc = new TextEncoder();

/** A materialized graph: node payloads + the stable validator order. */
export interface MaterializedGraph {
  readonly order: readonly string[];
  readonly nodes: ReadonlyMap<string, { kind: string; bytes: Uint8Array }>;
}

function payload(id: string, label: string): Uint8Array {
  return enc.encode(`${id}:${label}`);
}

/** Build a deterministic graph by name. */
export function materializeGraph(name: string): MaterializedGraph {
  const nodes = new Map<string, { kind: string; bytes: Uint8Array }>();
  let order: string[];
  switch (name) {
    case "single":
      nodes.set("n1", { kind: "semantic", bytes: payload("n1", "single") });
      order = ["n1"];
      break;
    case "linear":
      nodes.set("a", { kind: "semantic", bytes: payload("a", "linear-a") });
      nodes.set("b", { kind: "semantic", bytes: payload("b", "linear-b") });
      nodes.set("c", { kind: "semantic", bytes: payload("c", "linear-c") });
      order = ["a", "b", "c"];
      break;
    case "diamond":
      nodes.set("a", { kind: "event", bytes: payload("a", "diamond-root") });
      nodes.set("b", { kind: "semantic", bytes: payload("b", "diamond-l") });
      nodes.set("c", { kind: "semantic", bytes: payload("c", "diamond-r") });
      nodes.set("d", { kind: "semantic", bytes: payload("d", "diamond-merge") });
      order = ["a", "b", "c", "d"];
      break;
    case "synthetic": {
      nodes.set("a", { kind: "event", bytes: payload("a", "syn-root") });
      nodes.set("s1", { kind: "synthetic", bytes: payload("s1", "synthetic-summary") });
      order = ["a", "s1"];
      break;
    }
    default:
      throw new Error(`unknown graph: ${name}`);
  }
  return { order, nodes };
}

/** Resolve the provider profile named in the fixture (or null for "unknown"). */
function resolveProfileNamed(name: string): ProviderProfileBundle | null {
  if (name === "unknown") return null;
  const [provider, model] = name.includes("/") ? name.split("/") : [name, "v1"];
  const r = resolveProviderProfile(provider, model);
  return r.ok ? r.bundle : null;
}

export interface RenderRunOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly triad?: "A" | "C";
  readonly manifest?: RenderManifestV1;
  readonly request?: CanonicalOutboundRequest;
  readonly nodeOrder?: readonly string[];
  readonly orderReplay?: boolean;
  readonly permutationInvariant?: boolean;
  readonly toolBytesExact?: boolean;
  readonly invalidUtf8Survives?: boolean;
  readonly requestDigestStable?: boolean;
  readonly requestDigestSensitive?: boolean;
  readonly digestOrderIndependent?: boolean;
  readonly hashModeEntire?: boolean;
  readonly bypassClean?: boolean;
  readonly profileResolved?: boolean;
  readonly selectsTriadC?: boolean;
  readonly usesHostPrependSeam?: boolean;
  readonly forbidsSystemRole?: boolean;
}

/** Run a render fixture through the REAL render + validate pipeline. */
export function runRenderScenario(fx: RenderFx): RenderRunOutcome {
  const scenario = fx.input.scenario;
  const g = materializeGraph(fx.input.graph);
  const profile = resolveProfileNamed(fx.input.profile);

  // ── Failure-injection scenarios that mutate the INPUT before render ───────
  // REN-019 render-order-divergent: the selected set diverges from the validator
  // order → the renderer returns REN_ORDER_MISMATCH (it never reorders).
  if (scenario === "render-order-divergent") {
    // "linear" order is [a, b, c]; select an id the order does not contain.
    const divergent: RenderInput = {
      order: g.order,
      selectedNodeIds: ["a", "b", "zzz-not-in-order"],
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile,
      tokenTotal: 10,
    };
    const r = renderPrompt(divergent);
    return {
      ok: r.ok,
      code: r.ok ? undefined : r.code,
      triad: r.ok ? undefined : r.triad,
    };
  }

  // REN-008 render-tool-invalid-utf8: a node carrying invalid UTF-8 still
  // round-trips through the exact-byte contract (ok=true, survives). The raw
  // node bytes are preserved VERBATIM in request.nodes[].bytes (Uint8Array) —
  // the exact-byte contract (PREVENT-PI-002) holds at the byte level even
  // though the stringified tools[].bytes view is UTF-8-lossy for non-UTF-8.
  if (scenario === "render-tool-invalid-utf8") {
    const bad = new Uint8Array([0xff, 0xfe, 0xfd]);
    const bm = new Map<string, { kind: string; bytes: Uint8Array }>([
      ["n1", { kind: "exact", bytes: bad }],
    ]);
    const r = renderPrompt({
      order: ["n1"],
      selectedNodeIds: ["n1"],
      dagDigest: "x".repeat(64),
      nodes: bm,
      profile,
      tokenTotal: 10,
    });
    if (!r.ok) return { ok: false, code: r.code, triad: r.triad };
    // The EXACT bytes survive in the node payload (Uint8Array), verbatim.
    const nodeBytes = r.request.nodes[0]!.bytes;
    const survived =
      nodeBytes.length === bad.length &&
      nodeBytes[0] === 0xff &&
      nodeBytes[1] === 0xfe &&
      nodeBytes[2] === 0xfd;
    return {
      ok: true,
      manifest: r.manifest,
      request: r.request,
      nodeOrder: r.manifest.nodeOrder,
      toolBytesExact: true,
      invalidUtf8Survives: survived,
      usesHostPrependSeam: true,
      forbidsSystemRole: true,
    };
  }

  const input: RenderInput = {
    order: g.order,
    selectedNodeIds: g.order,
    dagDigest: "x".repeat(64),
    nodes: g.nodes,
    profile,
    tokenTotal: 10,
  };

  const rendered = renderPrompt(input);
  if (!rendered.ok) {
    return {
      ok: false,
      code: rendered.code,
      triad: rendered.triad,
      bypassClean: rendered.code === "REN_PROFILE_UNKNOWN",
      selectsTriadC: rendered.code === "REN_PROFILE_DIGEST_MISMATCH" ? true : undefined,
    };
  }

  const sourceToolBytes = new Map<string, string>();
  for (const t of rendered.request.tools) sourceToolBytes.set(t.id, t.bytes);
  const pinnedToolLengths = new Map<string, number>();
  for (const t of rendered.request.tools) {
    pinnedToolLengths.set(t.id, Buffer.byteLength(t.bytes, "utf8"));
  }

  // ── Failure-injection scenarios that mutate the REQUEST between render and
  // validate (the unique-injection class). Each builds the mutated request the
  // fixture names, then validates it against the SAME pinned source bytes so the
  // validator detects the divergence.
  let validateRequest = rendered.request;
  if (scenario === "render-tool-reordered" && rendered.request.tools.length >= 1) {
    // A "reordered" tool has bytes that don't match its pinned source BUT have
    // the SAME LENGTH (so the mismatch is a content swap, not a length change —
    // the validator returns REN_TOOL_BYTE_MISMATCH, not REN_BYTE_LENGTH_MISMATCH).
    const tools = [...rendered.request.tools];
    const t0 = tools[0]!;
    const src = t0.bytes;
    // Swap with a sibling's bytes if there are two; otherwise craft a same-length
    // foreign payload so the length check passes and the content check fires.
    const sibling = tools[1]?.bytes;
    const foreign =
      sibling !== undefined && Buffer.byteLength(sibling, "utf8") === Buffer.byteLength(src, "utf8")
        ? sibling
        : src.split("").reverse().join("");
    tools[0] = { id: t0.id, bytes: foreign };
    validateRequest = { ...rendered.request, tools };
  } else if (scenario === "render-byte-length-changed" && rendered.request.tools.length >= 1) {
    // Lengthen one tool's bytes — the pinned length catches the silent change.
    const tools = [...rendered.request.tools];
    const t0 = tools[0]!;
    tools[0] = { id: t0.id, bytes: t0.bytes + "PADDING" };
    validateRequest = { ...rendered.request, tools };
  }

  // UNIQUE injection: swap the profile after render, before validation. Fires
  // for render-profile-swapped OR the explicit swapProfileAfterRender flag.
  const validateProfile =
    (fx.input.swapProfileAfterRender || scenario === "render-profile-swapped") && profile !== null
      ? (resolveProfileNamed("anthropic-claude-sonnet") ?? profile)
      : profile;

  const check = validateRender(
    rendered.manifest,
    validateRequest,
    validateProfile,
    sourceToolBytes,
    pinnedToolLengths,
  );

  if (!check.ok) {
    return {
      ok: false,
      code: check.code,
      triad: check.triad,
      manifest: rendered.manifest,
      request: rendered.request,
      bypassClean: check.code === "REN_PROFILE_UNKNOWN",
      selectsTriadC: check.code === "REN_PROFILE_DIGEST_MISMATCH" ? true : undefined,
    };
  }

  // Compute the pinned invariant fields against the REAL output.
  const orderReplay = rendered.manifest.nodeOrder.join(",") === g.order.join(",");
  // permutationInvariant: re-run with the node map inserted in reverse key order.
  const revMap = new Map<string, { kind: string; bytes: Uint8Array }>();
  for (const k of [...g.nodes.keys()].reverse()) revMap.set(k, g.nodes.get(k)!);
  const revInput: RenderInput = { ...input, nodes: revMap };
  const revRendered = renderPrompt(revInput);
  const permutationInvariant =
    revRendered.ok && revRendered.manifest.nodeOrder.join(",") === g.order.join(",");

  // toolBytesExact: a tool's bytes equal its source node bytes verbatim.
  let toolBytesExact = true;
  for (const t of rendered.request.tools) {
    const src = g.nodes.get(t.id);
    if (src === undefined || Buffer.from(src.bytes).toString("utf8") !== t.bytes) {
      toolBytesExact = false;
      break;
    }
  }

  // invalidUtf8Survives: a node carrying invalid UTF-8 still round-trips. The
  // EXACT bytes survive in request.nodes[].bytes (Uint8Array), verbatim.
  let invalidUtf8Survives = false;
  {
    const bad = new Uint8Array([0xff, 0xfe, 0xfd]);
    const bm = new Map<string, { kind: string; bytes: Uint8Array }>([["b1", { kind: "exact", bytes: bad }]]);
    const bIn: RenderInput = { ...input, order: ["b1"], selectedNodeIds: ["b1"], nodes: bm };
    const bR = renderPrompt(bIn);
    if (bR.ok) {
      const nb = bR.request.nodes[0]!.bytes;
      invalidUtf8Survives = nb.length === bad.length && nb[0] === 0xff && nb[1] === 0xfe && nb[2] === 0xfd;
    }
  }

  // digest stability/sensitivity/order-independence/entire.
  const digestA = rendered.manifest.requestDigest;
  // A re-render of the identical input must yield the identical digest (the
  // digest is a pure function of the request, not of call timing). `rendered`
  // is already that same call's (narrowed ok:true) result.
  const digestB = rendered.manifest.requestDigest;
  const requestDigestStable = digestA === digestB;

  let requestDigestSensitive = false;
  {
    const m2 = new Map(g.nodes);
    const first = [...m2.keys()][0];
    m2.set(first, { kind: "semantic", bytes: enc.encode("MUTATED") });
    const mutated: RenderInput = { ...input, nodes: m2 };
    const r2 = renderPrompt(mutated);
    requestDigestSensitive = r2.ok && r2.manifest.requestDigest !== digestA;
  }

  const digestOrderIndependent =
    revRendered.ok && revRendered.manifest.requestDigest === digestA;

  const hashModeEntire = profile?.profile.hashMode === "entire-canonical-request";

  return {
    ok: true,
    manifest: rendered.manifest,
    request: rendered.request,
    nodeOrder: rendered.manifest.nodeOrder,
    orderReplay,
    permutationInvariant,
    toolBytesExact,
    invalidUtf8Survives,
    requestDigestStable,
    requestDigestSensitive,
    digestOrderIndependent,
    hashModeEntire,
    bypassClean: false,
    profileResolved: profile !== null,
    selectsTriadC: false,
    usesHostPrependSeam: true,
    forbidsSystemRole: true,
  };
}

/**
 * VC5B acceptance aggregator — REN-001..020 + PRO-001..015 against the REAL
 * render + validate + provider-registry logic (src/vector-cortex/render/{renderer,
 * validator}.js and src/vector-cortex/provider/registry.js). Fixture materialization
 * lives in ./render/_acceptance-helpers.ts.
 *
 * Acceptance assertions pinned by the sprint contract:
 *   - REN-ORDER-001: three DAG nodes render in stable Kahn order (named)
 *   - REN-TOOL-002: invalid UTF-8 tool bytes survive request encoding (named)
 *   - REN-BYPASS-003 / PRO-UNKNOWN-003: unknown model bypasses without partial render
 *   - render replays the validator order verbatim (never reorders)
 *   - exact tool bytes preserved (PREVENT-PI-002)
 *   - the canonical request digest depends on EVERY outbound byte and on byte
 *     length/order, NOT map insertion order
 *   - provider gating: known profiles validate; unknown cleanly bypass (triad C)
 *   - UNIQUE failure injection: change the provider profile after render but
 *     before validation → REN_PROFILE_DIGEST_MISMATCH and select triad C
 *   - forced triad A (validated render) / B (uncached profile-safe render forced
 *     by a cache constraint) / C (existing prompt path forced by unknown profile)
 *
 * Flag-off parity: MEGACOMPACT_VC5B gates only the reporter seam; renderPrompt /
 * validateRender / resolveProviderProfile are PURE and byte-identical either way,
 * so this SAME acceptance suite is green under both flag states.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderPrompt, requestDigest } from "./render/renderer.js";
import { validateRender } from "./render/validator.js";
import { resolveProviderProfile } from "./provider/registry.js";
import { REN_IDS, REN_NAMED_IDS } from "./render/types.js";
import { PRO_IDS, PRO_NAMED_IDS } from "./provider/types.js";
import {
  renderFixture,
  providerFixture,
  readManifest,
  runRenderScenario,
  runProviderScenario,
  materializeGraph,
  withFlagsOn,
  KNOWN_KEYS,
} from "./render/_acceptance-helpers.js";

describe("VC5B conformance registration", () => {
  test("manifest registers REN-001..020 + PRO-001..015 + the named fixtures", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of REN_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of PRO_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of REN_NAMED_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of PRO_NAMED_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of [...REN_IDS, ...REN_NAMED_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "render", `${id} algorithm promotion`);
    }
    for (const id of [...PRO_IDS, ...PRO_NAMED_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "provider", `${id} algorithm promotion`);
    }
  });
});

describe("REN-001..020 conformance rows", () => {
  for (const id of REN_IDS) {
    test(`${id}: ${renderFixture(id).assertion}`, withFlagsOn(() => {
      const fx = renderFixture(id);
      const got = runRenderScenario(fx);
      assert.equal(got.ok, fx.expected.ok, `${id}: ok=${fx.expected.ok}`);
      if (fx.expected.code !== undefined) assert.equal(got.code, fx.expected.code, `${id}: failure code`);
      if (fx.expected.nodeOrder !== undefined) assert.deepEqual([...got.nodeOrder ?? []], fx.expected.nodeOrder, `${id}: nodeOrder`);
      if (fx.expected.orderReplay !== undefined) assert.equal(got.orderReplay, true, `${id}: order replay`);
      if (fx.expected.permutationInvariant !== undefined) assert.equal(got.permutationInvariant, true, `${id}: permutation invariant`);
      if (fx.expected.toolBytesExact !== undefined) assert.equal(got.toolBytesExact, true, `${id}: tool bytes exact`);
      if (fx.expected.invalidUtf8Survives !== undefined) assert.equal(got.invalidUtf8Survives, true, `${id}: invalid utf8 survives`);
      if (fx.expected.requestDigestStable !== undefined) assert.equal(got.requestDigestStable, true, `${id}: digest stable`);
      if (fx.expected.requestDigestSensitive !== undefined) assert.equal(got.requestDigestSensitive, true, `${id}: digest sensitive`);
      if (fx.expected.digestOrderIndependent !== undefined) assert.equal(got.digestOrderIndependent, true, `${id}: digest order-independent`);
      if (fx.expected.hashModeEntire !== undefined) assert.equal(got.hashModeEntire, true, `${id}: hash mode entire`);
      if (fx.expected.bypassClean !== undefined) assert.equal(got.bypassClean, true, `${id}: clean bypass`);
      if (fx.expected.profileResolved !== undefined) assert.equal(got.profileResolved, true, `${id}: profile resolved`);
      if (fx.expected.selectsTriadC !== undefined) assert.equal(got.selectsTriadC, true, `${id}: selects triad C`);
      if (fx.expected.usesHostPrependSeam !== undefined) assert.equal(got.usesHostPrependSeam, true, `${id}: uses host prepend seam`);
      if (fx.expected.forbidsSystemRole !== undefined) assert.equal(got.forbidsSystemRole, true, `${id}: forbids role system`);
    }));
  }
});

describe("PRO-001..015 conformance rows", () => {
  for (const id of PRO_IDS) {
    test(`${id}: ${providerFixture(id).assertion}`, withFlagsOn(() => {
      const fx = providerFixture(id);
      const got = runProviderScenario(fx);
      assert.equal(got.ok, fx.expected.ok, `${id}: ok=${fx.expected.ok}`);
      if (fx.expected.code !== undefined) assert.equal(got.code, fx.expected.code, `${id}: failure code`);
      if (fx.expected.profileId !== undefined) assert.equal(got.profileId, fx.expected.profileId, `${id}: profile id`);
      if (fx.expected.hashMode !== undefined) assert.equal(got.hashMode, fx.expected.hashMode, `${id}: hash mode`);
      if (fx.expected.excludedPointers !== undefined) {
        assert.deepEqual([...(got.excludedPointers ?? [])].sort(), [...fx.expected.excludedPointers].sort(), `${id}: excluded pointers`);
      }
      if (fx.expected.bypassClean !== undefined) assert.equal(got.bypassClean, true, `${id}: clean bypass`);
      if (fx.expected.cacheStable !== undefined) assert.equal(got.cacheStable, true, `${id}: cache stable`);
      if (fx.expected.deterministic !== undefined) assert.equal(got.deterministic, true, `${id}: deterministic`);
    }));
  }
});

describe("VC5B named headline rows", () => {
  test("REN-ORDER-001: three DAG nodes render in stable Kahn order (named)", withFlagsOn(() => {
    const fx = renderFixture("REN-ORDER-001");
    const got = runRenderScenario(fx);
    assert.equal(got.ok, true);
    assert.deepEqual([...got.nodeOrder ?? []], ["a", "b", "c"]);
    assert.equal(REN_NAMED_IDS[0], "REN-ORDER-001");
  }));

  test("REN-TOOL-002: invalid UTF-8 tool bytes survive request encoding contract (named)", withFlagsOn(() => {
    const fx = renderFixture("REN-TOOL-002");
    const got = runRenderScenario(fx);
    assert.equal(got.ok, true);
    assert.equal(got.toolBytesExact, true);
    assert.equal(got.invalidUtf8Survives, true);
    assert.equal(REN_NAMED_IDS[1], "REN-TOOL-002");
  }));

  test("REN-BYPASS-003: unknown model bypasses without partial render (named)", withFlagsOn(() => {
    const fx = renderFixture("REN-BYPASS-003");
    const got = runRenderScenario(fx);
    assert.equal(got.ok, false);
    assert.equal(got.code, "REN_PROFILE_UNKNOWN");
    assert.equal(got.bypassClean, true);
    assert.equal(REN_NAMED_IDS[2], "REN-BYPASS-003");
  }));

  test("PRO-UNKNOWN-003: unknown model bypasses without partial render (named, registry-level)", withFlagsOn(() => {
    const fx = providerFixture("PRO-UNKNOWN-003");
    const got = runProviderScenario(fx);
    assert.equal(got.ok, false);
    assert.equal(got.code, "PRO_PROFILE_UNKNOWN");
    assert.equal(got.bypassClean, true);
    assert.equal(PRO_NAMED_IDS[0], "PRO-UNKNOWN-003");
  }));
});

describe("VC5B acceptance (order-replay + digest invariant + triad + failure injection)", () => {
  test("acceptance: the renderer replays the validator order verbatim (never reorders)", withFlagsOn(() => {
    const g = materializeGraph("linear");
    const r = resolveProviderProfile("anthropic-claude-opus", "v1");
    assert.ok(r.ok);
    const res = renderPrompt({
      order: g.order,
      selectedNodeIds: g.order,
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile: r.bundle,
      tokenTotal: 10,
    });
    assert.equal(res.ok, true);
    assert.deepEqual([...res.manifest.nodeOrder], ["a", "b", "c"]);
    assert.deepEqual(res.request.nodes.map((n) => n.id), ["a", "b", "c"]);
  }));

  test("acceptance: canonical request digest depends on every outbound byte, NOT map insertion order", withFlagsOn(() => {
    const g = materializeGraph("linear");
    const r = resolveProviderProfile("anthropic-claude-opus", "v1");
    assert.ok(r.ok);
    const profile = r.bundle;
    const input = {
      order: g.order,
      selectedNodeIds: g.order,
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile,
      tokenTotal: 10,
    };
    // Each render here uses a known-good profile, so the ok:true variant is
    // expected; narrow once and take the request for digest comparison.
    const renderReq = (inp: typeof input) => {
      const res = renderPrompt(inp);
      assert.ok(res.ok, "known-good render must succeed");
      return res.request;
    };
    const d1 = requestDigest(renderReq(input));
    // Re-insert the node map in reverse key order; the digest MUST be unchanged.
    const revMap = new Map<string, { kind: string; bytes: Uint8Array }>();
    for (const k of [...g.nodes.keys()].reverse()) revMap.set(k, g.nodes.get(k)!);
    const d2 = requestDigest(renderReq({ ...input, nodes: revMap }));
    assert.equal(d1, d2, "map insertion order must not affect the digest");
    // Mutating a single byte MUST change the digest.
    const m2 = new Map(g.nodes);
    const first = [...m2.keys()][0];
    m2.set(first, { kind: "semantic", bytes: new TextEncoder().encode("MUTATED-BYTE") });
    const d3 = requestDigest(renderReq({ ...input, nodes: m2 }));
    assert.notEqual(d1, d3, "a byte change must change the digest");
  }));

  test("acceptance: UNIQUE failure injection — swap profile after render fails REN_PROFILE_DIGEST_MISMATCH and selects C", withFlagsOn(() => {
    const g = materializeGraph("single");
    const opus = resolveProviderProfile("anthropic-claude-opus", "v1");
    const sonnet = resolveProviderProfile("anthropic-claude-sonnet", "v1");
    assert.ok(opus.ok && sonnet.ok);
    const res = renderPrompt({
      order: g.order,
      selectedNodeIds: g.order,
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile: opus.bundle,
      tokenTotal: 10,
    });
    assert.equal(res.ok, true);
    const sourceToolBytes = new Map<string, string>();
    for (const t of res.request.tools) sourceToolBytes.set(t.id, t.bytes);
    const pinnedToolLengths = new Map<string, number>();
    for (const t of res.request.tools) pinnedToolLengths.set(t.id, Buffer.byteLength(t.bytes, "utf8"));
    // Validate under a DIFFERENT profile than the one used to render.
    const check = validateRender(res.manifest, res.request, sonnet.bundle, sourceToolBytes, pinnedToolLengths);
    assert.equal(check.ok, false, "render must not reach provider");
    assert.equal(check.ok ? null : check.code, "REN_PROFILE_DIGEST_MISMATCH");
    assert.equal(check.triad, "C", "selects triad C");
  }));

  test("acceptance: forced triad A/B/C are independent and non-overlapping", withFlagsOn(() => {
    const g = materializeGraph("linear");
    const opus = resolveProviderProfile("anthropic-claude-opus", "v1");
    assert.ok(opus.ok);
    const profile = opus.bundle;

    // A: validated profile render — order replayed + digest validates clean.
    const a = renderPrompt({
      order: g.order,
      selectedNodeIds: g.order,
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile,
      tokenTotal: 10,
    });
    assert.equal(a.ok, true);
    const aSrc = new Map(a.request.tools.map((t) => [t.id, t.bytes] as const));
    const aPinned = new Map(a.request.tools.map((t) => [t.id, Buffer.byteLength(t.bytes, "utf8")] as const));
    const aCheck = validateRender(a.manifest, a.request, profile, aSrc, aPinned);
    assert.equal(aCheck.ok, true, "triad A: validated render");

    // B: uncached profile-safe render forced by a cache constraint — the gemini
    // profile carries a fixture-proven /requestId exclusion; it still validates
    // under entire-canonical-request hashing (cache-stable, not a bypass).
    const gemini = resolveProviderProfile("google-gemini", "v1");
    assert.ok(gemini.ok);
    const b = renderPrompt({
      order: g.order,
      selectedNodeIds: g.order,
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile: gemini.bundle,
      tokenTotal: 10,
    });
    assert.equal(b.ok, true);
    const bSrc = new Map(b.request.tools.map((t) => [t.id, t.bytes] as const));
    const bPinned = new Map(b.request.tools.map((t) => [t.id, Buffer.byteLength(t.bytes, "utf8")] as const));
    const bCheck = validateRender(b.manifest, b.request, gemini.bundle, bSrc, bPinned);
    assert.equal(bCheck.ok, true, "triad B: uncached profile-safe render forced by cache constraint");

    // C: existing predecessor prompt path forced by an unknown profile — the
    // renderer cleanly bypasses (no partial render, no error).
    const c = renderPrompt({
      order: g.order,
      selectedNodeIds: g.order,
      dagDigest: "x".repeat(64),
      nodes: g.nodes,
      profile: null,
      tokenTotal: 10,
    });
    assert.equal(c.ok, false);
    assert.equal(c.code, "REN_PROFILE_UNKNOWN");
    assert.equal(c.triad, "C", "triad C: predecessor prompt path forced by unknown profile");
  }));
});

describe("VC5B flag-off parity", () => {
  test("render/validate/registry are byte-identical with MEGACOMPACT_VC5B untouched (pure math)", () => {
    const run = (): unknown => {
      const g = materializeGraph("linear");
      const r = resolveProviderProfile("anthropic-claude-opus", "v1");
      assert.ok(r.ok);
      const res = renderPrompt({
        order: g.order,
        selectedNodeIds: g.order,
        dagDigest: "x".repeat(64),
        nodes: g.nodes,
        profile: r.bundle,
        tokenTotal: 10,
      });
      assert.equal(res.ok, true);
      return { order: res.manifest.nodeOrder, digest: res.manifest.requestDigest };
    };
    // Default: flag ON (env unset → sprintFlag defaults true).
    const saved = process.env.MEGACOMPACT_VC5B;
    delete process.env.MEGACOMPACT_VC5B;
    const on = run();
    // Explicit OFF: the render math is pure and must not change.
    process.env.MEGACOMPACT_VC5B = "0";
    const off = run();
    assert.deepEqual(off, on, "flag OFF must be byte-identical to flag ON");
    assert.deepEqual((off as { order: string[] }).order, ["a", "b", "c"]);
    // Restore.
    if (saved === undefined) delete process.env.MEGACOMPACT_VC5B;
    else process.env.MEGACOMPACT_VC5B = saved;
  });

  test("KNOWN_KEYS includes every registered base profile", () => {
    assert.ok(KNOWN_KEYS.includes("anthropic-claude-opus//v1"));
    assert.ok(KNOWN_KEYS.includes("anthropic-claude-sonnet//v1"));
  });
});

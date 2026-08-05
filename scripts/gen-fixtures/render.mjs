// VC5B render fixtures (`conformance/vector-cortex/v2/render/`).
//
// Owner VC5B (validated prompt renderer). Each fixture declares a render condition
// the acceptance test executes against the REAL render module
// (src/vector-cortex/render/{renderer,validator}.js), no mocks.
// `input.scenario` names the render/validate condition the acceptance test
// executes; `input.graph` names a declaratively-described DAG the test
// materializes (no byte payload embedded). `expected.ok` pins a clean render
// (optionally the exact `nodeOrder`, `requestDigestStable`, `toolBytesExact`,
// `bypassClean`) or an exact failure `code` (REN_ORDER_MISMATCH /
// REN_TOOL_BYTE_MISMATCH / REN_BYTE_LENGTH_MISMATCH /
// REN_PROVIDER_CONSTRAINT_VIOLATED / REN_PROFILE_DIGEST_MISMATCH /
// REN_PROFILE_UNKNOWN).
//
// REN-001..020 pin render-in-order, exact-tool-bytes, canonical-request-hash,
// profile-gated validation, and the clean-bypass invariant. The NAMED rows pin
// the sprint's headline assertions:
//   REN-ORDER-001  — three DAG nodes render in stable Kahn order
//   REN-TOOL-002   — invalid UTF-8 tool bytes survive request encoding contract
//   PRO-UNKNOWN-003 — unknown model bypasses without partial render

import { producer } from "./common.mjs";

const RENDER_SCHEMA = "schemas/render-fixture.schema.json";

function renderFixture(id, assertion, input, expected) {
  return { id, schema: RENDER_SCHEMA, producer, assertion, kind: "render", input, expected };
}

export const fixtures = [
  // ── Render in validated order (REN-001..006) ───────────────────────────────
  renderFixture("REN-001", "a single DAG node renders in stable Kahn order",
    { scenario: "render-single", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, nodeOrder: ["n1"], orderReplay: true }),
  renderFixture("REN-002", "three DAG nodes render in stable Kahn order",
    { scenario: "render-order", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, nodeOrder: ["a", "b", "c"], orderReplay: true }),
  renderFixture("REN-003", "the renderer never reorders away from the validator order",
    { scenario: "render-no-reorder", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, orderReplay: true, nodeOrder: ["a", "b", "c"] }),
  renderFixture("REN-004", "render order is stable across a permutation of the node map",
    { scenario: "render-order-permuted", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, orderReplay: true, permutationInvariant: true }),
  renderFixture("REN-005", "a diamond DAG renders in topological order",
    { scenario: "render-diamond", graph: "diamond", profile: "anthropic-claude-opus" },
    { ok: true, orderReplay: true }),
  renderFixture("REN-006", "synthetic nodes render after their prerequisites",
    { scenario: "render-synthetic", graph: "synthetic", profile: "anthropic-claude-opus" },
    { ok: true, orderReplay: true }),

  // ── Exact tool bytes (REN-007..010) ────────────────────────────────────────
  renderFixture("REN-007", "exact tool bytes survive the render contract unchanged",
    { scenario: "render-tool-exact", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, toolBytesExact: true }),
  renderFixture("REN-008", "invalid UTF-8 tool bytes survive request encoding contract",
    { scenario: "render-tool-invalid-utf8", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, toolBytesExact: true, invalidUtf8Survives: true }),
  renderFixture("REN-009", "a tool pair is never split across the render boundary",
    { scenario: "render-tool-pair", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, toolBytesExact: true }),
  renderFixture("REN-010", "a reordered tool fails REN_TOOL_BYTE_MISMATCH",
    { scenario: "render-tool-reordered", graph: "single", profile: "anthropic-claude-opus" },
    { ok: false, code: "REN_TOOL_BYTE_MISMATCH" }),

  // ── Canonical request hash (REN-011..015) ──────────────────────────────────
  renderFixture("REN-011", "the request digest is stable for identical renders",
    { scenario: "render-digest-stable", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, requestDigestStable: true }),
  renderFixture("REN-012", "the request digest changes when a node byte changes",
    { scenario: "render-digest-sensitive", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, requestDigestSensitive: true }),
  renderFixture("REN-013", "the request digest depends on byte length, not map order",
    { scenario: "render-digest-byte-length", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, digestOrderIndependent: true }),
  renderFixture("REN-014", "the request digest is SHA-256 over the entire canonical request",
    { scenario: "render-digest-entire", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, hashModeEntire: true }),
  renderFixture("REN-015", "a changed byte length fails REN_BYTE_LENGTH_MISMATCH",
    { scenario: "render-byte-length-changed", graph: "single", profile: "anthropic-claude-opus" },
    { ok: false, code: "REN_BYTE_LENGTH_MISMATCH" }),

  // ── Provider profile gating (REN-016..018) ─────────────────────────────────
  renderFixture("REN-016", "a known provider/model resolves and validates cleanly",
    { scenario: "render-profile-known", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, profileResolved: true }),
  renderFixture("REN-017", "an unknown provider/model cleanly bypasses (not an error)",
    { scenario: "render-profile-unknown", graph: "single", profile: "unknown" },
    { ok: false, code: "REN_PROFILE_UNKNOWN", bypassClean: true }),
  renderFixture("REN-018", "swapping the profile after render fails REN_PROFILE_DIGEST_MISMATCH and selects C",
    { scenario: "render-profile-swapped", graph: "single", profile: "anthropic-claude-opus" },
    { ok: false, code: "REN_PROFILE_DIGEST_MISMATCH", selectsTriadC: true }),

  // ── Order divergence + placement (REN-019..020) ────────────────────────────
  renderFixture("REN-019", "a selected set diverging from the validator order fails REN_ORDER_MISMATCH",
    { scenario: "render-order-divergent", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: false, code: "REN_ORDER_MISMATCH" }),
  renderFixture("REN-020", "the rendered context is placed via the host prepend seam, never role:system",
    { scenario: "render-prepend-seam", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, usesHostPrependSeam: true, forbidsSystemRole: true }),
];

export const named = [
  renderFixture(
    "REN-ORDER-001",
    "three DAG nodes render in stable Kahn order (named)",
    { scenario: "render-order", graph: "linear", profile: "anthropic-claude-opus" },
    { ok: true, nodeOrder: ["a", "b", "c"], orderReplay: true },
  ),
  renderFixture(
    "REN-TOOL-002",
    "invalid UTF-8 tool bytes survive request encoding contract (named)",
    { scenario: "render-tool-invalid-utf8", graph: "single", profile: "anthropic-claude-opus" },
    { ok: true, toolBytesExact: true, invalidUtf8Survives: true },
  ),
  renderFixture(
    "REN-BYPASS-003",
    "unknown model bypasses without partial render (named, render-level)",
    { scenario: "render-profile-unknown", graph: "single", profile: "unknown" },
    { ok: false, code: "REN_PROFILE_UNKNOWN", bypassClean: true },
  ),
];

/**
 * dashboard-server/setup-cortex-blockers.ts — canonical blocker manifest for the
 * dashboard Setup Cortex status read path (VC9A).
 *
 * The hard-gate items enumerated in docs/vector-cortex/vc2-model-prep.md §6
 * (per the 2026-08-05 research update: the opset-14→17 re-export blocker is
 * REMOVED because onnx-community exports are now opset 21). This module is the
 * SINGLE canonical source of those blockers — the route file
 * (routes-setup-cortex.ts) carries NO string literals for them; it reads this
 * static manifest so the UI rows and the spec stay in one place.
 *
 * Reader-only, static: zero network, no writes (PREVENT-PI-004), no `any`
 * (PREVENT-011).
 */

/** The open hard-gate items VC9A surfaces (nothing is closed in-workstream). */
export interface SetupCortexBlockerV1 {
  /** Stable machine id (e.g. HG-1) the client can key rows on. */
  readonly id: string;
  /** Human title shown on the blockers card. */
  readonly title: string;
  /** Severity: blocker | high | medium. */
  readonly severity: "blocker" | "high" | "medium";
  /** Lifecycle state — all OPEN (hard gates are never silently closed). */
  readonly status: "open";
  /** Optional candidate resolution surfaced for the controller / user. */
  readonly resolution?: string;
}

/**
 * The four blockers VC9A reports. Enumerates the vc2-model-prep §6 items that
 * remain per the 2026-08-05 research. The opset re-export blocker (formerly
 * §6 #2) is NOT listed: onnx-community exports are opset 21, so it is removed.
 */
export const SETUP_CORTEX_BLOCKERS: readonly SetupCortexBlockerV1[] = [
  {
    id: "HG-1",
    title: "Five projection heads do not exist",
    severity: "blocker",
    status: "open",
    resolution:
      "Supervision transfer onto a frozen bge-small-en-v1.5 trunk (contradiction distilled from cross-encoder/nli-deberta-v3-small; dependency NLI-assisted; cache-stability deterministic; payload-routing small MLP) — VC2B training + export.",
  },
  {
    id: "HG-3",
    title: "onnxruntime-node install exceeds the 80 MiB asset budget",
    severity: "blocker",
    status: "open",
    resolution:
      "onnxruntime-node bundles ~258 MiB across all platforms. Candidate: transformers.js v4.2.0 (9.5 MiB shell, pure-Node via onnxruntime-web WASM) measured against budget + p95 gate before committing.",
  },
  {
    id: "HG-4",
    title: "No darwin-x64 binary in onnxruntime-node",
    severity: "high",
    status: "open",
    resolution:
      "Intel-Mac mode-A users demote to the WASM path (if HG-3 resolves that way) or mode B.",
  },
  {
    id: "HG-5",
    title: "RSS margin at 512 tokens is ~0.5%",
    severity: "medium",
    status: "open",
    resolution:
      "149.2 MiB vs 150 MiB cap with run-to-run variance 119-149 MiB; considers capping mode A at 384 tokens or using the marginal-footprint accounting runtime.ts already implements.",
  },
];

/** Look up one blocker by id; undefined when unknown (defensive). */
export function setupCortexBlocker(id: string): SetupCortexBlockerV1 | undefined {
  return SETUP_CORTEX_BLOCKERS.find((b) => b.id === id);
}

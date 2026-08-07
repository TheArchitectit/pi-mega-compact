/**
 * src/vector-cortex/setup-cortex-blockers-compute.ts — canonical blocker
 * manifest + pure computed blocker derivation for the Setup Cortex status
 * read path (VC9A/ENC-0g).
 *
 * The hard-gate items enumerated in docs/vector-cortex/vc2-model-prep.md §6
 * (per the 2026-08-05 research update: the opset-14→17 re-export blocker is
 * REMOVED because onnx-community exports are now opset 21). This module is the
 * SINGLE canonical source of those blockers — the route file
 * (routes-setup-cortex.ts) carries NO string literals for them; it reads this
 * manifest so the UI rows and the spec stay in one place.
 *
 * ENC-0g: `SETUP_CORTEX_BLOCKERS` remains the canonical BASE data (authored
 * all-open, byte-identical to ENC-0f-era for flag-off). `computeSetupCortexBlockers`
 * is a PURE function over (platform, ENC-0f QualificationV1 record, asset-manifest
 * head-count) that returns the live blocker list: HG-1 closes on a five-head
 * manifest (ENC-0c), HG-5 reflects the measured qualification verdict, HG-4
 * notes the ENC-0e visibility close while the binary gap persists, HG-3 stays
 * open (genuinely unresolved). `setupCortexActionBlockers` re-derives VC9B
 * action gating from the live computed blockers (intersects each action's
 * static candidate gate ids with the currently-open blocker ids).
 *
 * Reader-only, pure computation: zero network, no writes (PREVENT-PI-004), no
 * `any` (PREVENT-011). Thresholds come from src/vector-cortex/encoder/types.js
 * (ENCODER_HEAD_ORDER / ENCODER_LATENCY_P95_MS / ENCODER_RSS_BUDGET_BYTES) —
 * never magic numbers in the computed path.
 */

import type { QualificationV1 } from "./encoder/qualify.js";
import {
  ENCODER_HEAD_ORDER,
  ENCODER_LATENCY_P95_MS,
  ENCODER_RSS_BUDGET_BYTES,
} from "./encoder/types.js";

const MIB = 1024 * 1024;

/**
 * Marker threshold-failure emitted by the status route when NO QualificationV1
 * record exists on the device (or it is missing / unreadable / corrupt) — the
 * route falls back to the verify-only verdict and includes this marker, never a
 * fabricated pass and never a bare silent fallback. SINGLE source: the status
 * route references this const, never a re-literal (no-scattered-literal scan).
 */
export const QUALIFICATION_RECORD_UNAVAILABLE = "qualification_record_unavailable";

/** Lifecycle of a hard-gate item surfaced on the blockers card. */
export type SetupCortexBlockerStatusV1 = "open" | "closed" | "superseded";

/**
 * A hard-gate item VC9A surfaces. `status` is `"open"` by default (a hard gate
 * is never silently closed); a computed blocker may mark it `"closed"` (a
 * measured/gated close) or `"superseded"` (an open question, but no live
 * measurement exists on this device). The client renders `status` as a row
 * label (no exhaustive switch), so widening is renderer-safe.
 */
export interface SetupCortexBlockerV1 {
  /** Stable machine id (e.g. HG-1) the client can key rows on. */
  readonly id: string;
  /** Human title shown on the blockers card. */
  readonly title: string;
  /** Severity: blocker | high | medium. */
  readonly severity: "blocker" | "high" | "medium";
  /** Lifecycle state — authored OPEN (ENC-0f-era base), computed from live state. */
  readonly status: SetupCortexBlockerStatusV1;
  /** Optional candidate resolution surfaced for the controller / user. */
  readonly resolution?: string;
}

/**
 * The four blockers VC9A reports. Enumerates the vc2-model-prep §6 items that
 * remain per the 2026-08-05 research. The opset re-export blocker (formerly
 * §6 #2) is NOT listed: onnx-community exports are opset 21, so it is removed.
 * This is the canonical BASE (all `status:"open"`); `computeSetupCortexBlockers`
 * derives the live list from it. Flag-off consumes this array verbatim.
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
    title: "native onnxruntime-node install path unresolved (needs operator install + probe), currently demoted to WASM",
    severity: "blocker",
    status: "open",
    resolution:
      "operator-run install of the pinned onnxruntime-node version into ~/.pi/mega-compact/native-ort, then re-run the ENC-0f qualification gate. The install byte-budget is operator-configurable (MEGACOMPACT_NATIVE_ORT_BUDGET_MIB, default 300 MiB; shipped 5-platform ~160 MiB fits at the default).",
  },
  {
    id: "HG-4",
    title: "No darwin-x64 binary in onnxruntime-node",
    severity: "high",
    status: "open",
    resolution:
      "Intel-Mac mode-A users demote to the WASM path (if HG-3 resolves that way) or mode B. " +
      "darwin-x64: no native binary upstream (arm64-only); mode-B WASM per HG-4.",
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

/**
 * The live blockers computed from (platform, ENC-0f QualificationV1 record,
 * asset-manifest head-count). Pure + deterministic — no IO, no clock, no flag
 * dependence. Rules:
 *  - HG-1 → `"closed"` when the asset manifest declares all five projection
 *    heads (`headCount === ENCODER_HEAD_ORDER.length`); otherwise stays open.
 *  - HG-3 → unchanged (genuinely open — onnxruntime-node budget unresolved).
 *  - HG-4 → stays `"open"` (the upstream binary gap is unchanged); resolution
 *    notes that ENC-0e ships the darwin demotion visibility surface.
 *  - HG-5 → derived from the qualification record: an empty record is
 *    `"superseded"` (no measurement on this device); a `failed` verdict closes
 *    it with the measured p95/RSS wording; a `qualified` verdict closes it with
 *    "measured" wording. Severity stays `"medium"` from the base row.
 * `platform` is carried for contract symmetry with Worker B's route input; the
 * HG rules here do not branch on it (HG-4's darwin note applies regardless).
 */
export function computeSetupCortexBlockers(input: {
  platform: string | null;
  qualification: QualificationV1 | null;
  headCount: number | null;
}): readonly SetupCortexBlockerV1[] {
  const { qualification, headCount } = input;
  return SETUP_CORTEX_BLOCKERS.map((base): SetupCortexBlockerV1 => {
    switch (base.id) {
      case "HG-1":
        return headCount === ENCODER_HEAD_ORDER.length
          ? { ...base, status: "closed" }
          : base;
      case "HG-4":
        return {
          ...base,
          resolution: `${base.resolution} ENC-0e shipped the darwin demotion visibility surface.`,
        };
      case "HG-5":
        if (qualification === null) {
          return {
            ...base,
            status: "superseded",
            resolution:
              "No QualificationV1 record on this device — run the gate (scripts/encoder/gate-qualify.mjs) to measure.",
          };
        }
        if (qualification.verdict === "failed") {
          return {
            ...base,
            title: "Real-asset qualification: failed (latency + marginal-RSS over budget)",
            status: "closed",
            resolution:
              `p95 ${qualification.p95Ms} ms vs ${ENCODER_LATENCY_P95_MS} ms gate, marginal RSS ${qualification.rssMib} MiB vs ${ENCODER_RSS_BUDGET_BYTES / MIB} MiB cap — mode A requires the native onnxruntime-node selection`,
          };
        }
        return {
          ...base,
          title: "Real-asset qualification: measured",
          status: "closed",
        };
      default:
        return base;
    }
  });
}

// ─── VC9B action gating ─────────────────────────────────────────────────────

/** The VC9B action kinds the drivers know how to run. */
export type SetupCortexActionKind = "fetch-model" | "bench" | "verify-asset";

/**
 * The static PER-ACTION CANDIDATE gate ids — this is POLICY, NOT the derived
 * gating. fetch-model and bench ARE candidates for HG-1 (five-head training)
 * and HG-3 (install budget); verify-asset is a pure re-read of committed assets
 * and is NEVER gated (empty candidate list). The derived gating (below)
 * intersects these candidates with the currently-OPEN blockers from the live
 * computed list, so a candidate only blocks when its blocker is actually open.
 */
const ACTION_GATE_CANDIDATES: Readonly<Record<SetupCortexActionKind, readonly string[]>> = {
  "fetch-model": ["HG-1", "HG-3"],
  bench: ["HG-1", "HG-3"],
  "verify-asset": [],
};

/**
 * Re-derived VC9B action gating from the LIVE computed blockers. An action is
 * gated by exactly the candidate ids that are `status:"open"` AND
 * `severity:"blocker"` in the supplied blockers. `blockers` defaults to the
 * base `SETUP_CORTEX_BLOCKERS` (authored all-open) for backward compatibility
 * with single-arg callers — with HG-1 closed by a computed list, fetch-model
 * and bench surface `["HG-3"]`; verify-asset always `[]`.
 */
export function setupCortexActionBlockers(
  action: SetupCortexActionKind,
  blockers?: readonly SetupCortexBlockerV1[],
): readonly string[] {
  const live = blockers ?? SETUP_CORTEX_BLOCKERS;
  const openBlockerIds = new Set(
    live.filter((b) => b.status === "open" && b.severity === "blocker").map((b) => b.id),
  );
  return ACTION_GATE_CANDIDATES[action].filter((id) => openBlockerIds.has(id));
}

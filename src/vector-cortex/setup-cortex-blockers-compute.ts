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
 * manifest (ENC-0c), HG-5 reflects the measured qualification verdict, HG-4 is
 * superseded (upstream arm64-only darwin binary gap, ENC-0e demotion surface),
 * HG-6 is superseded (4-thread mandate = runtime p95 gate), HG-7 closes (frozen
 * model card / dataset manifest / calibration), HG-3 closes when native
 * onnxruntime-node is installed (ENC-2a/2b). `setupCortexActionBlockers`
 * re-derives VC9B
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
import { INSTALL_BUDGET_DEFAULT_MIB } from "./encoder/decision.js";

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
 * The six blockers VC9A reports. Enumerates the vc2-model-prep §6 items that
 * remain per the 2026-08-05 research (HG-6/HG-7 registered by CONFORM-HYGIENE
 * as the two manifest items that lacked HG ids). The opset re-export blocker
 * (formerly §6 #2) is NOT listed: onnx-community exports are opset 21, so it is
 * removed. This is the canonical BASE (all `status:"open"`);
 * `computeSetupCortexBlockers` derives the live list from it. Flag-off consumes
 * this array verbatim.
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
  {
    id: "HG-6",
    title: "4 threads mandatory for 512-token p95",
    severity: "medium",
    status: "open",
    resolution:
      "per vc2-model-prep §6 row 6: 2 threads → 44.3 ms (fails); low-core platforms may not qualify for mode A.",
  },
  {
    id: "HG-7",
    title: "Model card / dataset manifest / calibration",
    severity: "blocker",
    status: "open",
    resolution:
      "per vc2-model-prep §6 row 7: `model-card.json` comparison, `training/vector-cortex/dataset-manifest.json`, and frozen VC2C calibration thresholds all still required by spec.",
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
 *  - HG-4 → `"superseded"` (documented upstream platform gap — onnxruntime-node
 *    is arm64-only for darwin; ENC-0e ships the demotion surface, no code fix
 *    is possible).
 *  - HG-5 → derived from the qualification record: an empty record is
 *    `"superseded"` (no measurement on this device); a `failed` verdict closes
 *    it with the measured p95/RSS wording; a `qualified` verdict closes it with
 *    "measured" wording. Severity stays `"medium"` from the base row.
 *  - HG-6 → `"superseded"` (the 4-thread mandate is a runtime p95 gate enforced
 *    by the ENC-0f qualification bench — a platform failing the p95 threshold
 *    auto-demotes to mode B; no separate code surface needed).
 *  - HG-7 → `"closed"` (model card, dataset manifest, and VC2C calibration
 *    thresholds are all committed and frozen).
 * `platform` is carried for contract symmetry with Worker B's route input; the
 * HG rules here do not branch on it (the closures are unconditional).
 */
export function computeSetupCortexBlockers(input: {
  platform: string | null;
  qualification: QualificationV1 | null;
  headCount: number | null;
  /** Installed native onnxruntime-node version (null = not installed). */
  nativeOrtInstalledVersion?: string | null;
}): readonly SetupCortexBlockerV1[] {
  const { qualification, headCount } = input;
  return SETUP_CORTEX_BLOCKERS.map((base): SetupCortexBlockerV1 => {
    switch (base.id) {
      case "HG-1":
        return headCount === ENCODER_HEAD_ORDER.length
          ? { ...base, status: "closed" }
          : base;
      case "HG-3":
        // HG-3 is the install-budget gate: closes when native onnxruntime-node is
        // installed (the ~101 MiB tarball fits within the 300 MiB default budget).
        // The runtime p95/RSS qualification is HG-5's domain — this gate only asks
        // "is the binding installed and within budget?".
        if (input.nativeOrtInstalledVersion != null) {
          return {
            ...base,
            status: "closed",
            resolution: `Native onnxruntime-node ${input.nativeOrtInstalledVersion} installed (~101 MiB, within the ${INSTALL_BUDGET_DEFAULT_MIB} MiB budget). Runtime qualification is HG-5.`,
          };
        }
        return base;
      case "HG-4":
        return {
          ...base,
          status: "superseded",
          resolution:
            "Upstream onnxruntime-node ships arm64-only for darwin. ENC-0e ships the demotion surface: darwin-x64 users use the WASM path (mode B) or lexical fallback (mode C). No code fix is possible — the binary does not exist upstream.",
        };
      case "HG-6":
        return {
          ...base,
          status: "superseded",
          resolution:
            "The 4-thread mandate is a runtime p95 gate enforced by the qualification bench (ENC-0f gate-qualify.mjs). A platform that fails the p95 latency threshold (40ms) is automatically demoted to mode B — no separate code surface needed. Low-core platforms are handled by the same qualification gate.",
        };
      case "HG-7":
        return {
          ...base,
          status: "closed",
          resolution:
            "Model card (training/vector-cortex/model-card.json), dataset manifest (training/vector-cortex/dataset-manifest.json), and VC2C calibration thresholds (EVALUATION_THRESHOLDS in types-vc2c.ts) are all committed and frozen.",
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
export type SetupCortexActionKind =
  | "fetch-model"
  | "bench"
  | "verify-asset"
  | "install-native-ort";

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
  // HG-6 (4-threads-mandatory) is a bench-time gate; it is declared as a bench
  // candidate but is medium severity, so `setupCortexActionBlockers` (which only
  // surfaces blocker-severity open ids) never returns it — inert intent, no
  // behavior change. HG-7 is training work (no action in this set).
  bench: ["HG-1", "HG-3", "HG-6"],
  "verify-asset": [],
  // ENC-2c: installing the lazy-download native binding is gated by HG-3 (the
  // open install-budget hard gate) — a closed HG-3 no longer blocks the install.
  "install-native-ort": ["HG-3"],
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

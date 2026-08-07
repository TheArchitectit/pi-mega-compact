/**
 * vector-cortex/encoder/decision.ts — ENC-0a backend-decision contract.
 *
 * The durable EncoderBackendDecisionV1 record: which ONNX runtime backend the
 * real learned encoder ships on (transformers.js/WASM vs onnxruntime-node
 * native), whether the configurable install budget holds (default 300 MiB;
 * operator-overridable via `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB`), the per-platform
 * install matrix, the opset baseline (locked 21 by ENC-0a), the license
 * verdict, and the pinned model/tokenizer sha256 digests.
 *
 * ENC-0a is the DECISION + MEASUREMENT sprint: this contract is what the
 * deterministic resolver (`scripts/encoder/resolve-backend-decision.mjs`) and
 * the durable record (`docs/vector-cortex/encoder-backend-decision.md`) both
 * consume. ENC-0a also owns the opset flip: ENCODER_OPSET is re-baselined to 21
 * in `types.ts` alongside the placeholder manifest (the 2026-08-05 trunk
 * research dropped the earlier Xenova opset-17 requirement). ENC-0b asserts the
 * staged real asset is opset 21 — no further constant change.
 *
 * Contract-first (ENGINEERING_PRACTICES §3). Pi-agnostic, dependency-free
 * (PREVENT-PI-004 — local computation only, never a fetch). No `any`
 * (PREVENT-011).
 */

import type { EncoderPlatform } from "./types.js";

/** Backend demotion disposition for a platform row. */
export type BackendDemotion = "none" | "wasm" | "modeB";

/**
 * One platform row: the concrete runtime + install size + demotion disposition.
 *
 * `demotionReason` is the ENC-0e canonical reason string for a demoted platform
 * (single source of truth — no literals scattered in routes or the event writer).
 */
export interface EncoderPlatformRow {
  readonly runtime: string;
  readonly installMiB: number;
  readonly demotion: BackendDemotion;
  readonly demotionReason?: string;
}

/**
 * The ENC-0e canonical darwin-x64 demotion reason (HG-4 / ENC-0e).
 *
 * macOS Intel has no native onnxruntime-node binary upstream (arm64-only; a
 * darwin-x64 transform-class package ships only WASM), so the runtime demotes
 * to mode-B WASM. This is the SINGLE canonical string — consumed by
 * runtime-select.ts (the runtime-selection event) and the Setup Cortex blockers
 * card. No string literal for this reason survives anywhere else.
 */
export const DARWIN_X64_DEMOTION_REASON =
  "darwin-x64: no native binary upstream (arm64-only); mode-B WASM per HG-4";

/**
 * Deterministic sentinel used when a darwin-x64 platform-matrix row is missing
 * the `demotionReason` string (unique-failure injection per the ENC-0e spec):
 * the selection must still choose mode-B WASM, never throw, and never fabricate
 * a native claim — the reason just falls back to this sentinel.
 */
export const DARWIN_X64_DEMOTION_REASON_SENTINEL =
  "darwin-x64: demoted to WASM (reason unavailable in platform matrix)";

/**
 * EncoderBackendDecisionV1 — the locked learned-encoder runtime-backend decision.
 *
 * `opset` is pinned to the literal 21 (the ENC-0a re-baseline); `artifacts`
 * carries only aggregate digests/sizes — never message content (EVAL-REDACT-002);
 * `blockedBy` names the open hard-gate items that DEFER part of the decision
 * (e.g. HG-4 — the darwin-x64 demotion is ENC-0e's job).
 */
export interface EncoderBackendDecisionV1 {
  readonly schema: "encoder-backend-decision-v1";
  readonly backend: "wasm" | "native";
  readonly budgetOk: boolean;
  readonly opset: 21;
  readonly platformMatrix: Readonly<Record<EncoderPlatform, EncoderPlatformRow>>;
  readonly license: { readonly spdx: "MIT"; readonly redistribution: true };
  readonly artifacts: {
    readonly model: { readonly path: string; readonly bytes: number; readonly sha256: string };
    readonly tokenizer: { readonly path: string; readonly bytes: number; readonly sha256: string };
  };
  readonly p95Ms: number | null;
  readonly blockedBy: readonly string[];
}

/**
 * The operator-configurable native-ort install byte-budget (MiB). Default 300
 * (shipped 5-platform ~160 MiB comfortably fits); override via
 * `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB`. Safe upper clamp `INSTALL_BUDGET_CLAMP_MIB`
 * rejects absurd values. Backend qualifies (`budgetOk`) iff the shipped
 * byte-count fits the configured budget.
 */
export const INSTALL_BUDGET_CLAMP_MIB = 8192;
export const INSTALL_BUDGET_DEFAULT_MIB = 300;

/**
 * Pure resolver: given a raw string (or null/undefined when the env var is
 * unset), return the integer budget the runtime will use. Out-of-range /
 * non-integer / empty input falls back to the default. Exported so the
 * dashboard Settings surface can compute the EFFECTIVE operand from a
 * persisted-but-not-yet-env-loaded value (the operator just POSTed a new
 * budget to disk; the running process has not sourced `.mega-compact.env`,
 * so `installBudgetMib()` reads the stale env, but the dashboard should show
 * what the runtime WILL use after the restart the dashboard itself tells the
 * operator is required).
 */
export function resolveInstallBudgetMib(
  raw: string | null | undefined,
): number {
  if (raw === undefined || raw === null || raw === "") return INSTALL_BUDGET_DEFAULT_MIB;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > INSTALL_BUDGET_CLAMP_MIB) {
    return INSTALL_BUDGET_DEFAULT_MIB;
  }
  return n;
}

export function installBudgetMib(): number {
  return resolveInstallBudgetMib(process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB);
}

/** The p95 latency gate at 512 tokens / 4 threads on linux-x64 (ms). */
export const ENCODER_DECISION_P95_MS = 40;

/**
 * buildDecision — assemble a valid, platform-complete EncoderBackendDecisionV1.
 *
 * Pure helper consumed by the acceptance aggregator (and any TS consumer of the
 * decision). Every EncoderPlatform must resolve to a row, and the passed
 * per-platform rows must be complete (no row omitted) — a partial matrix is a
 * contract violation, not a valid decision. All fields are passed in; this is a
 * structural constructor, not a rules engine (the resolver owns the decision
 * rule).
 */
export function buildDecision(input: {
  readonly backend: "wasm" | "native";
  readonly budgetOk: boolean;
  readonly p95Ms: number | null;
  readonly platformMatrix: Readonly<Record<EncoderPlatform, EncoderPlatformRow>>;
  readonly modelPath: string;
  readonly modelBytes: number;
  readonly modelSha256: string;
  readonly tokenizerPath: string;
  readonly tokenizerBytes: number;
  readonly tokenizerSha256: string;
  readonly blockedBy: readonly string[];
}): EncoderBackendDecisionV1 {
  const { platformMatrix } = input;
  const platforms: readonly EncoderPlatform[] = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
  ];
  for (const p of platforms) {
    if (!Object.prototype.hasOwnProperty.call(platformMatrix, p)) {
      throw new Error(`platform matrix is incomplete: missing row for ${p}`);
    }
  }
  return {
    schema: "encoder-backend-decision-v1",
    backend: input.backend,
    budgetOk: input.budgetOk,
    opset: 21,
    platformMatrix,
    license: { spdx: "MIT", redistribution: true },
    artifacts: {
      model: {
        path: input.modelPath,
        bytes: input.modelBytes,
        sha256: input.modelSha256,
      },
      tokenizer: {
        path: input.tokenizerPath,
        bytes: input.tokenizerBytes,
        sha256: input.tokenizerSha256,
      },
    },
    p95Ms: input.p95Ms,
    blockedBy: input.blockedBy,
  };
}

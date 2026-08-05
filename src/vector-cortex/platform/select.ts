/**
 * platform/select.ts — VC8C canary-selection engine selector (PURE).
 *
 * `selectEngine` decides the failure triad mode from a reviewer-accepted
 * `ParityReportV1` and the current host platform. It admits mode A (qualified
 * external Rust artifact) ONLY when every piece of evidence lines up:
 *
 *   1. The report's ABI version matches ABI_VERSION (RUST-ABI-001).
 *   2. URL metadata is present (artifactUrl is non-empty).
 *   3. A commit hash is present (commit is a non-empty hex-ish string).
 *   4. The artifact's Cargo.lock digest matches the report's evidence digest
 *      (RUST-META-003) — a digest mismatch MUST reject the artifact.
 *   5. The platform is in SUPPORTED_PLATFORMS (RUST-PLATFORM-*).
 *   6. EVERY fixture in the report's matrix resolved ok (RUST-001..030).
 *
 * Any failure demotes to B (TS reference). If the TS reference breaker has
 * opened (`allowLegacy` is set by the caller), the selector demotes further to
 * C (legacy path) instead — the two-bytes-of-safety pyramid never runs an
 * unqualified artifact and never silently rides a broken reference.
 *
 * Everything here is PURE: no clock, no storage, no network, no flag read. The
 * flag gates only the reporter seam in emit.ts.
 *
 * PREVENT-002/011/PI-004 honored.
 */

import {
  ABI_VERSION,
  RUST_ABI_MISMATCH,
  RUST_ARTIFACT_MISSING,
  RUST_CARGO_DIGEST_MISMATCH,
  RUST_PARITY_MISMATCH,
  RUST_PLATFORM_UNSUPPORTED,
  SUPPORTED_PLATFORMS,
} from "./types.js";
import type {
  EngineAbiV1,
  EngineArtifactV1,
  ParityReportV1,
  PlatformSelection,
  SupportedPlatform,
} from "./types.js";

/** A selection failure carrying a machine code (never free-text). */
export interface SelectionFailure {
  readonly code: string;
}

/** Construct a selection failure. */
function fail(code: string): SelectionFailure {
  return { code };
}

/** Type guard: is this a supported host platform? */
export function isSupportedPlatform(platform: string): platform is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);
}

/** A 40-char lowercase hex string is the canonical bare git SHA-256 commit. */
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Validate the ABI version matches EngineAbiV1 exactly. Throws on mismatch. */
export function validateAbi(abi: EngineAbiV1): void {
  if (abi.version !== ABI_VERSION) throw fail(RUST_ABI_MISMATCH);
}

/** Validate URL metadata + commit + Cargo.lock evidence are all present. */
function validateEvidence(report: ParityReportV1): void {
  if (report.artifactUrl.length === 0) throw fail(RUST_ARTIFACT_MISSING);
  if (!COMMIT_RE.test(report.commit)) throw fail(RUST_ARTIFACT_MISSING);
  // SHA-256 hex digests are exactly 64 chars; anything else is not evidence.
  if (report.cargoLockDigest.length !== 64) {
    throw fail(RUST_ARTIFACT_MISSING);
  }
  if (report.artifactCargoLockDigest.length !== 64) {
    throw fail(RUST_ARTIFACT_MISSING);
  }
}

/** True when every fixture in the matrix resolved ok. */
export function matrixAllOk(report: ParityReportV1): boolean {
  if (report.matrix.length === 0) return false;
  return report.matrix.every((f) => f.ok && f.code === null);
}

/**
 * Select the engine mode from a parity report and the host platform.
 *
 * Returns mode A only when all six admission checks pass and the digest (the
 * report's own evidence) is internally consistent with the Cargo.lock the
 * artifact claims. Otherwise demotes to B; if the TS reference breaker is open
 * (`allowLegacy`), demotes to C.
 */
export function selectEngine(
  abi: EngineAbiV1,
  report: ParityReportV1,
  platform: string,
  allowLegacy: boolean = false,
): PlatformSelection {
  try {
    validateAbi(abi);
    validateEvidence(report);
    if (!isSupportedPlatform(platform)) throw fail(RUST_PLATFORM_UNSUPPORTED);
    if (report.platform !== platform) throw fail(RUST_PLATFORM_UNSUPPORTED);
    // RUST-META-003: the artifact's own Cargo.lock digest must match the
    // reviewer-accepted evidence; a mismatch rejects the artifact outright.
    if (report.artifactCargoLockDigest !== report.cargoLockDigest) {
      throw fail(RUST_CARGO_DIGEST_MISMATCH);
    }
    if (!matrixAllOk(report)) {
      throw fail(RUST_PARITY_MISMATCH);
    }
    const artifact: EngineArtifactV1 = {
      url: report.artifactUrl,
      commit: report.commit,
      cargoLockDigest: report.cargoLockDigest,
      platform: report.platform as SupportedPlatform,
      qualified: true,
    };
    return { mode: "A", reason: "qualified", artifact };
  } catch (e) {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code: unknown }).code)
        : RUST_PARITY_MISMATCH;
    if (allowLegacy) {
      return { mode: "C", reason: code, artifact: null };
    }
    return { mode: "B", reason: code, artifact: null };
  }
}

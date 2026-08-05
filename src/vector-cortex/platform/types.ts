/**
 * platform/types.ts — VC8C engine ABI + parity report + selection types.
 *
 * These are the CANARY-SELECTION contracts. This repo has NO Rust workspace and
 * creates none: an external Rad repo supplies the artifact URL, commit, and
 * Cargo.lock digest/evidence as `ParityReportV1`. The selector only ever admits
 * mode A (qualified external Rust) when every piece of that evidence matches;
 * otherwise it demotes to B (TS reference) or C (legacy).
 *
 * EngineAbiV1 is the FINITE, versioned envelope both sides speak: an input
 * envelope in, an output envelope out, and a machine-coded error envelope. There
 * is deliberately no free-text field and no unbounded version string — an ABI
 * whose version or error space can drift at runtime cannot be cross-checked
 * against a foreign binary.
 *
 * Failure triad (private to the runtime; mirrored here for the selector):
 *   A = qualified external Rust artifact
 *   B = TS reference (forced by a parity or metadata failure)
 *   C = legacy path (forced when the TS reference breaker opens)
 *
 * Conformance IDs RUST-001..030 are registered here as the single source of
 * truth for the sprint's conformance rows; the three named fixtures
 * (RUST-ABI-001, RUST-ERR-002, RUST-META-003) are the headline assertions.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/** ABI version string shared by every engine implementation. */
export const ABI_VERSION = "engine-abi-v1";

/** Supported host platforms; an artifact for any other platform is rejected. */
export const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
] as const;

/** A supported host platform. */
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** Failure code: canonical bytes or failure codes disagreed across runners. */
export const RUST_PARITY_MISMATCH = "RUST_PARITY_MISMATCH";

/** Failure code: a neutral frame ended mid-record (partial write/read). */
export const RUST_FRAME_TRUNCATED = "RUST_FRAME_TRUNCATED";

/** Failure code: the artifact ABI version does not match ABI_VERSION. */
export const RUST_ABI_MISMATCH = "RUST_ABI_MISMATCH";

/** Failure code: the artifact Cargo.lock digest does not match the evidence. */
export const RUST_CARGO_DIGEST_MISMATCH = "RUST_CARGO_DIGEST_MISMATCH";

/** Failure code: the artifact targets a platform outside SUPPORTED_PLATFORMS. */
export const RUST_PLATFORM_UNSUPPORTED = "RUST_PLATFORM_UNSUPPORTED";

/** Failure code: the report names no artifact (URL/commit missing). */
export const RUST_ARTIFACT_MISSING = "RUST_ARTIFACT_MISSING";

/** The finite engine selection modes of the failure triad. */
export type EngineMode = "A" | "B" | "C";

/**
 * EngineAbiV1 — the versioned, bounded envelope both the TS reference and an
 * external Rust binary speak. `version` is always ABI_VERSION; error envelopes
 * carry only a machine code, never free-text.
 */
export interface EngineAbiV1 {
  readonly version: typeof ABI_VERSION;
  /** The input envelope: canonical, machine-typed production inputs. */
  readonly input: EngineInputEnvelope;
  /** The output envelope: canonical, machine-typed production outputs. */
  readonly output: EngineOutputEnvelope;
  /** The error envelope: a bounded machine-code set. */
  readonly error: EngineErrorEnvelope;
}

/** The canonical input envelope accepted by any engine. */
export interface EngineInputEnvelope {
  readonly schema: "engine-input-v1";
  readonly fixtureId: string;
  /** The raw bytes as a hex string so the envelope stays JSON-safe. */
  readonly inputHex: string;
}

/** The canonical output envelope produced by any engine. */
export interface EngineOutputEnvelope {
  readonly schema: "engine-output-v1";
  readonly fixtureId: string;
  /** The produced bytes as a hex string (canonical byte comparison). */
  readonly outputHex: string;
  /** The machine failure code, or null when the fixture succeeded. */
  readonly failureCode: string | null;
}

/** The bounded set of machine error codes an engine may emit. */
export interface EngineErrorEnvelope {
  readonly schema: "engine-error-v1";
  readonly codes: readonly [string, ...string[]];
}

/** One resolved fixture result inside a ParityReportV1 matrix. */
export interface ParityFixtureResult {
  readonly fixtureId: string;
  readonly ok: boolean;
  /** The machine code reported when not ok, else null. */
  readonly code: string | null;
}

/**
 * The result of a single engine selection. `artifact` is non-null ONLY when
 * mode is A (a qualified external Rust artifact is in use).
 */
export interface PlatformSelection {
  readonly mode: EngineMode;
  /** A short machine reason for the mode (never free-text prose). */
  readonly reason: string;
  readonly artifact: EngineArtifactV1 | null;
}

/** A qualified external Rust artifact as evidenced by a parity report. */
export interface EngineArtifactV1 {
  readonly url: string;
  /** The external repo commit the artifact was built from. */
  readonly commit: string;
  /** SHA-256 digest of the artifact's Cargo.lock, matched against evidence. */
  readonly cargoLockDigest: string;
  readonly platform: SupportedPlatform;
  /** Every fixture in the report's matrix resolved ok. */
  readonly qualified: true;
}

/**
 * ParityReportV1 — the reviewer-accepted evidence an external repo supplies.
 * Acceptance requires url, commit, cargoLockDigest, platform, and a matrix in
 * which EVERY fixture resolved ok. The selector ALSO compares the artifact's
 * own Cargo.lock digest (`artifactCargoLockDigest`) against the evidenced
 * digest (`cargoLockDigest`): RUST-META-003 — a mismatch rejects the artifact.
 */
export interface ParityReportV1 {
  readonly schema: "parity-report-v1";
  /** URL of the external Rust artifact. */
  readonly artifactUrl: string;
  /** External repo commit the artifact was built from. */
  readonly commit: string;
  /** SHA-256 digest of the artifact's Cargo.lock, as-evidenced. */
  readonly cargoLockDigest: string;
  /** The artifact's own claimed Cargo.lock digest; MUST match the evidence. */
  readonly artifactCargoLockDigest: string;
  /** The platform the artifact targets. */
  readonly platform: string;
  /** Per-fixture results; used as Cargo.lock evidence when matched against. */
  readonly matrix: ReadonlyArray<ParityFixtureResult>;
}

/** Conformance IDs RUST-001..RUST-030 for the 30 numbered conformance rows. */
export const RUST_CONFORMANCE_IDS: readonly string[] = Array.from(
  { length: 30 },
  (_v, i) => `RUST-${String(i + 1).padStart(3, "0")}`,
);

/** Named conformance fixtures for the sprint's headline assertions. */
export const RUST_NAMED_FIXTURES = [
  "RUST-ABI-001",
  "RUST-ERR-002",
  "RUST-META-003",
] as const;

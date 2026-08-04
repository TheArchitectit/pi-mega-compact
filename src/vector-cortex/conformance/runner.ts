/**
 * vector-cortex/conformance/runner.ts — v2 conformance runner (VC1C).
 *
 * Dispatches a conformance case STRICTLY by domain/version (no inference, no
 * partial output on unknown) and compares both the canonical success bytes and
 * the expected failure code. Owns `DowngradeReport`.
 *
 * The runner is triad-shaped (mode A client):
 *   A = this manifest runner over the real algorithms;
 *   B = an independent exact fixture reader (invertible digest recheck);
 *   C = reject any unknown domain/version WITHOUT partial output.
 *
 * Downgrade export: `exporter` produces a new legacy copy that never edits
 * authority data; the resulting `DowngradeReport` is deterministic — a second
 * run yields a byte-identical report digest (CONF-DOWN-003).
 *
 * No network, no side effects on authority (PREVENT-PI-004 / PREVENT-011).
 */

import { CONF_FAIL, type FixtureManifestEntry } from "./manifest.js";
import {
  createConformanceReporter,
  type ConformanceReporter,
} from "./emit.js";

/** A registered conformance algorithm handler for a (domain, tuple) key. */
export interface ConformanceHandler {
  /**
   * Run the case. `fixture` is the raw parsed fixture object. Returns ok with a
   * canonical output digest (the success bytes), or a failure code.
   */
  run(
    entry: FixtureManifestEntry,
    fixture: unknown,
  ): { ok: true; outputBytes: Uint8Array; outputDigest: string } | { ok: false; code: string };
}

/**
 * The deterministic downgrade-export report. `reportDigest` is a SHA-256 over
 * the canonical JSON of the report body, so a repeated export is byte-identical.
 */
export interface DowngradeReport {
  readonly schema: "downgrade-report-v1";
  readonly exportedCopyId: string;
  readonly copiedCount: number;
  readonly unrepresentableIds: readonly string[];
  readonly reportDigest: string;
}

/** A minimal exporter: produces a new legacy copy and its deterministic report. */
export interface DowngradeExporter {
  /** Run the export once. Must never edit the authority data it reads. */
  exportOnce(): DowngradeReport;
}

/**
 * Result of dispatching a conformance case: success bytes (mode A/B) or the
 * exact expected failure code (mode C rejects unknown without partial output).
 */
export type CaseResult =
  | { ok: true; outputDigest: string; algorithm: string }
  | { ok: false; code: string; algorithm: string };

const UNKNOWN_DOMAIN = "CONF_UNKNOWN_DOMAIN";
const UNKNOWN_VERSION = "CONF_UNKNOWN_VERSION";
/**
 * The runner-pinned expectation mismatch code: a dispatched handler returned an
 * outcome that contradicts the manifest entry's frozen expectation (the wrong
 * failure code, or a success/failure parity error). This is the runner's own
 * cross-check (task 5: "compare both success bytes and expected failure code"),
 * distinct from the domain's own failure codes.
 */
const EXPECTATION_MISMATCH = "CONF_EXPECTATION_MISMATCH";

export { UNKNOWN_DOMAIN, UNKNOWN_VERSION, EXPECTATION_MISMATCH };

/**
 * Run one conformance case by dispatching strictly on `(domain, algorithmTuple)`.
 * If no handler is registered for the exact domain/algorithms, returns
 * `CONF_UNKNOWN_DOMAIN`/`CONF_UNKNOWN_VERSION` WITHOUT partial output.
 *
 * After dispatch the runner cross-checks the handler's outcome against the
 * manifest entry's frozen expectation (task 5):
 *   - failure expected (`entry.failureCode` set): the handler must return
 *     `ok:false` with that exact code, else `CONF_EXPECTATION_MISMATCH`;
 *   - success expected (`entry.expected === "ok"`): the handler must return
 *     `ok:true`, and when the manifest pins an `expectedOutputDigest` the
 *     handler's `outputDigest` must match it, else `CONF_DIGEST_DRIFT`.
 */
export function runConformanceCase(
  entry: FixtureManifestEntry,
  handlers: ReadonlyMap<string, ConformanceHandler>,
  fixture: unknown,
  reporter: ConformanceReporter = createConformanceReporter(),
): CaseResult {
  const key = `${entry.domain}::${entry.algorithmTuple.join(";")}`;
  const handler = handlers.get(key);
  let result: CaseResult;
  if (!handler) {
    if (entry.domain === "") {
      result = { ok: false, code: UNKNOWN_DOMAIN, algorithm: entry.algorithm };
    } else {
      result = { ok: false, code: UNKNOWN_VERSION, algorithm: entry.algorithm };
    }
  } else {
    const out = handler.run(entry, fixture);
    if (out.ok) {
      // Success expected? The manifest entry pins the expected success bytes.
      if (entry.expected !== "ok") {
        result = { ok: false, code: EXPECTATION_MISMATCH, algorithm: entry.algorithm };
      } else if (
        entry.expectedOutputDigest !== undefined &&
        out.outputDigest !== entry.expectedOutputDigest
      ) {
        result = { ok: false, code: CONF_FAIL.DIGEST_DRIFT, algorithm: entry.algorithm };
      } else {
        result = { ok: true, outputDigest: out.outputDigest, algorithm: entry.algorithm };
      }
    } else {
      // Failure expected? The manifest entry pins the exact failure code.
      if (entry.failureCode !== undefined && out.code === entry.failureCode) {
        result = { ok: false, code: out.code, algorithm: entry.algorithm };
      } else {
        result = { ok: false, code: EXPECTATION_MISMATCH, algorithm: entry.algorithm };
      }
    }
  }
  reporter.caseChecked({
    id: entry.id,
    domain: entry.domain,
    algorithm: entry.algorithm,
    ok: result.ok,
    ...(result.ok ? { outputDigest: result.outputDigest } : { code: result.code }),
  });
  return result;
}

/**
 * Build a dispatch key for a (domain, algorithmTuple) pair. Callers register
 * handlers under this key.
 */
export function handlerKey(
  domain: string,
  algorithmTuple: readonly string[],
): string {
  return `${domain}::${algorithmTuple.join(";")}`;
}

/**
 * Run a downgrade export and recompute its report digest deterministically.
 * A second invocation produces a byte-identical report (CONF-DOWN-003).
 */
export function runDowngradeExport(
  exporter: DowngradeExporter,
  reporter: ConformanceReporter = createConformanceReporter(),
): DowngradeReport {
  const report = exporter.exportOnce();
  reporter.downgradeWritten({
    exportedCopyId: report.exportedCopyId,
    copiedCount: report.copiedCount,
    unrepresentableIds: report.unrepresentableIds,
    reportDigest: report.reportDigest,
  });
  return report;
}

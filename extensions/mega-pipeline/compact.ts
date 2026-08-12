/**
 * compact.ts — delegate-shell for the compaction pipeline (3WF-2 split).
 *
 * This file is now a thin barrel: the real bodies live in `./compact/` so the
 * module stays well under the extensions/ 400-line soft cap. The public API is
 * UNCHANGED — every existing importer (via `../mega-pipeline.js`, which does
 * `export * from "./mega-pipeline/compact.js"`) keeps working with ZERO changes
 * at their call sites. Exports preserved exactly:
 *   - `RunCompactResult` (type)
 *   - `runCompact`
 *   - `piCompactWouldNoop`
 */

export { runCompact, type RunCompactResult } from "./compact/run.js";
export { piCompactWouldNoop } from "./compact/noop.js";

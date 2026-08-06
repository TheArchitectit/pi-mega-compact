/**
 * vector-cortex/improve.ts — ML5-D "Improve Cortex" pure decision rule.
 *
 * The single pure decision of the improve job harness: given the training
 * process exit code and whether a readable produced-asset digest exists,
 * decide whether the five heads qualify (promote) or are demoted to mode B.
 *
 * Lives under src/ so both the dashboard-server route (routes-cortex-improve.ts)
 * and the ML5-D acceptance aggregator (dist/vector-cortex/ml5d-acceptance.test.js)
 * can import it — the mirrored dist/vector-cortex/ subtree carries this file via
 * the publish-acceptance copyTree, so the acceptance suite needs no real
 * training run.
 *
 * Pure, total over its inputs, zero I/O (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * Terminal decision for an improve job: qualified only when the training
 * process exited 0 AND a readable produced-asset digest exists; otherwise the
 * job is demoted to mode B (honest degradation — an empty corpus or a failed
 * train never fabricates a promotion).
 */
export function qualifyDecision(
  exitCode: number,
  assetDigest: string | null,
): "qualified" | "demoted_to_B" {
  return exitCode === 0 && assetDigest !== null ? "qualified" : "demoted_to_B";
}

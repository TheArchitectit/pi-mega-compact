/**
 * vector-cortex/encoder/promotion-emit.ts — ENC-0d promotion event writers.
 *
 * Writes the three real-asset promotion events to the monitoring `events.log`
 * as structured append-only JSON lines via the existing `logBenchEvent` seam
 * (`src/monitoring.ts`):
 *
 *   - `vector_cortex_asset_promoted`      (green digest-verified swap)
 *   - `vector_cortex_asset_demoted`       (red qualification / digest failure)
 *   - `vector_cortex_asset_rollback_back` (restore of a prior stack digest)
 *
 * Non-fatal and log-and-swallow: a write failure never breaks the agent loop
 * (best-effort store/write contract). Each line is `{ts, event, ...fields}`
 * shaped so the dashboard live-stream tail and evidence tooling parse it
 * identically to every other monitoring event. Events carry digests, colors
 * and verdicts ONLY — never message content (EVAL-REDACT-002).
 *
 * The path defaults to the standard state-dir events.log (mirrors
 * defaultEventsPath). Zero network, no `any` (PREVENT-PI-004 / PREVENT-011).
 */

import { defaultEventsPath, logBenchEvent } from "../../monitoring.js";
import { getStateDir } from "../../store.js";

/** Default events.log beside the state dir (mirrors bench.ts). */
export function promotionEventsPath(stateDir: string = getStateDir()): string {
  return defaultEventsPath(stateDir);
}

/** The promotion event kinds this emitter can write. */
export type PromotionEventKind =
  | "promoted"
  | "demoted"
  | "rollback_back";

const EVENT_NAME: Record<PromotionEventKind, string> = {
  promoted: "vector_cortex_asset_promoted",
  demoted: "vector_cortex_asset_demoted",
  rollback_back: "vector_cortex_asset_rollback_back",
};

/** Fields carried by a promotion event: digests, colors and verdicts only.
 *  Never any payload or message content (EVAL-REDACT-002). */
export interface PromotionEventFields {
  readonly color: "green" | "red";
  readonly assetDigest: string | null;
  readonly priorAssetDigest: string | null;
  readonly verdict: string;
}

/**
 * Append one promotion event to events.log (best-effort, non-fatal). The line
 * is `{ts, event, ...fields}` shaped, written append-only via the monitoring
 * logBenchEvent seam. On any write failure the event is swallowed — the agent
 * loop is never broken.
 */
export function appendPromotionEvent(
  path: string,
  kind: PromotionEventKind,
  fields: PromotionEventFields,
): void {
  logBenchEvent(path, EVENT_NAME[kind], { ...fields });
}

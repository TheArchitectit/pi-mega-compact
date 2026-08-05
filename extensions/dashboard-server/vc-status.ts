/**
 * dashboard-server/vc-status.ts — shared status derivation for Vector Cortex
 * dashboard routes. Every VC route computes a status field so the client can
 * show meaningful state (live / awaiting data / deferred / structural) instead
 * of bare zeros.
 *
 * Guardrails: PREVENT-011 (no `any`).
 */

export type VcStatus = "live" | "awaiting_data" | "deferred" | "structural" | "off";

export function deriveVcStatus(opts: {
  enabled: boolean;
  deferredReason?: string;
  hasData: boolean;
  structuralOnly?: boolean;
}): VcStatus {
  if (!opts.enabled) return "off";
  if (opts.deferredReason) return "deferred";
  if (opts.structuralOnly) return "structural";
  return opts.hasData ? "live" : "awaiting_data";
}

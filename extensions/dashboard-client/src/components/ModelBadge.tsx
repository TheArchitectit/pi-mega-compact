/**
 * dashboard-client/src/components/ModelBadge.tsx — model + provider + rates.
 *
 * Shows the active model name, human-readable provider, and input/output
 * token rates. Used in the Metrics tab header.
 */

import type React from "react";

export interface ModelBadgeProps {
  /** Model name/identifier. */
  name: string;
  /** Human-readable provider name. */
  providerName: string;
  /** Machine-readable provider identifier. */
  provider: string;
  /** Model input processing rate (tokens per second). */
  inputRate: number;
  /** Model output processing rate (tokens per second). */
  outputRate: number;
}

export function ModelBadge({
  name,
  providerName,
  provider,
  inputRate,
  outputRate,
}: ModelBadgeProps): React.ReactElement {
  return (
    <div className="model-badge">
      <span className="model-name">{name}</span>
      <span className="model-provider">{providerName}</span>
      <span className="model-provider-id">{provider}</span>
      <div className="model-rates">
        <span className="rate">in {inputRate} tok/s</span>
        <span className="rate">out {outputRate} tok/s</span>
      </div>
    </div>
  );
}

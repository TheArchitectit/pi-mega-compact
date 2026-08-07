/**
 * dashboard-client/src/tabs/MetricsTab.tsx — Metrics tab (C2) shell.
 *
 * DASH-0c: the Cache+Performance surface absorbs the metrics body as a
 * Performance section; this file is reduced to a shell that re-exports
 * `MetricsCards` (the byte-preserved body moved to ./CacheTab/MetricsCards.tsx).
 * Kept as a deep-link anchor for #metrics and for rollback symmetry (flag-off
 * renders MetricsTab as a standalone top-level surface). A DASH-0d cleanup deletes
 * this standalone copy after a deep-link audit proves no live consumer points
 * at it. The render body is otherwise identical to the pre-DASH-0c MetricsTab.
 */

import { MetricsCards } from "./CacheTab/MetricsCards";

export default function MetricsTab(): React.ReactElement {
	return <MetricsCards />;
}

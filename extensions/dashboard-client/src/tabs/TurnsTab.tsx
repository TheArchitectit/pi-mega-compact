/**
 * dashboard-client/src/tabs/TurnsTab.tsx — Turn-by-turn memory surface (S52).
 *
 * DASH-0d consolidation: the sessions surface owns the turns body as a drill-
 * down (`SessionsTab/TurnMemoryView.tsx`, re-homed VERBATIM in DASH-0b). This
 * standalone top-level file is reduced to a thin shell re-exporting
 * `TurnMemoryView`, so the flag-off pre-rollup 13-tab surface set still
 * resolves `TurnsTab` (deep-link + lazy-import anchor) with no duplicated
 * render body. The canonical home is `SessionsTab/TurnMemoryView.tsx`.
 */

import type React from "react";
import { TurnMemoryView } from "./SessionsTab/TurnMemoryView";

export default function TurnsTab(): React.ReactElement {
	return <TurnMemoryView />;
}

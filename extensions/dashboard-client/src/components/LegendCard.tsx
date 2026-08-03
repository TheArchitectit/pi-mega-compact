/**
 * dashboard-client/src/components/LegendCard.tsx — "What these numbers mean" legend.
 *
 * Collapsible <details> with the legend list (verbatim from html.ts).
 * Full-width card (grid-column: 1 / -1).
 */

import type React from "react";
import { Card, CardContent } from "../components/ui/card";

const LEGEND_ITEMS: ReadonlyArray<React.ReactNode> = [
	<li key="1">
		<b>Original (dropped)</b> — everything compacted away (including
		duplicates caught by dedup). The &quot;in.&quot;
	</li>,
	<li key="2">
		<b>Kept (summaries)</b> — compact summaries still held as &quot;memory&quot;
		(the &quot;out&quot;).
	</li>,
	<li key="3">
		<b>Freed</b> = dropped − kept — tokens saved so far (higher = better).
	</li>,
	<li key="4">
		<b>Compression %</b> — Freed ÷ Dropped — the headline efficiency
		number. Higher = more space reclaimed.
	</li>,
	<li key="5">
		<b>Storage dedup %</b> — how often new content matched something
		already saved, so no duplicate copy was written.
	</li>,
	<li key="6">
		<b>Data safety</b> — every compacted region is kept verbatim
		(compressed). Nothing is permanently deleted; you can restore any of
		it.
	</li>,
];

export function LegendCard(): React.ReactElement {
	return (
		<Card>
			<CardContent>
				<details>
					<summary className="cursor-pointer text-sm font-semibold">
						What these numbers mean
					</summary>
					<ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
						{LEGEND_ITEMS}
					</ol>
					<p className="mt-2 text-xs text-muted-foreground">
						Hover any label above for a quick explanation.
					</p>
				</details>
			</CardContent>
		</Card>
	);
}

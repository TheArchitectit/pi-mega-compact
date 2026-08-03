/**
 * dashboard-client/src/components/CacheHitsCard.tsx — Cache Hits & Compactions card.
 *
 * 6 fields: Cache Hits (session), Cache Hits (total),
 * Tokens Saved (session), Tokens Saved (total),
 * Compactions (session), Compactions (total).
 */

import type React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export interface CacheHitsCardProps {
	/** Cache hits in the current session. */
	cacheHitsSession: number;
	/** Total cache hits across all sessions. */
	cacheHitsTotal: number;
	/** Tokens saved by cache hits this session. */
	tokensSavedSession: number;
	/** Total tokens saved by cache hits. */
	tokensSavedTotal: number;
	/** Compactions performed this session. */
	compactionsSession: number;
	/** Total compactions performed. */
	compactionsTotal: number;
}

function StatRow({
	label,
	value,
}: {
	label: string;
	value: string | number;
}): React.ReactElement {
	return (
		<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="font-semibold">{value}</span>
		</div>
	);
}

export function CacheHitsCard(
	props: CacheHitsCardProps,
): React.ReactElement {
	return (
		<Card className="electric-hover">
			<CardHeader>
				<CardTitle>💾 Cache Hits &amp; Compactions</CardTitle>
			</CardHeader>
			<CardContent>
				<StatRow
					label="Cache Hits (session)"
					value={props.cacheHitsSession.toLocaleString()}
				/>
				<StatRow
					label="Cache Hits (total)"
					value={props.cacheHitsTotal.toLocaleString()}
				/>
				<StatRow
					label="Tokens Saved (session)"
					value={props.tokensSavedSession.toLocaleString()}
				/>
				<StatRow
					label="Tokens Saved (total)"
					value={props.tokensSavedTotal.toLocaleString()}
				/>
				<StatRow
					label="Compactions (session)"
					value={props.compactionsSession.toLocaleString()}
				/>
				<StatRow
					label="Compactions (total)"
					value={props.compactionsTotal.toLocaleString()}
				/>
			</CardContent>
		</Card>
	);
}

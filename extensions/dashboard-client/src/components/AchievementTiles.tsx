/**
 * dashboard-client/src/components/AchievementTiles.tsx — shared achievement grid.
 *
 * Renders a grid of achievement tiles from fetchAchievements() data.
 * Tile states: unlocked (icon+title+date), visible-locked (??? teaser),
 * hidden+locked (not rendered). Just-unlocked tiles get a pulse animation.
 * Toast notification fires for newly-unlocked achievements.
 *
 * Used by both GameTab (sub-section) and AchievementsTab (standalone).
 */

import type React from "react";
import { useRef, useState, useEffect } from "react";
import type { AchievementRow } from "@contracts";

export interface AchievementTilesProps {
	/** Achievement rows from /api/achievements. */
	achievements: AchievementRow[];
}

/** Format unlock timestamp (seconds → locale string). */
function fmtUnlockDate(ts: number): string {
	try {
		return new Date(ts * 1000).toLocaleString();
	} catch {
		return "\u2014";
	}
}

export function AchievementTiles({
	achievements,
}: AchievementTilesProps): React.ReactElement {
	const lastMaxTsRef = useRef(0);
	const [toastText, setToastText] = useState<string | null>(null);

	const maxTs = achievements.reduce(
		(mx, a) => Math.max(mx, a.unlocked_at ?? 0),
		0,
	);
	const prevMaxTs = lastMaxTsRef.current;

	/* Update ref after render so next poll sees previous baseline. */
	useEffect(() => {
		if (maxTs > lastMaxTsRef.current) {
			lastMaxTsRef.current = maxTs;
		}
	}, [maxTs]);

	/* Toast for newly-unlocked achievements. */
	useEffect(() => {
		if (prevMaxTs > 0 && maxTs > prevMaxTs) {
			const newly = achievements.filter(
				(a) => a.unlocked_at != null && (a.unlocked_at ?? 0) > prevMaxTs,
			);
			if (newly.length > 0) {
				const text =
					newly
						.map((a) => `${a.icon ?? ""} ${a.title}`.trim())
						.join(", ") + " unlocked!";
				setToastText(text);
				const t = setTimeout(() => setToastText(null), 4000);
				return (): void => clearTimeout(t);
			}
		}
	}, [achievements, maxTs, prevMaxTs]);

	/* Visible tiles: skip hidden+locked (hidden === 1 && unlocked_at == null). */
	const tiles = achievements.filter(
		(a) => !(a.hidden === 1 && a.unlocked_at == null),
	);

	return (
		<div className="ach-section">
			{toastText != null && (
				<div className="ach-toast show">{toastText}</div>
			)}
			<div className="ach-tiles">
				{tiles.length === 0 && (
					<span className="repo-none">no achievements yet</span>
				)}
				{tiles.map((a) => {
					if (a.unlocked_at != null) {
						const isNew = prevMaxTs > 0 && (a.unlocked_at ?? 0) > prevMaxTs;
						return (
							<div
								key={a.id}
								className={`ach-tile unlocked${isNew ? " just-unlocked" : ""}`}
							>
								{a.icon ?? ""} {a.title}
								<span className="ach-detail">
									unlocked {fmtUnlockDate(a.unlocked_at)}
								</span>
							</div>
						);
					}
					return (
						<div key={a.id} className="ach-tile locked">
							??? {a.title}
						</div>
					);
				})}
			</div>
		</div>
	);
}

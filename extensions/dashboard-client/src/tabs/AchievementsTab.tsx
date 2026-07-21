/**
 * dashboard-client/src/tabs/AchievementsTab.tsx — Achievements tab (NEW).
 *
 * Renders the shared AchievementTiles component standalone, plus a toast area.
 * Polls /api/achievements every 15s.
 */

import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { AchievementRow } from "@contracts";
import { fetchAchievements } from "../api/client";
import { AchievementTiles } from "../components/AchievementTiles";

export default function AchievementsTab(): React.ReactElement {
	const [achievements, setAchievements] = useState<AchievementRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);

	const doFetch = useCallback(async (): Promise<void> => {
		try {
			const rows = await fetchAchievements();
			setAchievements(rows);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let active = true;
		const run = async (): Promise<void> => {
			if (active) await doFetch();
		};
		void run();
		const timer = setInterval(() => void run(), 15000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [doFetch]);

	if (loading && achievements.length === 0)
		return <div className="tab-stub">Loading achievements…</div>;
	if (error && achievements.length === 0)
		return <div className="tab-stub">Error: {error.message}</div>;

	return (
		<div className="achievements-tab">
			<h2>Achievements</h2>
			<AchievementTiles achievements={achievements} />
		</div>
	);
}

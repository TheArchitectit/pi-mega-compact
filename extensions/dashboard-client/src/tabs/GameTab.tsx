/**
 * dashboard-client/src/tabs/GameTab.tsx — Game tab (NEW).
 *
 * Renders:
 *  (1) MEGA CACHE banner (animated gradient, shown when any mega_cache > 100)
 *  (2) Opie unlock tile (shown when mega_cache > 100)
 *  (3) High Scores header
 *  (4) 4 leaderboards in 2×2 grid: Cache %, Dedupe, Turns (LVL badge),
 *      MEGA CACHE trophies (firstSeen date meta)
 *  (5) Repos count badge via fetchGameScores({metric:'repos',limit:1})
 *  (6) Achievements sub-section (AchievementTiles shared component)
 *  (7) Game empty state
 * Polls scores + achievements every 15s, game-state every 15s.
 * Applies data-theme accent vars when game_mode_on.
 */

import type React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import type { GameScoreRow, AchievementRow } from "@contracts";
import { fetchGameScores, fetchAchievements, fetchGameState } from "../api/client";
import { AchievementTiles } from "../components/AchievementTiles";

/** Actual flat game state shape from the server (NOT the nested contract). */
interface FlatGameState {
	game_mode_on: boolean;
	theme: string;
	tui_display_mode: "full" | "minimal";
}

/** Metadata object inside a mega_cache GameScoreRow. */
interface TrophyMeta {
	firstSeenTs?: number;
	firstSeen?: number;
}

/* ── Format helpers (matching html.ts logic) ─────────────────────────── */

function fmtPct(v: number): string {
	return (Math.round(v * 10) / 10).toString() + "%";
}

function fmtDate(ts: number | null | undefined): string {
	return ts != null ? new Date(ts).toLocaleString() : "\u2014";
}

function trophyMeta(m: unknown): TrophyMeta {
	return m && typeof m === "object" ? (m as TrophyMeta) : {};
}

function repoBasename(path: string): string {
	return path.split("/").pop() || path;
}

/* ── Leaderboard card ────────────────────────────────────────────────── */

interface LeaderboardCardProps {
	title: string;
	rows: GameScoreRow[];
	badge?: React.ReactNode;
	renderValue: (r: GameScoreRow) => React.ReactNode;
}

function LeaderboardCard({
	title,
	rows,
	badge,
	renderValue,
}: LeaderboardCardProps): React.ReactElement {
	return (
		<div className="lb-card">
			<h3>
				{title}
				{badge}
			</h3>
			{rows.length === 0 ? (
				<div className="lb-empty">—</div>
			) : (
				<table>
					<tbody>
						{rows.map((r, i) => (
							<tr key={`${r.repo_root}-${i}`}>
								<td title={r.repo_root}>{repoBasename(r.repo_root)}</td>
								<td className="num">{renderValue(r)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

/* ── Main GameTab component ──────────────────────────────────────────── */

export default function GameTab(): React.ReactElement {
	const [scores, setScores] = useState<
		Record<string, GameScoreRow[]>
	>({});
	const [reposCount, setReposCount] = useState(0);
	const [achievements, setAchievements] = useState<AchievementRow[]>([]);
	const [gameModeOn, setGameModeOn] = useState(false);
	const [loading, setLoading] = useState(true);
	const [megaToast, setMegaToast] = useState<string | null>(null);
	const lastMegaTsRef = useRef(0);

	const fetchAll = useCallback(async (): Promise<void> => {
		try {
			const [cache, dedupe, turns, megaCache, repos, ach] =
				await Promise.all([
					fetchGameScores({ metric: "cache", limit: 25 }),
					fetchGameScores({ metric: "dedupe", limit: 25 }),
					fetchGameScores({ metric: "turns", limit: 25 }),
					fetchGameScores({ metric: "mega_cache", limit: 25 }),
					fetchGameScores({ metric: "repos", limit: 1 }),
					fetchAchievements(),
				]);

			/* Mega-cache toast: new row with value > 100 since last poll */
			const newRow = megaCache.find(
				(r) => r.ts > lastMegaTsRef.current && r.value > 100,
			);
			if (lastMegaTsRef.current > 0 && newRow) {
				setMegaToast(
					`oopsie! cache went to ${Math.round(newRow.value)}% — MEGA CACHE \uD83E\uDD67`,
				);
				setTimeout(() => setMegaToast(null), 4000);
			}
			if (megaCache.length > 0) {
				lastMegaTsRef.current = Math.max(
					...megaCache.map((r) => r.ts),
				);
			}

			setScores({ cache, dedupe, turns, mega_cache: megaCache });
			setReposCount(repos[0]?.value ?? 0);
			setAchievements(ach);
		} catch {
			/* non-fatal */
		} finally {
			setLoading(false);
		}
	}, []);

	/* Poll scores + achievements every 15s. */
	useEffect(() => {
		let active = true;
		const doFetch = async (): Promise<void> => {
			if (active) await fetchAll();
		};
		void doFetch();
		const timer = setInterval(() => void doFetch(), 15000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [fetchAll]);

	/* Poll game state every 15s for styling. */
	useEffect(() => {
		let active = true;
		const doFetch = async (): Promise<void> => {
			try {
				const gs = (await fetchGameState()) as unknown as FlatGameState;
				if (active) {
					setGameModeOn(!!gs.game_mode_on);
					if (gs.theme)
						document.documentElement.dataset.theme = gs.theme;
				}
			} catch {
				/* non-fatal */
			}
		};
		void doFetch();
		const timer = setInterval(() => void doFetch(), 15000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);

	/* Compute mega-cache banner data */
	const megaRows = scores.mega_cache ?? [];
	let bestMega: number | null = null;
	let firstSeen: number | null = null;
	for (const r of megaRows) {
		if (bestMega == null || r.value > bestMega) bestMega = r.value;
		const m = trophyMeta(r.meta);
		const fs = m.firstSeenTs ?? m.firstSeen ?? r.ts;
		if (firstSeen == null || fs < firstSeen) firstSeen = fs;
	}
	const showMega = bestMega != null && bestMega > 100;

	/* Turns level badge */
	const turnsRows = scores.turns ?? [];
	const maxTurns = turnsRows.reduce((mx, r) => Math.max(mx, r.value), 0);
	const lvl = Math.floor(Math.log2(maxTurns + 1)) + 1;

	/* Game empty state */
	const hasData =
		(scores.cache?.length ?? 0) > 0 ||
		(scores.dedupe?.length ?? 0) > 0 ||
		turnsRows.length > 0 ||
		megaRows.length > 0 ||
		reposCount > 0;

	return (
		<div className={`game-tab${gameModeOn ? " game-mode-on" : ""}`}>
			{megaToast != null && (
				<div className="mega-cache-toast show">{megaToast}</div>
			)}

			{showMega && (
				<div className="mega-cache-banner">
					{"\uD83E\uDD67"} MEGA CACHE! peak {fmtPct(bestMega!)} — first
					reached {fmtDate(firstSeen)}
				</div>
			)}

			{showMega && (
				<div className="achievement-tile unlocked">
					{"\uD83C\uDFC6"} Opie's Wild Ride
					<span className="ach-detail">
						best {fmtPct(bestMega!)} · first {fmtDate(firstSeen)}
					</span>
				</div>
			)}

			<h2>High Scores</h2>

			{!hasData && !loading && (
				<div className="game-empty">
					No scores yet — run a session with game mode on.
				</div>
			)}

			{hasData && (
				<div className="game-leaderboards">
					<LeaderboardCard
						title="Cache %"
						rows={scores.cache ?? []}
						renderValue={(r) => fmtPct(r.value)}
					/>
					<LeaderboardCard
						title="Dedupe (collapsed)"
						rows={scores.dedupe ?? []}
						renderValue={(r) => r.value.toLocaleString()}
					/>
					<LeaderboardCard
						title="Turns"
						rows={turnsRows}
						badge={
							turnsRows.length > 0 ? (
								<span className="lvl-badge">LVL {lvl}</span>
							) : undefined
						}
						renderValue={(r) => r.value.toLocaleString()}
					/>
					<LeaderboardCard
						title="MEGA CACHE trophies"
						rows={megaRows}
						renderValue={(r) => (
							<>
								{fmtPct(r.value)}
								<span className="lb-meta">
									{fmtDate(
										trophyMeta(r.meta).firstSeenTs ??
											trophyMeta(r.meta).firstSeen ??
											r.ts,
									)}
								</span>
							</>
						)}
					/>
				</div>
			)}

			{reposCount > 0 && (
				<div className="repos-badge-line">
					<span className="repos-badge">{reposCount} repos</span>
				</div>
			)}

			<h3>Achievements</h3>
			<AchievementTiles achievements={achievements} />
		</div>
	);
}

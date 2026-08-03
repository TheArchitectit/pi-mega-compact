/**
 * dashboard-client/src/tabs/SetupTab.tsx — Setup wizard tab shell (P0b).
 *
 * Sub-tab shell routing between Embedder / Config / Game Mode / Achievements.
 * The embedder setup section lives in SetupTab/EmbedderSetup.tsx.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints —
 * no external network calls.
 */
import type React from "react";
import { useState } from "react";
import GameTab from "./GameTab";
import AchievementsTab from "./AchievementsTab";
import ConfigTab from "./ConfigTab";
import EmbedderSetup from "./SetupTab/EmbedderSetup";
import ThresholdsPanel from "./SetupTab/ThresholdsPanel";
import { Toggle } from "../components/ui/toggle";

type SetupSubTab =
	| "embedder"
	| "thresholds"
	| "config"
	| "game"
	| "achievements";

const SUB_TABS: ReadonlyArray<{ id: SetupSubTab; label: string }> = [
	{ id: "embedder", label: "Embedder" },
	{ id: "thresholds", label: "Thresholds" },
	{ id: "config", label: "Config" },
	{ id: "game", label: "Game Mode" },
	{ id: "achievements", label: "Achievements" },
];

export default function SetupTab(): React.ReactElement {
	const [subTab, setSubTab] = useState<SetupSubTab>("embedder");

	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
			<nav
				className="flex gap-2 border-b border-border pb-2"
				aria-label="Setup sections"
			>
				{SUB_TABS.map((t) => (
					<Toggle
						key={t.id}
						pressed={subTab === t.id}
						onClick={() => setSubTab(t.id)}
					>
						{t.label}
					</Toggle>
				))}
			</nav>

			{subTab === "embedder" && <EmbedderSetup />}
			{subTab === "thresholds" && <ThresholdsPanel />}
			{subTab === "config" && <ConfigTab />}
			{subTab === "game" && <GameTab />}
			{subTab === "achievements" && <AchievementsTab />}
		</div>
	);
}

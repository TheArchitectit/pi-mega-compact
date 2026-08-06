/**
 * dashboard-client/src/tabs/SetupTab.tsx — Setup wizard tab shell (P0b).
 *
 * Sub-tab shell routing between Embedder / Thresholds / Config / Game Mode /
 * Achievements / Cortex. The embedder setup section lives in
 * SetupTab/EmbedderSetup.tsx; the VC9C Cortex sub-tab lives in
 * SetupTab/CortexSetup.tsx.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints —
 * no external network calls.
 */
import type React from "react";
import { useState, useMemo } from "react";
import GameTab from "./GameTab";
import AchievementsTab from "./AchievementsTab";
import ConfigTab from "./ConfigTab";
import EmbedderSetup from "./SetupTab/EmbedderSetup";
import ThresholdsPanel from "./SetupTab/ThresholdsPanel";
import CortexSetup from "./SetupTab/CortexSetup";
import { Toggle } from "../components/ui/toggle";
import { useSetupCortexPoll, isCortexSubTabVisible } from "./useSetupCortexPoll";

type SetupSubTab =
	| "embedder"
	| "thresholds"
	| "config"
	| "game"
	| "achievements"
	| "cortex";

const BASE_SUB_TABS: ReadonlyArray<{ id: SetupSubTab; label: string }> = [
	{ id: "embedder", label: "Embedder" },
	{ id: "thresholds", label: "Thresholds" },
	{ id: "config", label: "Config" },
	{ id: "game", label: "Game Mode" },
	{ id: "achievements", label: "Achievements" },
];

/** The Cortex sub-tab is filtered out when VC9A reports the off/disabled shape. */
const CORTEX_TAB = { id: "cortex", label: "Cortex" } as const;

export default function SetupTab(): React.ReactElement {
	const [subTab, setSubTab] = useState<SetupSubTab>("embedder");
	const [cortex] = useSetupCortexPoll();

	const subTabs = useMemo(() => {
		const tabs = [...BASE_SUB_TABS];
		if (isCortexSubTabVisible(cortex.data)) tabs.push(CORTEX_TAB);
		return tabs;
	}, [cortex.data]);

	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
			<nav
				className="flex gap-2 border-b border-border pb-2"
				aria-label="Setup sections"
			>
				{subTabs.map((t) => (
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
			{subTab === "cortex" && <CortexSetup />}
		</div>
	);
}

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
import { useState, useMemo, useCallback } from "react";
import type { SettingsResponse } from "@contracts";
import GameTab from "./GameTab";
import AchievementsTab from "./AchievementsTab";
import ConfigTab from "./ConfigTab";
import EmbedderSetup from "./SetupTab/EmbedderSetup";
import ThresholdsPanel from "./SetupTab/ThresholdsPanel";
import CortexSetup from "./SetupTab/CortexSetup";
import { Toggle } from "../components/ui/toggle";
import { useApi } from "../hooks/useApi";
import { fetchSettings } from "../api/client";
import { useSetupCortexPoll, isCortexSubTabVisible } from "./useSetupCortexPoll";

const DASH_0C_KEY = "MEGACOMPACT_DASH_0C";

/** Resolve the DASH-0c consolidation flag from the server settings state.
 *  Absent/not-yet-loaded => false (flag-off posture), so flag-off users keep the
 *  Config sub-tab; it is hidden only once settings confirm the flag is ON (the
 *  config editor then lives solely on the Admin surface). */
function dash0cEnabled(settings: SettingsResponse | null): boolean {
	if (!settings) return false;
	for (const cat of settings.categories) {
		for (const s of cat.settings) {
			if (s.key === DASH_0C_KEY && s.type === "boolean") return s.value === true;
		}
	}
	return false;
}

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

	/* DASH-0c: flag-ON hides the config sub-tab member (the config editor is then
	 * reachable only via the Admin surface). Flag-OFF renders config as today. */
	const { data: settingsData } = useApi<SettingsResponse>(
		useCallback(() => fetchSettings(), []),
		{ pollInterval: 0, maxRetries: 0 },
	);
	const dash0cOn = dash0cEnabled(settingsData);

	const subTabs = useMemo(() => {
		const tabs = dash0cOn
			? BASE_SUB_TABS.filter((t) => t.id !== "config")
			: [...BASE_SUB_TABS];
		if (isCortexSubTabVisible(cortex.data)) tabs.push(CORTEX_TAB);
		return tabs;
	}, [cortex.data, dash0cOn]);

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
			{subTab === "config" && !dash0cOn && <ConfigTab />}
			{subTab === "game" && <GameTab />}
			{subTab === "achievements" && <AchievementsTab />}
			{subTab === "cortex" && <CortexSetup />}
		</div>
	);
}

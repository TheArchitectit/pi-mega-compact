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

const containerStyle: React.CSSProperties = {
	padding: "1rem",
	maxWidth: "720px",
	margin: "0 auto",
	fontFamily: "system-ui, sans-serif",
	color: "#e0e0e0",
};

type SetupSubTab = "embedder" | "config" | "game" | "achievements";

const subTabNavStyle: React.CSSProperties = {
	display: "flex",
	gap: "0.5rem",
	marginBottom: "1rem",
	borderBottom: "1px solid #2a2a4e",
	paddingBottom: "0.5rem",
};

function subTabBtnStyle(active: boolean): React.CSSProperties {
	return {
		background: active ? "#3a5a9f" : "transparent",
		color: active ? "#fff" : "#a0a0c0",
		border: "1px solid",
		borderColor: active ? "#3a5a9f" : "#2a2a4e",
		borderRadius: "6px",
		padding: "0.4rem 0.8rem",
		cursor: "pointer",
		fontSize: "0.9rem",
		fontWeight: active ? 600 : 400,
	};
}

export default function SetupTab(): React.ReactElement {
	const [subTab, setSubTab] = useState<SetupSubTab>("embedder");

	return (
		<div style={containerStyle}>
			<nav style={subTabNavStyle} aria-label="Setup sections">
				<button
					type="button"
					style={subTabBtnStyle(subTab === "embedder")}
					onClick={() => setSubTab("embedder")}
				>
					Embedder
				</button>
				<button
					type="button"
					style={subTabBtnStyle(subTab === "config")}
					onClick={() => setSubTab("config")}
				>
					Config
				</button>
				<button
					type="button"
					style={subTabBtnStyle(subTab === "game")}
					onClick={() => setSubTab("game")}
				>
					Game Mode
				</button>
				<button
					type="button"
					style={subTabBtnStyle(subTab === "achievements")}
					onClick={() => setSubTab("achievements")}
				>
					Achievements
				</button>
			</nav>

			{subTab === "embedder" && <EmbedderSetup />}
			{subTab === "config" && <ConfigTab />}
			{subTab === "game" && <GameTab />}
			{subTab === "achievements" && <AchievementsTab />}
		</div>
	);
}

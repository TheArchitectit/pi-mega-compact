/**
 * MemoryMapTab.tsx — Sub-tab shell under Memory Map (Part B).
 *
 * Hosts two sub-tabs: the D3 force-directed Memory Map (MemoryMapView) and
 * the hierarchical RAPTOR tree (RaptorTreeView). The heavy rendering logic
 * lives in ./MemoryMapTab/* to keep every file under the extensions limit.
 */
import type React from "react";
import { useState } from "react";
import MemoryMapView from "./MemoryMapTab/MemoryMapView.js";
import RaptorTreeView from "./MemoryMapTab/RaptorTreeView.js";

type MemoryMapSubTab = "map" | "raptor";

const subTabNavStyle: React.CSSProperties = {
	display: "flex",
	gap: "0.5rem",
	marginBottom: "1rem",
	borderBottom: "1px solid #2a2a4e",
	paddingBottom: "0.5rem",
	paddingTop: "0.5rem",
	width: "100%",
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

const MemoryMapTab: React.FC = () => {
	const [subTab, setSubTab] = useState<MemoryMapSubTab>("map");

	return (
		<div className="memory-map-tab">
			<nav style={subTabNavStyle} aria-label="Memory map sections">
				<button
					type="button"
					style={subTabBtnStyle(subTab === "map")}
					onClick={() => setSubTab("map")}
				>
					Memory Map
				</button>
				<button
					type="button"
					style={subTabBtnStyle(subTab === "raptor")}
					onClick={() => setSubTab("raptor")}
				>
					RAPTOR Tree
				</button>
			</nav>
			{subTab === "map" && <MemoryMapView />}
			{subTab === "raptor" && <RaptorTreeView />}
		</div>
	);
};

export default MemoryMapTab;

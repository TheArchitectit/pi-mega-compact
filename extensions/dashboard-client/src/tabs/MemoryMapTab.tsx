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
import { Toggle } from "../components/ui/toggle";

type MemoryMapSubTab = "map" | "raptor";

const MemoryMapTab: React.FC = () => {
	const [subTab, setSubTab] = useState<MemoryMapSubTab>("map");

	return (
		<div className="flex flex-col gap-4">
			<nav
				className="flex gap-2 border-b border-border pb-2 pt-2"
				aria-label="Memory map sections"
			>
				<Toggle
					pressed={subTab === "map"}
					onClick={() => setSubTab("map")}
					aria-label="Memory Map view"
				>
					Memory Map
				</Toggle>
				<Toggle
					pressed={subTab === "raptor"}
					onClick={() => setSubTab("raptor")}
					aria-label="RAPTOR Tree view"
				>
					RAPTOR Tree
				</Toggle>
			</nav>
			{subTab === "map" && <MemoryMapView />}
			{subTab === "raptor" && <RaptorTreeView />}
		</div>
	);
};

export default MemoryMapTab;

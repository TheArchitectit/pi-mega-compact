/**
 * dashboard-client/src/tabs/AdminTab.tsx — Admin tab (DASH-0c delegate-shell).
 *
 * DASH-0c: the Admin surface combines the maintenance actions with the config
 * editor. A `AdminViews` toggle ("maintenance" / "config") switches between
 * `MaintenanceTab` (the maintenance shell over MaintenanceTab/*) and `ConfigTab`
 * (the config editor). Both bodies are UNCHANGED — only their hosting changes to
 * this new delegate-shell. `MaintenanceTab.tsx` and `ConfigTab.tsx` stay importable
 * from their original hosts (`ConfigTab` also stays wired into SetupTab per the
 * dual-host note). Flag-ON renders the toggle + both views; flag-OFF renders only
 * the maintenance view (the predecessor's `admin → MaintenanceTab` mapping),
 * and App.tsx keeps its current TabId routing this sprint (DASH-0d rewires).
 *
 * Flag: `MEGACOMPACT_DASH_0C` default ON. The dashboard client is a browser
 * bundle with NO `process` global, so the positive sprint flag cannot be read
 * server-side-style (`process.env`) inside the client. Instead the flag is read
 * from the server-authoritative `/api/rag-settings` state: the server resolves
 * `process.env["MEGACOMPACT_DASH_0C"] ?? default` into the `SettingState.value`
 * boolean.
 */

import type React from "react";
import { useCallback, useState } from "react";
import type { SettingsResponse } from "@contracts";
import { useApi } from "../hooks/useApi";
import { fetchSettings } from "../api/client";
import { Toggle } from "../components/ui/toggle";
import MaintenanceTab from "./MaintenanceTab";
import ConfigTab from "./ConfigTab";

const DASH_0C_KEY = "MEGACOMPACT_DASH_0C";

/** Resolve the DASH-0c consolidation flag from the server settings state.
 *  Absent/not-yet-loaded => false (flag-off posture), so flag-off users never
 *  see the toggle flash; the toggle appears only once settings confirm it is ON. */
function dash0cEnabled(settings: SettingsResponse | null): boolean {
	if (!settings) return false;
	for (const cat of settings.categories) {
		for (const s of cat.settings) {
			if (s.key === DASH_0C_KEY && s.type === "boolean") return s.value === true;
		}
	}
	return false;
}

type AdminViews = "maintenance" | "config";

export default function AdminTab(): React.ReactElement {
	const [view, setView] = useState<AdminViews>("maintenance");

	const { data: settingsData } = useApi<SettingsResponse>(
		useCallback(() => fetchSettings(), []),
		{ pollInterval: 0, maxRetries: 0 },
	);
	const dash0cOn = dash0cEnabled(settingsData);

	if (!dash0cOn) {
		return <MaintenanceTab />;
	}

	return (
		<div className="flex flex-col gap-4">
			<div
				className="flex items-center gap-2"
				role="tablist"
				aria-label="Admin views"
			>
				<Toggle
					pressed={view === "maintenance"}
					onClick={() => setView("maintenance")}
				>
					Maintenance
				</Toggle>
				<Toggle pressed={view === "config"} onClick={() => setView("config")}>
					Config
				</Toggle>
			</div>
			{view === "maintenance" ? <MaintenanceTab /> : <ConfigTab />}
		</div>
	);
}

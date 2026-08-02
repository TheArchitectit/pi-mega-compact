/**
 * dashboard-client/src/tabs/MaintenanceTab.tsx — Maintenance tab (v0.11.2 S49B).
 *
 * Delegate-shell (extensions split): three cards (Schema Health, DB Stats,
 * Actions) plus the Debug Bundle and Health Mitigation cards. The heavy card
 * components live in ./MaintenanceTab/* to keep every file under the extensions
 * line limit. All cards fetch independently; failures in one do not block the
 * others.
 */

import type React from "react";
import { useCallback } from "react";
import type {
	DbStatsResponse,
	SchemaHealthResponse,
} from "@contracts";
import { useApi } from "../hooks/useApi";
import { fetchDbStats, fetchSchemaHealth } from "../api/client";
import { SchemaHealthCard } from "./MaintenanceTab/SchemaHealthCard";
import { DbStatsCard } from "./MaintenanceTab/DbStatsCard";
import { ActionsCard } from "./MaintenanceTab/ActionsCard";
import { DebugBundleCard } from "./MaintenanceTab/DebugBundleCard";
import { HealthMitigationCard } from "./MaintenanceTab/HealthMitigationCard";

// ---------------------------------------------------------------------------
// Main tab component
// ---------------------------------------------------------------------------

export default function MaintenanceTab(): React.ReactElement {
	const {
		data: dbStats,
		loading: statsLoading,
		error: statsError,
	} = useApi<DbStatsResponse>(
		useCallback(() => fetchDbStats(), []),
		{ pollInterval: 15000 },
	);

	const {
		data: schemaHealth,
		loading: healthLoading,
		error: healthError,
	} = useApi<SchemaHealthResponse>(
		useCallback(() => fetchSchemaHealth(), []),
		{ pollInterval: 10000 },
	);

	return (
		<div className="maintenance-tab">
			<div className="card-grid">
				<SchemaHealthCard
					data={schemaHealth}
					loading={healthLoading}
					error={healthError}
				/>
				<DbStatsCard data={dbStats} loading={statsLoading} error={statsError} />
			</div>
			<ActionsCard />
			<DebugBundleCard />
			<HealthMitigationCard />
		</div>
	);
}

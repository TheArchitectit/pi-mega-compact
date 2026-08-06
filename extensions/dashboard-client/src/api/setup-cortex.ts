/**
 * dashboard-client/src/api/setup-cortex.ts — Setup Cortex API client.
 *
 * Fetches the VC9A status + drives the VC9B actions against the localhost
 * dashboard server. PREVENT-PI-004: relative loopback paths only — the client
 * is served by the local dashboard server, so no external network call.
 */

import type {
	SetupCortexStatusResponse,
	SetupCortexActionRequest,
	SetupCortexActionResult,
	SetupCortexActionErrorBody,
	SetupCortexActionLogResponse,
} from "../types/setup-cortex";

/** Reader-only status aggregate (GET /api/setup-cortex-status). */
export async function fetchSetupCortexStatus(): Promise<SetupCortexStatusResponse> {
	const r = await fetch("/api/setup-cortex-status");
	if (!r.ok) throw new Error(`setup-cortex status: ${r.status}`);
	return r.json() as Promise<SetupCortexStatusResponse>;
}

/**
 * Drive one Setup Cortex action (POST /api/setup-cortex-action).
 *
 * Returns a discriminated union so the UI can render the blocked /
 * confirmation-required / disabled states honestly instead of swallowing the
 * server's typed error body.
 */
export type SetupCortexActionOutcome =
	| { ok: true; result: SetupCortexActionResult }
	| { ok: false; status: number; error: SetupCortexActionErrorBody };

export async function postSetupCortexAction(
	body: SetupCortexActionRequest,
): Promise<SetupCortexActionOutcome> {
	const r = await fetch("/api/setup-cortex-action", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (r.ok) {
		return { ok: true, result: (await r.json()) as SetupCortexActionResult };
	}
	let error: SetupCortexActionErrorBody;
	try {
		error = (await r.json()) as SetupCortexActionErrorBody;
	} catch {
		error = { error: "disabled" };
	}
	return { ok: false, status: r.status, error };
}

/** Bounded, redacted log tail (GET /api/setup-cortex-action-log?name=...). */
export async function fetchSetupCortexActionLog(
	name: string,
): Promise<SetupCortexActionLogResponse> {
	const r = await fetch(`/api/setup-cortex-action-log?name=${encodeURIComponent(name)}`);
	if (!r.ok) throw new Error(`setup-cortex action-log: ${r.status}`);
	return r.json() as Promise<SetupCortexActionLogResponse>;
}

/**
 * dashboard-client/src/api/health.ts — Context Health API client.
 * PREVENT-PI-004: relative paths only (loopback dashboard).
 */

export interface ContextHealthRow {
	ts: number;
	turnIndex: number;
	sessionId: string;
	driftScore: number;
	outputQuality: number;
	errorScore: number;
	cacheHealth: number;
	cachePoison: number;
	composite: number;
	modelId: string | null;
	repetitionRatio: number | null;
	coherenceScore: number | null;
	prefixHash: string | null;
}

export interface ContextHealthResponse {
	updatedAt: string;
	latest: {
		composite: number;
		driftScore: number;
		outputQuality: number;
		errorScore: number;
		cacheHealth: number;
		cachePoison: number;
		ts: number;
		modelId: string | null;
	} | null;
	trend: number[];
	rows: ContextHealthRow[];
	perModel: Array<{ modelId: string; avgComposite: number; sampleCount: number }>;
	alerts: ContextHealthRow[];
}

export interface CachePoisonEvent {
	ts: number;
	turnIndex: number;
	sessionId: string;
	layer: number;
	detail: string;
	severity: string;
}

export interface CachePoisonResponse {
	updatedAt: string;
	events: CachePoisonEvent[];
}

export async function fetchContextHealth(minutes?: number): Promise<ContextHealthResponse> {
	const r = await fetch(`/api/context-health?minutes=${minutes ?? 30}`);
	if (!r.ok) throw new Error(`context-health: ${r.status}`);
	return r.json() as Promise<ContextHealthResponse>;
}

export async function fetchCachePoison(): Promise<CachePoisonResponse> {
	const r = await fetch("/api/cache-poison");
	if (!r.ok) throw new Error(`cache-poison: ${r.status}`);
	return r.json() as Promise<CachePoisonResponse>;
}

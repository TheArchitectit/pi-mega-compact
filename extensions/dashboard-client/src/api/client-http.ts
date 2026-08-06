/**
 * dashboard-client/src/api/client-http.ts — shared HTTP fetch helpers for the
 * client api layer.
 *
 * Extracted from client.ts (delegate-shell split) so client.ts stays under the
 * 400-line extension soft limit and both client.ts + client-extra.ts reuse one
 * definition of the typed get/put/post wrapper + query builder.
 *
 * PREVENT-PI-004: every request targets a relative path (loopback-only — the
 * dashboard server is the same origin that serves this static bundle). No
 * absolute URLs, no external hosts.
 */

/** Error thrown when a dashboard API response is not 2xx. */
export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(`dashboard API ${status}: ${message}`);
		this.name = "ApiError";
		this.status = status;
	}
}

/** Internal: typed GET that throws ApiError on non-2xx. */
export async function getJson<T>(path: string): Promise<T> {
	// guardrails-allow PREVENT-PI-004: relative-path fetch to same-origin dashboard server (loopback-only, static bundle served by the same Node HTTP server).
	const res = await fetch(path);
	if (!res.ok) {
		throw new ApiError(
			res.status,
			await res.text().catch(() => res.statusText),
		);
	}
	return res.json() as Promise<T>;
}

/** Internal: typed PUT that throws ApiError on non-2xx. */
export async function putJson<T>(path: string, body: unknown): Promise<T> {
	// guardrails-allow PREVENT-PI-004: relative-path fetch to same-origin dashboard server (loopback-only).
	const res = await fetch(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new ApiError(
			res.status,
			await res.text().catch(() => res.statusText),
		);
	}
	return res.json() as Promise<T>;
}

/** Internal: typed POST that throws ApiError on non-2xx. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
	// guardrails-allow PREVENT-PI-004: relative-path fetch to same-origin dashboard server (loopback-only, static bundle served by the same Node HTTP server).
	const res = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new ApiError(
			res.status,
			await res.text().catch(() => res.statusText),
		);
	}
	return res.json() as Promise<T>;
}

/** Build a query string from a record, skipping undefined/null values. */
export function query(
	params: Record<string, string | number | undefined | null>,
): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) sp.set(k, String(v));
	}
	const qs = sp.toString();
	return qs ? `?${qs}` : "";
}

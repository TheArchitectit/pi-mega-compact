/**
 * dashboard-client/src/hooks/useApi.ts — Generic data fetching hook.
 *
 * Provides typed fetch with retry, stale detection, and error handling.
 * SPRINT-B1: basic fetch. SPRINT-D1: retry + stale.
 */

import { useState, useEffect, useCallback, useRef } from "react";

export interface UseApiResult<T> {
	data: T | null;
	error: Error | null;
	loading: boolean;
	refetch: () => void;
	lastFetchedAt: number | null;
}

export interface UseApiOptions {
	/** Polling interval in ms. 0 = no polling. */
	pollInterval?: number;
	/** Max retry attempts on failure. */
	maxRetries?: number;
	/** Base retry delay in ms. */
	retryBaseMs?: number;
}

// SPRINT-D1: retry with exponential backoff on fetch failure, so a
// transient network blip (dashboard server still starting, ECONNRESET, a
// single malformed response) auto-recovers instead of surfacing a hard
// error screen that forces a manual page refresh. Crosses any fetch this
// hook backs (snapshot, sessions, ...).
function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Fetch with bounded exponential backoff retry. The retry schedule is
 *  {0, retryBaseMs, retryBaseMs*2, retryBaseMs*4, ...} capped at retryBaseMs*8,
 *  so maxRetries=3 yields ~0ms + 500ms + 1000ms + 2000ms before giving up. */
async function fetchWithRetry<T>(
	fetchFn: () => Promise<T>,
	maxRetries: number,
	retryBaseMs: number,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fetchFn();
		} catch (err) {
			lastErr = err;
			if (attempt === maxRetries) break;
			// Exponential backoff capped at 8x base to avoid long stalls.
			const delay = Math.min(retryBaseMs * 2 ** attempt, retryBaseMs * 8);
			await sleep(delay);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// SPRINT-T1-REMAINING: add Authorization header when auth token present.

export function useApi<T>(
	fetchFn: () => Promise<T>,
	options: UseApiOptions = {},
): UseApiResult<T> {
	const { pollInterval = 0, maxRetries = 3, retryBaseMs = 500 } = options;
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [loading, setLoading] = useState(true);
	const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
	const mountedRef = useRef(true);

	const doFetch = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			// Retry transient failures with exponential backoff so a single
			// network blip on page load auto-recovers instead of showing a
			// hard error that requires a manual refresh.
			const result = await fetchWithRetry(fetchFn, maxRetries, retryBaseMs);
			if (mountedRef.current) {
				setData(result);
				setLastFetchedAt(Date.now());
			}
		} catch (err) {
			if (mountedRef.current) {
				setError(err instanceof Error ? err : new Error(String(err)));
			}
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, [fetchFn, maxRetries, retryBaseMs]);

	useEffect(() => {
		mountedRef.current = true;
		doFetch();
		return () => {
			mountedRef.current = false;
		};
	}, [doFetch]);

	useEffect(() => {
		if (pollInterval <= 0) return;
		const timer = setInterval(doFetch, pollInterval);
		return () => clearInterval(timer);
	}, [doFetch, pollInterval]);

	return { data, error, loading, refetch: doFetch, lastFetchedAt };
}

/**
 * useSetupCortexPoll — polls the VC9A setup-cortex status endpoint (a sibling
 * of useVectorCortexPoll, URL + payload differ only). Each fetch is
 * best-effort: a failure sets the error slice and leaves data as-is. The
 * Cortex sub-tab uses the returned payload to render the encoder card + the
 * status badge, and SetupTab uses it to filter the sub-tab when the status
 * reports the off/disabled shape.
 */
import { useState, useEffect, useCallback } from "react";
import { fetchSetupCortexStatus } from "../api/setup-cortex";
import type { SetupCortexStatusResponse } from "../types/setup-cortex";

export interface SetupCortexPollState {
	loading: boolean;
	error: string | null;
	data: SetupCortexStatusResponse | null;
}

/**
 * Whether the Cortex sub-tab should be listed in SUB_TABS.
 *
 * The sub-tab is hidden (filtered from SUB_TABS) when the VC9A status payload
 * reports the off/disabled shape — either the flag is off (`enabled:false`) or
 * the derived status is "off" — exactly the VC0E honest-status gating the
 * sibling VC cards use. While the payload is still loading/absent we default to
 * visible so a transient poll isn't mistaken for the off state.
 */
export function isCortexSubTabVisible(
	data: SetupCortexStatusResponse | null,
): boolean {
	if (data === null) return true;
	return data.enabled && data.status !== "off";
}

export function useSetupCortexPoll(): [SetupCortexPollState, () => void] {
	const [state, setState] = useState<SetupCortexPollState>({
		loading: true,
		error: null,
		data: null,
	});

	const poll = useCallback(() => {
		setState((prev) => ({ ...prev, loading: true }));
		fetchSetupCortexStatus()
			.then((data) =>
				setState((prev) => ({ ...prev, data, loading: false, error: null })),
			)
			.catch((e: unknown) =>
				setState((prev) => ({
					...prev,
					loading: false,
					error: e instanceof Error ? e.message : String(e),
				})),
			);
	}, []);

	useEffect(() => {
		poll();
		const id = setInterval(poll, 5000);
		return () => clearInterval(id);
	}, [poll]);

	return [state, poll];
}

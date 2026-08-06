/**
 * SetupTab/CortexSetup.tsx — Setup Cortex sub-tab wizard shell (VC9C).
 *
 * Composes the encoder / blockers / actions cards. Polls the VC9A status via
 * useSetupCortexPoll (5s, best-effort) and shares one blocked-highlight set:
 * when an action returns 423 action_blocked_by_open_item, the gating blocker
 * rows are highlighted on the blockers card.
 *
 * Pure consumer of the VC9A status + VC9B action endpoints — NO server logic.
 */
import type React from "react";
import { useState, useCallback } from "react";
import { useSetupCortexPoll } from "../useSetupCortexPoll";
import { CortexEncoderCard } from "./CortexEncoderCard";
import { CortexBlockersCard } from "./CortexBlockersCard";
import { CortexActionsCard } from "./CortexActionsCard";
import { styles } from "./CortexSetupStyles";

export default function CortexSetup(): React.ReactElement {
	const [state, poll] = useSetupCortexPoll();
	const [highlight, setHighlight] = useState<string[]>([]);

	const onBlocked = useCallback((blockerIds: string[]) => {
		setHighlight(blockerIds);
	}, []);

	const onAction = useCallback(() => {
		poll();
	}, [poll]);

	return (
		<div style={styles.container}>
			<h2 style={{ fontSize: "1.3rem", marginTop: 0, marginBottom: "1rem" }}>
				Setup Cortex
			</h2>
			<p style={{ fontSize: "0.85rem", color: "#a0a0c0", marginTop: 0 }}>
				Vector-cortex encoder gate: mode, qualification, open hard-gate
				blockers, and the confirmation-gated fetch/bench/verify actions.
			</p>

			<CortexEncoderCard data={state.data} error={state.error} />
			<CortexBlockersCard
				blockers={state.data?.blockers ?? []}
				highlight={highlight}
			/>
			<CortexActionsCard
				data={state.data}
				onBlocked={onBlocked}
				onAction={onAction}
			/>
		</div>
	);
}

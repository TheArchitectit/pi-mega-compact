/**
 * dashboard-client/src/tabs/VectorCortexTab/sections.tsx — DASH-0b sectioned
 * layout for the Vector Cortex tab.
 *
 * Groups the existent flat VectorCortexTab card list under 4 `<section
 * aria-labelledby>` headers — Cortex status / Cortex repair / Cortex cache /
 * Cortex adaptive — without editing any card component file. Every card is
 * imported verbatim by its current path (unchanged prop contract) and appears
 * under EXACTLY one section (bijective assignment).
 *
 * Groups (spec §Goal):
 *   - Cortex status  — VC0C health card + ModelImprovementCard +
 *                      VectorCortexTopologyCard + VectorCortexShardsCard
 *                      (+ embedded Reconstruct)
 *   - Cortex repair  — VectorCortexClosureCard + VectorCortexRestoreCard +
 *                      VectorCortexRepairCard
 *   - Cortex cache   — VectorCortexCrystalsCard + VectorCortexEconomicsCard +
 *                      VectorCortexDiagnosticsCard
 *   - Cortex adaptive— VectorCortexOutcomesCard + VectorCortexPolicyCard +
 *                      VectorCortexPlansCard + VectorCortexRenderCard +
 *                      VectorCortexRolloutCard + VectorCortexPlatformCard +
 *                      VectorCortexLedgerCard
 *
 * The health card (VC0C "Live Safety Envelope") markup is moved here verbatim
 * from the predecessor VectorCortexTab so the sectioned (flag-ON) layout owns
 * all 18 cards. Consumers pass the live poll state + health-reset handlers.
 *
 * PREVENT-PI-004: local reader data only. PREVENT-011: no `any`.
 */

import type {
	VectorCortexHealthCard,
	VectorCortexEvaluationSummary,
} from "../../api/vector-cortex";
import type { VectorCortexPollState } from "../useVectorCortexPoll";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Metric } from "../VectorCortexMetric";
import { VectorCortexRenderCard } from "../VectorCortexRenderCard";
import { VectorCortexRolloutCard } from "../VectorCortexRolloutCard";
import { VectorCortexClosureCard } from "../VectorCortexClosureCard";
import { VectorCortexRestoreCard } from "../VectorCortexRestoreCard";
import { VectorCortexRepairCard } from "../VectorCortexRepairCard";
import { VectorCortexCrystalsCard } from "../VectorCortexCrystalsCard";
import { VectorCortexEconomicsCard } from "../VectorCortexEconomicsCard";
import { VectorCortexDiagnosticsCard } from "../VectorCortexDiagnosticsCard";
import { VectorCortexOutcomesCard } from "../VectorCortexOutcomesCard";
import { VectorCortexPolicyCard } from "../VectorCortexPolicyCard";
import { VectorCortexPlatformCard } from "../VectorCortexPlatformCard";
import {
	VectorCortexShardsCard,
	VectorCortexReconstructCard,
} from "../VectorCortexShardsCard";
import { VectorCortexPlansCard } from "../VectorCortexPlansCard";
import { VectorCortexTopologyCard } from "../VectorCortexTopologyCard";
import { VectorCortexLedgerCard } from "../VectorCortexLedgerCard";
import { ModelImprovementCard } from "../../components/ModelImprovementCard";

/** Props the sectioned layout needs from the VectorCortexTab shell. */
export interface VectorCortexSectionsProps {
	/** The polled evaluation summary (guaranteed non-null by the shell). */
	data: VectorCortexEvaluationSummary;
	/** Live VC0C health envelope (may be null when VC0C is off). */
	health: VectorCortexHealthCard | null;
	/** The full poll state (holds every card's view slice). */
	poll: VectorCortexPollState;
	/** Reset-cooldown handler wired to the VC0C health card. */
	onReset: () => void;
	/** Reset feedback message shown on the VC0C health card. */
	resetMsg: string | null;
}

function StatusHeading({ id, title }: { id: string; title: string }): React.ReactElement {
	return (
		<h2 id={id} className="font-heading text-lg font-semibold">
			{title}
		</h2>
	);
}

/**
 * The VC0C "Live Safety Envelope" health card, moved verbatim from the
 * predecessor VectorCortexTab. It is the 18th card in the sectioned layout.
 */
function Vc0cHealthCard({
	health,
	onReset,
	resetMsg,
}: {
	health: VectorCortexHealthCard | null;
	onReset: () => void;
	resetMsg: string | null;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Live Safety Envelope (VC0C)</CardTitle>
					<div className="flex items-center gap-2">
						{health?.stateSource === "ephemeral" && (
							<Badge variant="outline">EPHEMERAL (non-live)</Badge>
						)}
						<button
							onClick={onReset}
							disabled={!health?.enabled}
							className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
						>
							Reset Cooldown
						</button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{resetMsg && (
					<div className="mb-2 text-xs text-muted-foreground">{resetMsg}</div>
				)}
				{!health ? (
					<div className="vc-empty">Health unavailable (VC0C off).</div>
				) : (
					<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
						<Metric label="State" value={health.state} />
						<Metric label="Mode" value={health.mode} />
						<Metric label="Window" value={`${health.windowMs}ms`} />
						<Metric label="Probes" value={String(health.probeCount)} />
						<Metric label="Backoff" value={`${health.backoffDelayMs}ms`} />
						<Metric
							label="Failures"
							value={`${health.failures}/${health.attempts}`}
						/>
						<Metric
							label="Frontier"
							value={
								health.stateSource === "ephemeral"
									? "non-live"
									: health.frontierFrozen
										? "FROZEN"
										: "LIVE"
							}
						/>
						<Metric label="Spool lag" value={String(health.spoolLag)} />
						<Metric label="Encoder mode" value={health.encoderMode} />
						<Metric label="Encoder asset" value={health.encoderAssetDigest ? health.encoderAssetDigest.slice(0, 12) : "none"} />
					</div>
				)}
			</CardContent>
		</Card>
	);
}

/** The four section groups, rendered as `<section aria-labelledby>` blocks. */
export function VectorCortexSections({
	data,
	health,
	poll,
	onReset,
	resetMsg,
}: VectorCortexSectionsProps): React.ReactElement {
	return (
		<>
			<section aria-labelledby="cortex-status" className="flex flex-col gap-4">
				<StatusHeading id="cortex-status" title="Cortex status" />
				<Vc0cHealthCard health={health} onReset={onReset} resetMsg={resetMsg} />
				{data.ml5dEnabled && (
					<ModelImprovementCard
						encoderMode={health?.encoderMode ?? "B"}
						encoderAssetDigest={health?.encoderAssetDigest ?? null}
						status={data.status}
					/>
				)}
				<VectorCortexTopologyCard topology={poll.topology} query={poll.query} />
				<VectorCortexShardsCard view={poll.shards} />
				<VectorCortexReconstructCard view={poll.reconstruct} />
			</section>

			<section aria-labelledby="cortex-repair" className="flex flex-col gap-4">
				<StatusHeading id="cortex-repair" title="Cortex repair" />
				<VectorCortexClosureCard view={poll.closureProof} />
				<VectorCortexRestoreCard view={poll.restore} />
				<VectorCortexRepairCard view={poll.repair} />
			</section>

			<section aria-labelledby="cortex-cache" className="flex flex-col gap-4">
				<StatusHeading id="cortex-cache" title="Cortex cache" />
				<VectorCortexCrystalsCard view={poll.crystals} />
				<VectorCortexEconomicsCard view={poll.economics} />
				<VectorCortexDiagnosticsCard view={poll.diagnostics} />
			</section>

			<section aria-labelledby="cortex-adaptive" className="flex flex-col gap-4">
				<StatusHeading id="cortex-adaptive" title="Cortex adaptive" />
				<VectorCortexOutcomesCard view={poll.outcomes} />
				<VectorCortexPolicyCard view={poll.policy} />
				<VectorCortexPlansCard view={poll.plans} />
				<VectorCortexRenderCard view={poll.render} />
				<VectorCortexRolloutCard view={poll.rollout} />
				<VectorCortexPlatformCard view={poll.platform} />
				<VectorCortexLedgerCard ledger={poll.ledger} />
			</section>
		</>
	);
}

/**
 * VectorCortexLedgerCard.tsx — VC1B occurrence ledger card.
 *
 * Extracted from VectorCortexTab.tsx to keep the parent tab under the 400-line
 * extension soft limit (delegate-shell + impl-card pattern).
 */

import type { VectorCortexLedgerView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexLedgerCard({
  ledger,
}: {
  ledger: VectorCortexLedgerView | null;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Occurrence Ledger (VC1B)</CardTitle>
          <VcStatusBadge status={ledger?.status} />
        </div>
      </CardHeader>
      <CardContent>
        {!ledger?.enabled ? (
          <div className="vc-empty">Ledger disabled (VC1B off).</div>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-4 md:grid-cols-3">
              <Metric label="Session" value={ledger.session} />
              <Metric label="High-water" value={ledger.highWater} />
              <Metric label="Occurrences" value={String(ledger.count)} />
            </div>
            {ledger.occurrences.length === 0 ? (
              <div className="vc-empty">No occurrences recorded.</div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border/50 text-muted-foreground">
                      <th className="py-1 pr-2">seq</th>
                      <th className="py-1 pr-2">eventId</th>
                      <th className="py-1 pr-2">kind</th>
                      <th className="py-1 pr-2">toolCall</th>
                      <th className="py-1">digest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.occurrences.map((o) => (
                      <tr
                        key={`${o.seq}-${o.eventId}`}
                        className="border-b border-border/30"
                      >
                        <td className="py-1 pr-2 font-mono">{o.seq}</td>
                        <td className="py-1 pr-2 font-mono">{o.eventId}</td>
                        <td className="py-1 pr-2">{o.kind}</td>
                        <td className="py-1 pr-2 font-mono">
                          {o.toolCallId ?? "—"}
                        </td>
                        <td className="max-w-[180px] truncate font-mono text-muted-foreground">
                          {o.digest}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ledger?.status === "awaiting_data" && (
              <div className="mt-2 text-xs text-muted-foreground">
                Awaiting first event. Data will appear after the next pipeline run.
              </div>
            )}
            {ledger?.status === "deferred" && ledger?.deferredReason && (
              <div className="mt-2 text-xs text-muted-foreground">
                Deferred: {ledger.deferredReason.replace(/_/g, " ")}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

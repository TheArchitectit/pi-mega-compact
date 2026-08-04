/**
 * VectorCortexTopologyCard.tsx — VC3A/VC3B topology + VC3C query diagnostics cards.
 *
 * Extracted from VectorCortexTab.tsx to keep the parent tab under the 400-line
 * extension soft limit (delegate-shell + impl-card pattern).
 */

import type {
  VectorCortexTopologyView,
  VectorCortexQueryView,
} from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexTopologyCard({
  topology,
  query,
}: {
  topology: VectorCortexTopologyView | null;
  query: VectorCortexQueryView | null;
}): React.ReactElement {
  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Derived Cortex Store (VC3A)</CardTitle>
            {topology?.enabled ? (
              <Badge variant="success">ACTIVE</Badge>
            ) : (
              <Badge variant="danger">OFF</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!topology?.enabled ? (
            <div className="vc-empty">Cortex store disabled (VC3A off).</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                <Metric label="Generation" value={topology.generationId ?? "—"} />
                <Metric label="Ordinal" value={topology.ordinal ?? "—"} />
                <Metric label="Records" value={String(topology.recordCount)} />
                <Metric label="Frontier (HW)" value={topology.sourceHighWater} />
                <Metric
                  label="Root digest"
                  value={topology.rootDigest ? topology.rootDigest.slice(0, 16) : "—"}
                />
                {topology.nodes !== undefined && (
                  <>
                    <Metric
                      label="Nodes"
                      value={String(topology.nodes?.length ?? 0)}
                    />
                    <Metric
                      label="Edges"
                      value={String(topology.edges?.length ?? 0)}
                    />
                    <Metric
                      label="Graph digest"
                      value={
                        topology.generationDigest
                          ? topology.generationDigest.slice(0, 16)
                          : "—"
                      }
                    />
                  </>
                )}
              </div>
              {topology.nodes !== undefined &&
                (topology.edges?.length ?? 0) > 0 && (
                  <div className="mt-4 max-h-56 overflow-y-auto">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      Topology edges (VC3B)
                    </div>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border/50 text-muted-foreground">
                          <th className="py-1 pr-2">source</th>
                          <th className="py-1 pr-2">target</th>
                          <th className="py-1 pr-2">head</th>
                          <th className="py-1 pr-2">dir</th>
                          <th className="py-1">score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topology.edges?.map((e, i) => (
                          <tr
                            key={`${e.source}-${e.target}-${e.head}-${i}`}
                            className="border-b border-border/30"
                          >
                            <td className="py-1 pr-2 font-mono">{e.source}</td>
                            <td className="py-1 pr-2 font-mono">{e.target}</td>
                            <td className="py-1 pr-2 font-mono">{e.head}</td>
                            <td className="py-1 pr-2">{e.direction}</td>
                            <td className="py-1 font-mono">{e.score}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Topology Query Diagnostics (VC3C)</CardTitle>
            {query?.enabled ? (
              <Badge variant="success">ACTIVE</Badge>
            ) : (
              <Badge variant="danger">OFF</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!query?.enabled ? (
            <div className="vc-empty">Query diagnostics unavailable (VC3C off).</div>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Metric label="Router version" value={String(query.routerVersion)} />
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

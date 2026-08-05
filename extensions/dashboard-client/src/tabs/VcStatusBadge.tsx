import { Badge } from "../components/ui/badge";

type VcStatus = "live" | "awaiting_data" | "deferred" | "structural" | "off";

export function VcStatusBadge({
  status,
}: {
  status?: VcStatus | string;
}): React.ReactElement {
  switch (status) {
    case "live":
      return <Badge variant="success">LIVE</Badge>;
    case "awaiting_data":
      return <Badge variant="warning">AWAITING DATA</Badge>;
    case "deferred":
      return <Badge variant="outline">DEFERRED</Badge>;
    case "structural":
      return <Badge variant="accent">STRUCTURAL</Badge>;
    case "off":
      return <Badge variant="danger">OFF</Badge>;
    default:
      return <Badge variant="danger">OFF</Badge>;
  }
}

import type React from "react";

export function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
	return (
		<div>
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="font-mono text-sm">{value}</div>
		</div>
	);
}

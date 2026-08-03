/**
 * SetupTab/SettingsSection.tsx — collapsible settings category section.
 *
 * Each category from /api/rag-settings renders as a <section> with a toggle
 * button (aria-expanded + aria-controls) that shows/hides its setting rows.
 * Matches the Sidebar collapsible-accessibility pattern.
 */
import type React from "react";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../utils/cn";

interface SettingsSectionProps {
	readonly title: string;
	readonly children: React.ReactNode;
}

export default function SettingsSection({
	title,
	children,
}: SettingsSectionProps): React.ReactElement {
	const [open, setOpen] = useState<boolean>(true);
	const panelId = `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

	return (
		<section className="overflow-hidden rounded-xl border border-border bg-bg-elevated/40">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between rounded-t-xl bg-bg-elevated/60 px-4 py-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-bg-elevated"
				aria-expanded={open}
				aria-controls={panelId}
			>
				<span>{title}</span>
				<ChevronDown
					className={cn(
						"h-4 w-4 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
					aria-hidden="true"
				/>
			</button>
			{open && (
				<div id={panelId} className="divide-y divide-border px-4 py-1">
					{children}
				</div>
			)}
		</section>
	);
}

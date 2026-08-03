/**
 * dashboard-client/src/components/WidgetDetailModal.tsx — reusable drill-down modal.
 *
 * Wraps the RepoDetailModal overlay pattern (fixed backdrop, escape-key close,
 * click-backdrop close) into a generic container so Overview cards can open a
 * bar/line chart over time. Children render inside a scrollable panel.
 */

import type React from "react";
import { useEffect } from "react";
import { X } from "lucide-react";

export interface WidgetDetailModalProps {
	/** Modal heading shown in the panel header. */
	title: string;
	/** Whether the modal is open (mounted). */
	open: boolean;
	/** Called when the user closes via Escape, close button, or backdrop click. */
	onClose: () => void;
	/** Modal body (e.g. a chart component). */
	children: React.ReactNode;
}

export function WidgetDetailModal({
	title,
	open,
	onClose,
	children,
}: WidgetDetailModalProps): React.ReactElement {
	// Close on Escape key while the panel is open.
	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [open, onClose]);

	if (!open) return <></>;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div
				className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-bg-card p-5"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="mb-4 flex items-center justify-between gap-4">
					<h2 className="font-heading text-lg font-semibold">{title}</h2>
					<button
						type="button"
						className="text-muted-foreground transition-colors hover:text-foreground"
						onClick={onClose}
						aria-label="Close"
					>
						<X size={22} strokeWidth={2} />
					</button>
				</header>
				{children}
			</div>
		</div>
	);
}

/**
 * dashboard-client/src/tabs/WikiTab/WikiPageControls.tsx — rename/merge/split.
 *
 * Controlled dialogs for the three curation mutations. Non-destructive: on
 * success the parent refetches and paints the returned CurationResult; on
 * failure the pre-mutation snapshot stays (no local partial apply).
 *
 * Styling: Tailwind + shadcn (Button). No legacy CSS classes.
 */

import type React from "react";
import { useState } from "react";
import { renameTopic, mergeTopics, splitTopic } from "../../api/client";
import type { MemoryProvenance } from "@contracts";
import { Button } from "../../components/ui/button";

interface ControlsProps {
	topicId: string;
	others: Array<{ id: string; label: string }>;
	members: MemoryProvenance[];
	onMutated: () => void;
}

type Mode = "rename" | "merge" | "split" | null;

function memberSnippet(id: string, method: string): string {
	const base = id.length > 14 ? id.slice(0, 14) + "…" : id;
	return method ? `${base} (${method})` : base;
}

export default function WikiPageControls({
	topicId,
	others,
	members,
	onMutated,
}: ControlsProps): React.ReactElement {
	const [mode, setMode] = useState<Mode>(null);
	const [label, setLabel] = useState("");
	const [target, setTarget] = useState("");
	const [picked, setPicked] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function open(m: Exclude<Mode, null>): void {
		setMode(m);
		setError(null);
		setLabel("");
		setTarget("");
		setPicked([]);
	}

	async function submit(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			if (mode === "rename") {
				await renameTopic(topicId, label);
			} else if (mode === "merge") {
				if (!target) {
					setError("Pick a target topic.");
					setBusy(false);
					return;
				}
				await mergeTopics(topicId, target);
			} else if (mode === "split") {
				if (picked.length === 0) {
					setError("Pick at least one memory.");
					setBusy(false);
					return;
				}
				await splitTopic(topicId, picked);
			}
			setMode(null);
			onMutated();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<div className="flex gap-2">
				<Button variant="outline" size="sm" onClick={() => open("rename")}>
					Rename
				</Button>
				<Button variant="outline" size="sm" onClick={() => open("merge")}>
					Merge into…
				</Button>
				<Button variant="outline" size="sm" onClick={() => open("split")}>
					Split
				</Button>
			</div>

			{mode && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
					onClick={() => setMode(null)}
				>
					<div
						className="w-full max-w-md rounded-lg border border-border bg-bg-card p-5 shadow-xl"
						role="dialog"
						aria-modal="true"
						aria-label={mode}
						onClick={(e) => e.stopPropagation()}
					>
						<h3 className="mb-3 font-heading text-base font-semibold text-foreground">
							{mode === "rename"
								? "Rename topic"
								: mode === "merge"
									? "Merge into…"
									: "Split topic"}
						</h3>

						{mode === "rename" && (
							<input
								type="text"
								value={label}
								placeholder="New label (empty = back to auto)"
								aria-label="New topic label"
								autoFocus
								onChange={(e) => setLabel(e.target.value)}
								className="w-full rounded-md border border-border bg-bg-elevated/50 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
							/>
						)}

						{mode === "merge" && (
							<select
								value={target}
								aria-label="Target topic"
								onChange={(e) => setTarget(e.target.value)}
								className="w-full rounded-md border border-border bg-bg-elevated/50 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
							>
								<option value="">Pick a target topic…</option>
								{others.map((o) => (
									<option key={o.id} value={o.id}>
										{o.label}
									</option>
								))}
							</select>
						)}

						{mode === "split" && (
							<div className="max-h-56 overflow-auto rounded-md border border-border/60">
								{members.map((m) => (
									<label
										key={m.memoryId}
										className="flex cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-sm last:border-0 hover:bg-bg-elevated/40"
									>
										<input
											type="checkbox"
											checked={picked.includes(m.memoryId)}
											onChange={(e) => {
												setPicked((prev) =>
													e.target.checked
														? [...prev, m.memoryId]
														: prev.filter((x) => x !== m.memoryId),
												);
											}}
											className="accent-primary"
										/>
										<span className="font-mono text-xs text-muted-foreground">
											{memberSnippet(m.memoryId, m.method)}
										</span>
									</label>
								))}
							</div>
						)}

						{error && (
							<p className="mt-3 text-sm text-danger">{error}</p>
						)}

						<div className="mt-4 flex justify-end gap-2">
							<Button variant="ghost" size="sm" onClick={() => setMode(null)}>
								Cancel
							</Button>
							<Button size="sm" onClick={submit} disabled={busy}>
								{busy ? "…" : "Confirm"}
							</Button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

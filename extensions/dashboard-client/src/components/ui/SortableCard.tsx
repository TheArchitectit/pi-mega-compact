/**
 * dashboard-client/src/components/ui/SortableCard.tsx — sortable wrapper for
 * Overview grid cards.
 *
 * Drag isolation (Plexus PR #59 pattern): the sortable listeners live ONLY on
 * the grip icon. The card surface is not directly draggable — it keeps its
 * onClick (drill-down) and stays keyboard-accessible.
 */
import type React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { CardId } from "../../types/card";

export interface SortableCardProps {
	id: CardId;
	children: React.ReactNode;
	onClick?: () => void;
}

export function SortableCard({
	id,
	children,
	onClick,
}: SortableCardProps): React.ReactElement {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
		zIndex: isDragging ? 10 : undefined,
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (onClick && (e.key === "Enter" || e.key === " ")) {
			e.preventDefault();
			onClick();
		}
	};

	return (
		<div ref={setNodeRef} style={style} className="relative">
			<button
				type="button"
				aria-label={`Reorder ${id} card`}
				className="absolute right-2 top-2 z-10 cursor-grab rounded p-1 text-muted-foreground/50 hover:bg-foreground/5 hover:text-muted-foreground active:cursor-grabbing"
				{...attributes}
				{...listeners}
			>
				<GripVertical size={16} />
			</button>
			{onClick ? (
				<div
					role="button"
					tabIndex={0}
					onClick={onClick}
					onKeyDown={handleKeyDown}
					className="cursor-pointer rounded-lg outline-none transition-all duration-200 hover:ring-1 hover:ring-primary/60 focus-visible:ring-1 focus-visible:ring-primary/60"
				>
					{children}
				</div>
			) : (
				<div>{children}</div>
			)}
		</div>
	);
}

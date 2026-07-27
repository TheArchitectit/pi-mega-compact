/**
 * render-widget.ts — extracted `MegaRuntime.renderWidget()`: the width-aware
 * above-editor widget factory registration. Same thin-delegate pattern as the
 * other runtime.ts extractions.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WIDGET_KEY } from "./helpers.js";
import { buildWidgetLines, type WidgetData } from "./widget.js";

// ---------------------------------------------------------------------- types

/** The slice of `MegaRuntime` renderWidget reads at render time. */
export interface RenderWidgetContext {
	readonly widgetData: WidgetData | null;
	readonly activeAgents: number;
}

// -------------------------------------------------------------- renderWidget

/** Register the above-editor widget as a width-aware factory so pi re-renders
 *  it at the REAL terminal width every frame (auto-fit wide/narrow). The
 *  factory returns a minimal Component whose render() reads self.widgetData. */
export function renderWidgetImpl(
	self: RenderWidgetContext,
	ctx: ExtensionContext,
): void {
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, _theme) => ({
			render: (width: number) =>
				buildWidgetLines(
					self.widgetData,
					width > 0 ? width : 200,
					self.activeAgents,
				),
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	);
}

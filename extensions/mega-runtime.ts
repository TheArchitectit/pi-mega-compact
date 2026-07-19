/**
 * mega-runtime.ts — barrel file re-exporting the split submodules under
 * extensions/mega-runtime/.
 *
 * Originally a single ~1097-line monolith; split into focused submodules:
 *   - mega-runtime/widget.ts  — above-editor widget helpers + WidgetData
 *   - mega-runtime/helpers.ts — shared constants, SessionRuntime, ownVersion
 *   - mega-runtime/state.ts   — the MegaRuntime class
 *   - mega-runtime/query.ts   — recentUserQuery free function
 *
 * Every symbol previously exported from this file is re-exported here so
 * consumers (mega-compact.ts, mega-commands.ts, mega-events.ts,
 * mega-pipeline.ts, etc.) keep working with no import-path changes.
 */

export * from "./mega-runtime/widget.js";
export * from "./mega-runtime/helpers.js";
export * from "./mega-runtime/state.js";
export * from "./mega-runtime/query.js";

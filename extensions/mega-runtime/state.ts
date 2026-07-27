/**
 * state.ts — backwards-compatible re-export of MegaRuntime.
 *
 * The class implementation lives in runtime.ts.  This file exists so that
 * every existing `import { MegaRuntime } from "./state.js"` continues to
 * resolve without changes.
 */
export { MegaRuntime } from "./runtime.js";

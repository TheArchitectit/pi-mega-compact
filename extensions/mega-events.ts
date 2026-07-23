/** mega-events.ts — barrel re-exporting all pi lifecycle event handlers.
 *
 * Split into focused submodules under extensions/mega-events/:
 *  - register.ts: lastRuntime + registerEventHandlers (entry point)
 *  - session-handlers.ts: session lifecycle (model_select, session_start,
 *    session_tree, before_agent_start, session_shutdown)
 *  - agent-handlers.ts: agent/turn tracking (agent_start, agent_end,
 *    turn_start, turn_end)
 *  - context-handler.ts: live-trim auto-trigger (context event)
 *  - compact-handlers.ts: native compaction (session_before_compact,
 *    session_compact)
 */
export * from "./mega-events/register.js";
export * from "./mega-events/session-handlers.js";
export * from "./mega-events/agent-handlers.js";
export * from "./mega-events/context-handler.js";
export * from "./mega-events/compact-handlers.js";
export * from "./mega-events/perf-handler.js";
export * from "./mega-events/error-classifier.js";

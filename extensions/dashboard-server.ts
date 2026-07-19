/**
 * dashboard-server.ts — barrel file re-exporting all dashboard server submodules.
 *
 * Zero npm dependencies. Uses only Node built-in modules (http, fs, path).
 * Serves a single-page HTML dashboard, a JSON snapshot API, and an SSE
 * endpoint that live-streams new events.log entries.
 *
 * Designed to be spawned as a detached child process from the pi extension
 * and discovered by the /dashboard command via a port.pid file.
 *
 * @module
 */

export * from "./dashboard-server/types.js";
export * from "./dashboard-server/state.js";
export * from "./dashboard-server/index-reader.js";
export * from "./dashboard-server/snapshot.js";
export * from "./dashboard-server/html.js";
export * from "./dashboard-server/server.js";

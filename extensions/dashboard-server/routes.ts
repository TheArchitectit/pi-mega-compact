/**
 * dashboard-server/routes.ts — Barrel: re-exports all route handlers + types.
 *
 * server.ts imports only from this barrel; the actual handler implementations
 * live in the split files below.
 */

export { buildRouteContext } from "./routes-core.js";
export type { RouteContext } from "./routes-core.js";

export { handleIndex, handleRepoIndex, handleStatic } from "./routes-repo.js";
export { handleGameState, handleGameScores, handlePerf, handleAchievements } from "./routes-game.js";
export { handleEvents, handleSessions } from "./routes-sessions.js";
export { handleTopics } from "./routes-topics.js";

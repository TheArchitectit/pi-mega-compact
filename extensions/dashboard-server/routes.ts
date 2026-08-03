/**
 * dashboard-server/routes.ts — Barrel: re-exports all route handlers + types.
 *
 * server.ts imports only from this barrel; the actual handler implementations
 * live in the split files below.
 */

export { buildRouteContext } from "./routes-core.js";
export type { RouteContext } from "./routes-core.js";

export { handleIndex, handleRepoIndex, handleStatic } from "./routes-repo.js";
export {
	handleGameState,
	handleGameScores,
	handlePerf,
	handlePerfSamples,
	handleAchievements,
} from "./routes-game.js";
export { handleEvents, handleSessions } from "./routes-sessions.js";
export { handleTopics } from "./routes-topics.js";
export { handleTurns } from "./routes-turns.js";
export { handleMaintenance } from "./routes-maintenance.js";
export { handleProviderCache } from "./routes-cache.js";
export { handleMemoryStatus } from "./routes-memory.js";
export { handleSetupStatus, handleSetupDetect, handleSetupConfigure } from "./routes-setup.js";
export { handleMemoryMap } from "./routes-memory-map.js";
export { handleRaptorTree, handleRaptorBuildHistory } from "./routes-raptor.js";
export { handleCacheStripes } from "./routes-cache.js";
export { handleContextHealth, handleCachePoison, handleHealthSettings } from "./routes-health.js";
export { handleEmbedderHealth } from "./routes-embedder-health.js";
export { handleRagSettings } from "./routes-rag-settings.js";
export { handleRagMetrics } from "./routes-rag-metrics.js";
export { handleWiki } from "./routes-wiki.js";

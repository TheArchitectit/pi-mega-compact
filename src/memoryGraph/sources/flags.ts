/**
 * flags.ts — memory-graph feature-flag / env helpers (extracted from sources.ts).
 */

export function flagEnabled(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

export function areTurnsEnabled(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS", true);
}

export function isTurnContentEnabled(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT", true) &&
         flagEnabled("MEGACOMPACT_DB_MIRROR", false);
}

export function isTurnContentFlaggedOn(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT", true);
}

export function areMemoriesEnabled(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES", true);
}

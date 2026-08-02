/**
 * Shared helpers for the src/e2e.test split files.
 *
 * Extracted from the top of src/e2e.test.ts: isolated temp-store management,
 * the config-overridable VectorStore factory (store), the message builder
 * (msg), and the direct SQLite seeder (seedDirect) that bypasses online dedup.
 *
 * Relative paths are one directory deeper than the original file, hence
 * `../vectorStore.js` etc.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, computeRegionHash } from "../vectorStore.js";
import { loadDedupConfig, type DedupConfigShape } from "../config/dedup.js";
import { defaultEmbedder } from "../embedder.js";
import { upsertCheckpoint } from "../store/sqlite.js";
import type { EngineMessage } from "../types.js";
import type { StoredCheckpoint } from "../store.js";

export const baseTmp = mkdtempSync(join(tmpdir(), "mc-e2e-"));
let counter = 0;

export function storeDir(): string {
	return join(baseTmp, `run-${counter++}`);
}

/** Build an isolated VectorStore with a fresh state dir + optional config overrides. */
export function store(over: Partial<DedupConfigShape> = {}): VectorStore {
	const dir = storeDir();
	const config: DedupConfigShape = { ...loadDedupConfig(), ...over };
	return new VectorStore({ stateDir: dir, config });
}

export function msg(role: EngineMessage["role"], text: string, toolName?: string, input?: string, output?: string): EngineMessage {
	return toolName
		? { role, text, toolName, input: input ?? text, output: output ?? text }
		: { role, text };
}

/** Seed a checkpoint directly into SQLite (bypasses online dedup tiers). */
export function seedDirect(dir: string, sessionId: string, rows: { id: string; text: string; tok: number; ts?: number }[]): void {
	const e = defaultEmbedder();
	for (const r of rows) {
		const cp: StoredCheckpoint = {
			checkpointId: r.id,
			sessionId,
			summary: r.text,
			keyDecisions: [],
			nextSteps: [],
			filesModified: [],
			tokenEstimate: r.tok,
			regionHash: computeRegionHash(r.text),
			embedding: e.embed(r.text),
			timestamp: r.ts ?? 1,
		};
		upsertCheckpoint(cp, dir);
	}
}

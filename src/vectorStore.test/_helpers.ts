/**
 * Shared helpers for the vectorStore.test split files.
 * Extracted from src/vectorStore.test.ts: baseTmp, store(), imports.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../vectorStore.js";

export const baseTmp = mkdtempSync(join(tmpdir(), "mc-test-"));

let counter = 0;
export function store(opts: { dedupSim?: number } = {}): VectorStore {
  const dir = join(baseTmp, `run-${counter++}`);
  return new VectorStore({ dedupSim: opts.dedupSim ?? 0.9, stateDir: dir });
}

export function nextDir(): string {
  return join(baseTmp, `run-${counter++}`);
}

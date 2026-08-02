/**
 * Shared test fixtures/harness for the dedup-engine split test files.
 *
 * Extracted from dedup-engine.test.ts: tmp-dir lifecycle (beforeEach/afterEach),
 * store construction, message builders, and the compact + okReason helpers.
 * `currentTmpDir` is module-scoped per test-file subprocess (the runner isolates
 * each file in its own node --test process), so tests never collide.
 */
import { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { compactSession } from "../engine.js";
import { VectorStore } from "../vectorStore.js";
import { loadDedupConfig, type DedupConfigShape } from "../config/dedup.js";
import type { EngineMessage } from "../types.js";

function mkTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mc-dedup-"));
}

let currentTmpDir: string | undefined;

beforeEach(() => {
	currentTmpDir = mkTmpDir();
});

afterEach(() => {
	if (currentTmpDir && fs.existsSync(currentTmpDir)) {
		fs.rmSync(currentTmpDir, { recursive: true, force: true });
	}
	currentTmpDir = undefined;
});

function baseConfig(): DedupConfigShape {
	return loadDedupConfig();
}

export function makeStore(over: Partial<DedupConfigShape> = {}): VectorStore {
	return new VectorStore({
		stateDir: currentTmpDir,
		config: { ...baseConfig(), ...over },
	});
}

export function makeMsg(role: EngineMessage["role"], text: string): EngineMessage {
	return { role, text };
}

export function buildConversation(n: number, prefix = "turn"): EngineMessage[] {
	const out: EngineMessage[] = [];
	for (let i = 0; i < n; i++) {
		const role = i % 2 === 0 ? "user" : "assistant";
		out.push(
			makeMsg(
				role,
				`${prefix} ${i + 1}: ${role} discusses implementation of feature ${i + 1} in src/module${i + 1}.ts and considers tradeoffs.`,
			),
		);
	}
	return out;
}

export function compactFull(
	store: VectorStore,
	sessionId: string,
	messages: EngineMessage[],
	keepFrom?: number,
): ReturnType<typeof compactSession> {
	return compactSession({ sessionId, messages, keepFrom: keepFrom ?? messages.length }, store);
}

export function okReason(reason: string | undefined, expected: string[]): void {
	assert.ok(
		reason !== undefined && expected.includes(reason),
		`expected dedupReason one of ${expected.join(", ")}, got ${reason}`,
	);
}

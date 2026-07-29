/**
 * wiki.test.ts — S51C extractive wiki page tests. No network; temp dirs.
 * Includes the honest-boundary grep-assert (no ollama/llm/fetch) required by s47/s51.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractiveSummary, generateWikiPage, buildWikiIndex } from "./wiki.js";
import type { Topic, TopicAssignment } from "./topics/types.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-wiki-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function mkTopic(
	id: string,
	label: string,
	termScores: Array<{ term: string; score: number }>,
): Topic {
	return { id, label, termScores, memoryCount: 0, lastUpdated: 0 };
}

function mkAssignment(
	memId: string,
	topicId: string,
	confidence = 0.8,
): TopicAssignment {
	return {
		memoryId: memId,
		sessionId: "s",
		topicId,
		confidence,
		assignedAt: 0,
		method: "kmeans+tfidf",
	};
}

test("extractiveSummary returns top sentences joined", () => {
	const topic = mkTopic("t1", "sqlite", [{ term: "sqlite", score: 1 }]);
	const assignments = [mkAssignment("a", "t1"), mkAssignment("b", "t1")];
	const getContent = (id: string): string => {
		if (id === "a")
			return "SQLite uses WAL mode. SQLite uses WAL mode. SQLite uses WAL mode.";
		if (id === "b") return "Postgres uses WAL mode. Postgres uses WAL mode.";
		return "";
	};
	const summary = extractiveSummary(topic, assignments, getContent);
	// Should be non-empty and contain at least one sentence
	assert.ok(summary.length > 0);
	assert.ok(summary.includes("WAL"));
});

test("extractiveSummary returns empty string when topic has no members", () => {
	const topic = mkTopic("t1", "empty", []);
	const summary = extractiveSummary(topic, [], () => "");
	assert.equal(summary, "");
});

test("generateWikiPage produces page with summary + key/recent memories", () => {
	const topic = mkTopic("t1", "sqlite", [{ term: "sqlite", score: 1 }]);
	const assignments = [
		mkAssignment("a", "t1", 0.9),
		mkAssignment("b", "t1", 0.5),
	];
	const getMemoryInfo = (
		id: string,
	): { content: string; timestamp: number; importance: number } | null => {
		if (id === "a")
			return {
				content: "First memory content",
				timestamp: 100,
				importance: 0.9,
			};
		if (id === "b")
			return {
				content: "Second memory content",
				timestamp: 200,
				importance: 0.5,
			};
		return null;
	};
	const allTopics = [topic];

	const page = generateWikiPage(topic, assignments, getMemoryInfo, allTopics);
	assert.equal(page.topic.id, "t1");
	assert.equal(page.keyMemories.length, 2);
	// Key memories sorted by importance DESC
	assert.equal(page.keyMemories[0].importance, 0.9);
	// Recent memories sorted by timestamp DESC
	assert.equal(page.recentMemories[0].timestamp, 200);
	assert.equal(page.relatedTopics.length, 0);
	assert.ok(page.generatedAt > 0);
});

test("generateWikiPage finds related topics via co-occurrence", () => {
	const topicA = mkTopic("A", "topic-a", []);
	const topicB = mkTopic("B", "topic-b", []);
	const topicC = mkTopic("C", "topic-c", []);

	// Memory "shared" appears in both topicA and topicB → A and B are related.
	// Memory "a-only" only in topicA.
	// Memory "c-only" only in topicC (no overlap with A).
	const assignments = [
		mkAssignment("shared", "A"),
		mkAssignment("shared", "B"),
		mkAssignment("a-only", "A"),
		mkAssignment("c-only", "C"),
	];
	const getMemoryInfo = (
		id: string,
	): { content: string; timestamp: number; importance: number } | null => ({
		content: `content for ${id}`,
		timestamp: 100,
		importance: 0.5,
	});

	const page = generateWikiPage(topicA, assignments, getMemoryInfo, [
		topicA,
		topicB,
		topicC,
	]);
	// topicB should be related (shares "shared" with topicA); topicC should not.
	const relatedIds = page.relatedTopics.map((t) => t.id);
	assert.ok(
		relatedIds.includes("B"),
		`expected B in related topics, got ${relatedIds.join(",")}`,
	);
	assert.ok(
		!relatedIds.includes("C"),
		`C has no co-occurrence with A, should not be related`,
	);
});

test("buildWikiIndex aggregates topics + memory counts", () => {
	const topics = [mkTopic("t1", "sqlite", []), mkTopic("t2", "wal", [])];
	topics[0].memoryCount = 5;
	topics[1].memoryCount = 3;
	topics[0].lastUpdated = 1000;
	topics[1].lastUpdated = 2000;

	const idx = buildWikiIndex(topics);
	assert.equal(idx.totalTopics, 2);
	assert.equal(idx.totalMemories, 8);
	assert.equal(idx.topics.length, 2);
	assert.ok(idx.lastRebuildAt !== null);
});

test("buildWikiIndex handles empty topics", () => {
	const idx = buildWikiIndex([]);
	assert.equal(idx.totalTopics, 0);
	assert.equal(idx.totalMemories, 0);
	assert.equal(idx.lastRebuildAt, null);
});

test("honest boundary: no LLM/network/keyword-literals in src/wiki.ts", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const wikiPath = join(here, "..", "..", "src", "wiki.ts");
	const text = readFileSync(wikiPath, "utf8");
	const banned = [/ollama/i, /\bllm\b/i, /\bfetch\s*\(/, /\bhybrid\b/i];
	const fabricated = [
		"graphql",
		"docker",
		"stacktrace",
		"bottleneck",
		"trade-off",
	];
	for (const re of banned) {
		assert.ok(
			!re.test(text),
			`wiki.ts must not contain ${re} (PREVENT-PI-004 / no-model boundary)`,
		);
	}
	for (const word of fabricated) {
		assert.ok(
			!text.toLowerCase().includes(`"${word}"`),
			`wiki.ts must not hardcode fabricated taxonomy term "${word}"`,
		);
	}
});

test("honest boundary: no LLM/Ollama/network in src/topics/* (non-test)", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	// dist/src/wiki.test.js → ../../src/topics
	const topicsDir = join(here, "..", "..", "src", "topics");
	const files = readdirSync(topicsDir).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
	);
	const banned = [/ollama/i, /\bllm\b/i, /\bfetch\s*\(/, /\bhybrid\b/i];
	const fabricated = [
		"graphql",
		"docker",
		"stacktrace",
		"bottleneck",
		"trade-off",
	];
	for (const f of files) {
		const text = readFileSync(join(topicsDir, f), "utf8");
		for (const re of banned) {
			assert.ok(!re.test(text), `${f} must not contain ${re}`);
		}
		for (const word of fabricated) {
			assert.ok(
				!text.toLowerCase().includes(`"${word}"`),
				`${f} must not hardcode fabricated taxonomy term "${word}"`,
			);
		}
	}
});

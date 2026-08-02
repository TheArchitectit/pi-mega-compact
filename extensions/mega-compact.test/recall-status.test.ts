/**
 * recall-status.test.ts — resume auto-inline recall, /recall-context, /megacompact-status and model/provider capture.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

test("resume auto-inline stages recall into the system prompt", async () => {
	// S53: recall-tail injection (default ON) moved the prepend from
	// before_agent_start to the context handler (user-role tail). This test
	// exercises the LEGACY prepend path, so disable the flag.
	const prevTail = process.env.MEGACOMPACT_RECALL_TAIL_INJECT;
	process.env.MEGACOMPACT_RECALL_TAIL_INJECT = "false";
	const h = harness();
	// Seed a checkpoint first (simulate a prior session that compacted).
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	// Fresh resume: session_start with reason "resume".
	const ctx = h.ctx();
	await h.fire(
		"session_start",
		{
			type: "session_start",
			reason: "resume",
			previousSessionFile: undefined,
		} as any,
		ctx,
	);
	// The next before_agent_start must prepend the recalled block.
	const res = await h.fire(
		"before_agent_start",
		{
			type: "before_agent_start",
			prompt: "base system",
			images: undefined,
			systemPrompt: "base system",
			systemPromptOptions: {},
		} as any,
		ctx,
	);
	assert.ok(
		res && typeof res.systemPrompt === "string",
		"before_agent_start returns a systemPrompt",
	);
	assert.ok(
		res.systemPrompt.includes("Recalled context"),
		"recalled block injected into system prompt",
	);
	if (prevTail === undefined) delete process.env.MEGACOMPACT_RECALL_TAIL_INJECT;
	else process.env.MEGACOMPACT_RECALL_TAIL_INJECT = prevTail;
});

test("/recall-context reports and stages the top checkpoint", async () => {
	const h = harness();
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	const ctx = h.ctx();
	await h.commands["mega-recall"].handler("dedupe bug store.ts", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("recall staged")),
		"command reports staged checkpoints",
	);
	assert.ok(
		h.notifies.some((n) => n.includes("chkpt_")),
		"command names the checkpoint",
	);
});

test("/megacompact-status reports live store stats", async () => {
	const h = harness();
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 50000,
			contextWindow: 200000,
			percent: 25,
		}),
	});
	await h.commands["mega-status"].handler("", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("store:") && n.includes("chkpt")),
		"status shows checkpoint count",
	);
});

test("model_select captures model + provider into SQL", async () => {
	const h = harness();
	const modelCtx = h.ctx({
		model: {
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			provider: "anthropic",
			contextWindow: 200000,
			maxTokens: 32000,
			reasoning: false,
			cost: { input: 0.000015, output: 0.000075 },
		},
		modelRegistry: {
			getProviderDisplayName: (p: string) =>
				p === "anthropic" ? "Anthropic" : p,
		},
	});
	await h.fire("model_select", {}, modelCtx);
	const { latestModelSnapshot } = await import("../../src/store/sqlite.js");
	const snap = latestModelSnapshot(h.stateDir);
	assert.ok(snap, "model_snapshots row persisted");
	assert.equal(snap!.modelId, "claude-opus-4-8", "correct model id captured");
	assert.equal(snap!.provider, "anthropic", "correct provider captured");
	assert.equal(
		snap!.providerName,
		"Anthropic",
		"provider display name resolved",
	);
	assert.equal(snap!.inputRate, 0.000015, "input rate captured");
});

test("/mega-status surfaces the captured model + provider", async () => {
	const h = harness();
	const modelCtx = h.ctx({
		model: {
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			provider: "anthropic",
			contextWindow: 200000,
			maxTokens: 32000,
			reasoning: false,
			cost: { input: 0.000015, output: 0.000075 },
		},
		modelRegistry: { getProviderDisplayName: () => "Anthropic" },
	});
	await h.fire("model_select", {}, modelCtx);
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 50000,
			contextWindow: 200000,
			percent: 25,
		}),
	});
	await h.commands["mega-status"].handler("", ctx);
	assert.ok(
		h.notifies.some(
			(n) =>
				n.includes("🤖 model:") &&
				n.includes("Claude Opus 4.8") &&
				n.includes("Anthropic"),
		),
		"status surfaces captured model + provider",
	);
});


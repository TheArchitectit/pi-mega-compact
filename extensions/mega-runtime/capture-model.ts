/**
 * capture-model.ts — extracted model-capture logic for MegaRuntime.
 *
 * Captures the active model/provider from ctx.model and persists it so cost
 * estimation + the dashboard can read real pricing. Cheap + idempotent-ish:
 * only writes a new row when the model id changes (models change rarely).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRepoRoot } from "../mega-config.js";
import { recordModelSnapshot, recordRepoModel } from "../../src/store/sqlite.js";
import type { ModelSnapshot } from "../../src/store/sqlite.js";
import { lookupModelInputRate } from "../../src/pricing.js";

// ---------------------------------------------------------------------- types

export interface CaptureModelContext {
	readonly currentStateDir: string;
	currentModel: (ModelSnapshot & { capturedAt: number }) | null | undefined;
	diagCaptureModelCalls: number;
	diagCaptureModelFails: number;
	appendEvent(event: string, fields: Record<string, unknown>): void;
}

// -------------------------------------------------------------- captureModel

export function captureModelImpl(ctx: CaptureModelContext, ectx: ExtensionContext): void {
	const m = ectx.model;
	if (!m) {
		ctx.appendEvent("captureModel:no-model", { cwd: ectx.cwd });
		return;
	}
	if (
		ctx.currentModel &&
		ctx.currentModel.modelId === m.id &&
		ctx.currentModel.provider === m.provider
	)
		return;
	let providerName: string | null = null;
	try {
		providerName =
			ectx.modelRegistry?.getProviderDisplayName(m.provider) ?? null;
	} catch {
		/* optional */
	}
	const modelId = m.id;
	const fallbackInput = lookupModelInputRate(modelId);
	const snap: Omit<ModelSnapshot, "capturedAt"> = {
		provider: m.provider,
		providerName,
		modelId,
		modelName: m.name ?? null,
		inputRate: m.cost?.input || fallbackInput || 0,
		outputRate: m.cost?.output ?? 0,
		contextWindow: m.contextWindow ?? 0,
		maxTokens: m.maxTokens ?? 0,
		reasoning: !!m.reasoning,
	};
	ctx.currentModel = { ...snap, capturedAt: Date.now() };
	ctx.diagCaptureModelCalls++;
	const repo = resolveRepoRoot(ectx.cwd) ?? ctx.currentStateDir;
	// S26: previously a single silent `catch {}` hid every capture failure, so
	// model_snapshots stayed empty and the cost card read $0.00 with zero signal.
	// Split per-write + append to events.log (always-on, dashboard live-streams
	// it) + bump a DIAG counter so a live capture surfaces the root cause.
	try {
		recordModelSnapshot(repo, snap, ctx.currentStateDir);
		ctx.appendEvent("captureModel:recorded", {
			repo,
			modelId: snap.modelId,
			provider: snap.provider,
			inputRate: snap.inputRate,
			outputRate: snap.outputRate,
		});
	} catch (e) {
		ctx.diagCaptureModelFails++;
		ctx.appendEvent("captureModel:record-failed", {
			repo,
			modelId: snap.modelId,
			error: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
		});
	}
	try {
		// Denormalize the active model into the machine-wide index so the
		// All-repos dashboard table can show provider/model per repo without
		// opening every repo's DB. Best-effort + non-fatal.
		recordRepoModel(repo, {
			provider: snap.provider,
			providerName: snap.providerName,
			modelName: snap.modelName,
			inputRate: snap.inputRate,
			outputRate: snap.outputRate,
			stateDir: ctx.currentStateDir,
			displayName: repo.split(/[\\/]/).filter(Boolean).pop() ?? repo,
		});
	} catch (e) {
		ctx.appendEvent("captureModel:index-record-failed", {
			repo,
			modelId: snap.modelId,
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

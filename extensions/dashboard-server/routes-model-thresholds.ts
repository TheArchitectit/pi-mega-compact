/**
 * dashboard-server/routes-model-thresholds.ts — per-model compaction
 * thresholds (S52 / v0.16.1).
 *
 * Routes for the Setup panel "Thresholds" sub-tab.
 *
 *   GET    /api/model-thresholds           — list every known model + its
 *                                            threshold (override or default),
 *                                            for the dashboard table.
 *   PUT    /api/model-thresholds           — upsert a per-model override.
 *                                            Body: ModelThresholdPutRequest.
 *   DELETE /api/model-thresholds/:modelId  — delete the override (revert to
 *                                            env/defaults).
 *
 * Guardrails: PREVENT-PI-004 (loopback), PREVENT-001 (null-safe JSON),
 * PREVENT-002 (parameterized via model-thresholds.ts),
 * PREVENT-011 (no `any`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import type {
	ModelThresholdsResponse,
	ModelThresholdPutResponse,
	ModelThresholdDeleteResponse,
	ModelThresholdsError,
	KnownModel,
} from "./api-contracts/model-thresholds.js";
import {
	DEFAULT_SAFETY_MARGIN_PCT,
	DEFAULT_FIRE_POINT_PCT,
	MAX_SAFETY_MARGIN_PCT,
	MIN_SAFETY_MARGIN_PCT,
	MIN_FIRE_POINT_PCT,
	MAX_FIRE_POINT_PCT,
	getModelThreshold,
	listModelThresholds,
	putModelThreshold,
	deleteModelThreshold,
} from "../../src/store/sqlite/model-thresholds.js";
import { listModelSnapshots } from "../../src/store/sqlite/model-snapshots.js";

function send(res: ServerResponse, status: number, body: unknown): void {
	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Read + JSON.parse a request body (被骗: spans POST/PUT/DELETE).
 *  Capped at 64KB; null-safe. */
function readBody(
	req: IncomingMessage,
	cb: (
		result:
			| { ok: true; value: Record<string, unknown> }
			| { ok: false; error: ModelThresholdsError["error"] },
	) => void,
): void {
	let body = "";
	let tooBig = false;
	req.on("data", (chunk: Buffer) => {
		if (body.length > 65536) {
			tooBig = true;
			return;
		}
		body += chunk.toString();
	});
	req.on("end", () => {
		if (tooBig) return cb({ ok: false, error: "body_too_large" });
		try {
			const v = body ? JSON.parse(body) : {}; // PREVENT-001: type-checked
			if (typeof v !== "object" || v === null || Array.isArray(v)) {
				return cb({ ok: false, error: "invalid_json" });
			}
			cb({ ok: true, value: v as Record<string, unknown> });
		} catch {
			cb({ ok: false, error: "invalid_json" });
		}
	});
	req.on("error", () => cb({ ok: false, error: "invalid_json" }));
}

/** Read body that also handles 0 bytes. */
function requireNumber(v: unknown, label: string): number {
	const n = Number(v);
	if (!Number.isFinite(n)) {
		throw new Error(`${label} must be a finite number, got ${String(v)}`);
	}
	return n;
}

/** List known models from model_snapshots, deduped by model_id (latest wins). */
function listKnownModels(stateDir: string): KnownModel[] {
	const snaps = listModelSnapshots(stateDir);
	// Dedup by model_id, keep latest (highest capturedAt).
	const byId = new Map<string, (typeof snaps)[number]>();
	for (const s of snaps) {
		const existing = byId.get(s.modelId);
		if (!existing || s.capturedAt > existing.capturedAt) byId.set(s.modelId, s);
	}
	return Array.from(byId.values()).map((s) => ({
		modelId: s.modelId,
		provider: s.provider,
		modelName: s.modelName,
		contextWindow: s.contextWindow,
		maxTokens: s.maxTokens,
		hasOverride: getModelThreshold(s.modelId, stateDir) !== null,
	}));
}

export function handleModelThresholds(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/model-thresholds")) return false;
	const url = new URL(req.url, "http://x"); // guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)

	// GET: list every known model + its threshold.
	if (req.method === "GET" && url.pathname === "/api/model-thresholds") {
		try {
			const known = listKnownModels(ctx.stateDir);
			const overrides = new Map(
				listModelThresholds(ctx.stateDir).map((t) => [t.modelId, t]),
			);
			const body: ModelThresholdsResponse = {
				defaults: {
					safetyMarginPct: DEFAULT_SAFETY_MARGIN_PCT,
					firePointPct: DEFAULT_FIRE_POINT_PCT,
					safetyMarginRange: [MIN_SAFETY_MARGIN_PCT, MAX_SAFETY_MARGIN_PCT],
					firePointRange: [MIN_FIRE_POINT_PCT, MAX_FIRE_POINT_PCT],
				},
				models: known.map((m) => {
					const ov = overrides.get(m.modelId);
					return {
						...m,
						threshold: ov
							? {
									safetyMarginPct: ov.safetyMarginPct,
									firePointPct: ov.firePointPct,
									isOverride: true,
								}
							: {
									safetyMarginPct: DEFAULT_SAFETY_MARGIN_PCT,
									firePointPct: DEFAULT_FIRE_POINT_PCT,
									isOverride: false,
								},
					};
				}),
			};
			send(res, 200, body);
		} catch (e) {
			send(res, 500, { error: "internal", detail: String(e) });
		}
		return true;
	}

	// PUT: upsert a per-model override.
	if (req.method === "PUT" && url.pathname === "/api/model-thresholds") {
		readBody(req, (result) => {
			if (!result.ok) return send(res, 400, { error: result.error });
			try {
				const v = result.value;
				const modelId = v.modelId;
				if (typeof modelId !== "string" || !modelId.trim()) {
					return send(res, 400, { error: "missing_model_id" });
				}
				let safety: number;
				let fire: number;
				try {
					safety = requireNumber(v.safetyMarginPct, "safetyMarginPct");
					fire = requireNumber(v.firePointPct, "firePointPct");
				} catch (e) {
					return send(res, 400, {
						error: "invalid_pct",
						detail: e instanceof Error ? e.message : String(e),
					});
				}
				const t = putModelThreshold(modelId, safety, fire, ctx.stateDir);
				const body: ModelThresholdPutResponse = { threshold: t };
				send(res, 200, body);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (/must be in \[/.test(msg)) {
					return send(res, 400, { error: "invalid_pct", detail: msg });
				}
				send(res, 500, { error: "internal", detail: msg });
			}
		});
		return true;
	}

	// DELETE: /api/model-thresholds/:modelId
	if (
		req.method === "DELETE" &&
		url.pathname.startsWith("/api/model-thresholds/")
	) {
		const modelId = decodeURIComponent(
			url.pathname.slice("/api/model-thresholds/".length),
		);
		if (!modelId) {
			send(res, 400, { error: "missing_model_id" });
			return true;
		}
		try {
			const deleted = deleteModelThreshold(modelId, ctx.stateDir);
			const body: ModelThresholdDeleteResponse = { deleted };
			send(res, 200, body);
		} catch (e) {
			send(res, 500, { error: "internal", detail: String(e) });
		}
		return true;
	}

	// Catch-all: only GET/PUT/DELETE on /api/model-thresholds[*] are supported.
	if (url.pathname === "/api/model-thresholds") {
		send(res, 405, {
			error: "method_not_allowed",
		} satisfies ModelThresholdsError);
		return true;
	}
	return false;
}

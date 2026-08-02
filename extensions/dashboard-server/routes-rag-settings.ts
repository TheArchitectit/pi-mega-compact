/**
 * dashboard-server/routes-rag-settings.ts — RAG Settings route handler.
 *
 * GET /api/rag-settings  — Returns the state of all RAG feature flags (B1–B5).
 * POST /api/rag-settings — Toggles flags by writing MEGACOMPACT_*_DISABLED
 *                          lines to the per-repo .mega-compact.env file.
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe JSON),
 * PREVENT-011 (no `any`). Each JSON write carries a guardrails-allow annotation.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { detectCurrentEmbedder } from "./routes-setup.js";
import type {
	RagFlagState,
	RagSettingsResponse,
	RagSettingsRequest,
	RagSettingsResponsePost,
} from "./api-contracts/rag-settings.js";

// ---------------------------------------------------------------------------
// RAG_FLAGS — the five feature flags surfaced by this panel.
// ---------------------------------------------------------------------------

const RAG_FLAGS: {
	key: string;
	label: string;
	description: string;
	requiresLlm: boolean;
}[] = [
	{
		key: "MEGACOMPACT_QUERY_REFORMULATION",
		label: "Query Reformulation",
		description:
			"TF-IDF keyword expansion for vague recall queries (TrigramEmbedder path)",
		requiresLlm: false,
	},
	{
		key: "MEGACOMPACT_TIERED_ROUTER",
		label: "Tiered Recall Router",
		description:
			"L0 cache → L1 FTS5 → L2 HNSW routing for faster recall",
		requiresLlm: false,
	},
	{
		key: "MEGACOMPACT_RECALL_METRICS",
		label: "Recall Quality Metrics",
		description:
			"Precision/recall scoring and logging for recall evaluation",
		requiresLlm: false,
	},
	{
		key: "MEGACOMPACT_MEMORY_GRAPH",
		label: "Memory Graph",
		description:
			"Dashboard-oriented memory graph traversal across sessions",
		requiresLlm: false,
	},
	{
		key: "MEGACOMPACT_HYDE",
		label: "HyDE (Hypothetical Document Embeddings)",
		description:
			"Generate hypothetical answer via LLM, embed it, RRF-fuse with raw-query results",
		requiresLlm: true,
	},
];

/** Strip any MEGACOMPACT_*_DISABLED assignment lines from env file content. */
const DISABLED_LINE = /^export\s+MEGACOMPACT_\w+_DISABLED=/;

function isDisabled(key: string): boolean {
	const v = process.env[key + "_DISABLED"];
	return v === "true" || v === "1";
}

function readJsonBody(
	req: IncomingMessage,
	cb: (
		result:
			| { ok: true; value: Record<string, unknown> }
			| { ok: false; error: string },
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
			const v = body ? JSON.parse(body) : {}; // PREVENT-001: parsed value type-checked below
			if (typeof v !== "object" || v === null || Array.isArray(v)) {
				return cb({ ok: false, error: "invalid_object" });
			}
			cb({ ok: true, value: v as Record<string, unknown> });
		} catch {
			cb({ ok: false, error: "invalid_json" });
		}
	});
	req.on("error", () => cb({ ok: false, error: "read_error" }));
}

// ---------------------------------------------------------------------------
// handleRagSettings — "/api/rag-settings"
// ---------------------------------------------------------------------------

export function handleRagSettings(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.url !== "/api/rag-settings") return false;

	if (req.method === "GET") {
		const flags: RagFlagState[] = RAG_FLAGS.map((f) => ({
			key: f.key,
			label: f.label,
			description: f.description,
			enabled: !isDisabled(f.key),
			requiresLlm: f.requiresLlm,
		}));
		const body: RagSettingsResponse = {
			flags,
			llmActive: detectCurrentEmbedder() === "http",
		};
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
		return true;
	}

	if (req.method === "POST") {
		readJsonBody(req, (parsed) => {
			if (!parsed.ok) {
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: parsed.error }));
				return;
			}
			const body = parsed.value as unknown as RagSettingsRequest;
			const desired = body.flags;
			if (typeof desired !== "object" || desired === null || Array.isArray(desired)) {
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "invalid_flags" }));
				return;
			}
			// Only accept known RAG flag keys.
			const known = new Set(RAG_FLAGS.map((f) => f.key));
			for (const key of Object.keys(desired)) {
				if (!known.has(key)) {
					// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `unknown_flag: ${key}` }));
					return;
				}
			}

			const envPath = join(ctx.stateDir, ".mega-compact.env");
			let lines: string[] = [];
			if (existsSync(envPath)) {
				const content = readFileSync(envPath, "utf-8");
				lines = content.split("\n").filter((line) => !DISABLED_LINE.test(line));
			}
			for (const key of Object.keys(desired)) {
				if (desired[key] === false) {
					lines.push(`export ${key}_DISABLED="true"`);
				}
			}
			if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
			try {
				mkdirSync(ctx.stateDir, { recursive: true });
				writeFileSync(envPath, lines.join("\n"), "utf-8");
			} catch (e) {
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: `write_failed: ${e instanceof Error ? e.message : String(e)}`,
					}),
				);
				return;
			}
			const resp: RagSettingsResponsePost = {
				envPath,
				restartRequired: true,
			};
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(resp));
		});
		return true;
	}

	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(405, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "method_not_allowed" }));
	return true;
}

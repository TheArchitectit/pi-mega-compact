/**
 * dashboard-server/routes-setup.ts — Setup wizard route handlers.
 *
 * GET /api/setup-status  — Returns current embedder configuration from env.
 * GET /api/setup-detect  — Runs best-effort detection of local embedder backends.
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe JSON).
 * The detection commands run local subprocesses via spawnSync, NOT network calls.
 * Each decoration line carries a guardrails-allow annotation.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC9D_ENABLED } from "../../src/config.js";
import { enc1aStatusFields, writeEnc1aEnv, tryEnc1aConfigure, wantsEnc1a } from "./routes-setup-enc1a.js";
import { enc1bStatusFields, tryEnc1bConfigure, tryEnc1bInto, enc1bValidateCombined } from "./routes-setup-enc1b.js";
import {
	enc2BudgetStatusFields,
	tryEnc2BudgetInto,
	enc2BudgetValidateCombined,
} from "./routes-setup-enc2budget.js";
import { writeEmbedderEnv } from "./routes-setup-env-upsert.js";
import {
	detectOllama,
	detectLlamaCpp,
	detectOnnx,
	memoizedDetectOllama,
	memoizedDetectLlamaCpp,
	memoizedDetectOnnx,
} from "./routes-setup-detect-cache.js";
import type {
	SetupStatusResponse,
	SetupDetectResponse,
	SetupConfigureRequest,
	SetupConfigureResponse,
	DetectResult,
	OllamaDetectResult,
} from "./api-contracts/setup.js";

// ---------------------------------------------------------------------------
// handleSetupStatus — "/api/setup-status"
// ---------------------------------------------------------------------------

export function detectCurrentEmbedder(): SetupStatusResponse["currentEmbedder"] {
	const url = process.env["MEGACOMPACT_EMBEDDING_URL"];
	const minilm = process.env["MEGACOMPACT_MINILM"];
	if (url && url.trim().length > 0) return "http";
	if (minilm && ["1", "true", "yes"].includes(minilm.trim().toLowerCase()))
		return "minilm";
	return "trigram";
}

/** Read the configured embedder from the .mega-compact.env file (written by
 *  the configure endpoint). This shows what the user SELECTED even before pi
 *  restarts and loads the env file into process.env. */
function detectConfiguredEmbedder(stateDir: string): { embedder: "trigram" | "http" | "minilm"; url: string | null } {
	try {
		const envPath = join(stateDir, ".mega-compact.env");
		if (!existsSync(envPath)) return { embedder: "trigram", url: null };
		const content = readFileSync(envPath, "utf-8");
		const urlMatch = content.match(/^export\s+MEGACOMPACT_EMBEDDING_URL="([^"]+)"/m);
		if (urlMatch) return { embedder: "http", url: urlMatch[1] };
		const minilmMatch = content.match(/^export\s+MEGACOMPACT_MINILM="?(.+?)"?\s*$/m);
		if (minilmMatch && ["1", "true", "yes"].includes(minilmMatch[1].trim().toLowerCase()))
			return { embedder: "minilm", url: null };
		return { embedder: "trigram", url: null };
	} catch {
		return { embedder: "trigram", url: null };
	}
}

export function handleSetupStatus(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.url !== "/api/setup-status") return false;
	if (req.method !== "GET") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	const configured = detectConfiguredEmbedder(ctx.stateDir);
	const active = detectCurrentEmbedder();
	// ENC-1a (flag-gated, additive): echo the persisted endpoint URL and an
	// embeddingApiKeySet boolean ONLY — the raw API key is never returned. When
	// the flag is off (or neither is set) both fields are simply omitted.
	const body: SetupStatusResponse = {
		currentEmbedder: active,
		configuredEmbedder: configured.embedder,
		configuredUrl: configured.url,
		restartRequired: active !== configured.embedder,
		embeddingUrl: process.env["MEGACOMPACT_EMBEDDING_URL"] ?? configured.url,
		embedCache: process.env["MEGACOMPACT_EMBED_CACHE"] ?? null,
		minilm: ["1", "true", "yes"].includes(
			(process.env["MEGACOMPACT_MINILM"] ?? "").trim().toLowerCase(),
		),
		...enc1aStatusFields(ctx.stateDir), ...enc1bStatusFields(ctx.stateDir),
		...enc2BudgetStatusFields(ctx.stateDir),
	};
	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
	return true;
}

// ---------------------------------------------------------------------------
// handleSetupDetect — "/api/setup-detect"
// ---------------------------------------------------------------------------

// Detection bodies live in routes-setup-detect-cache.ts (single source). When
// MEGACOMPACT_VC9D is ON the memoized wrappers reuse the result across requests
// (keyed by the mutable input: resolved binary path + mtime); when OFF we call
// the raw fresh detectors — byte-identical to the VC9C-era per-request spawn.

export function handleSetupDetect(
	req: IncomingMessage,
	res: ServerResponse,
	_ctx: RouteContext,
): boolean {
	if (req.url !== "/api/setup-detect") return false;
	if (req.method !== "GET") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	let error: string | null = null;
	let ollama: OllamaDetectResult | null = null;
	let llamaCpp: DetectResult | null = null;
	let onnx: DetectResult | null = null;

	// guardrails-allow PREVENT-PI-004: local subprocess detection only (memoized or fresh)
	const cached = VC9D_ENABLED();

	try {
		ollama = cached ? memoizedDetectOllama() : detectOllama();
	} catch (e) {
		error = `ollama detection failed: ${e instanceof Error ? e.message : String(e)}`;
	}

	try {
		llamaCpp = cached ? memoizedDetectLlamaCpp() : detectLlamaCpp();
	} catch (e) {
		error = error ?? `llama.cpp detection failed: ${e instanceof Error ? e.message : String(e)}`;
	}

	try {
		onnx = cached ? memoizedDetectOnnx() : detectOnnx();
	} catch (e) {
		error = error ?? `onnx detection failed: ${e instanceof Error ? e.message : String(e)}`;
	}

	const body: SetupDetectResponse = { ollama, llamaCpp, onnx, error };
	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
	return true;
}

// ---------------------------------------------------------------------------
// handleSetupConfigure — POST "/api/setup-configure"
// ---------------------------------------------------------------------------

const OLLAMA_DEFAULT_URL = "http://localhost:11434/api/embeddings"; // guardrails-allow PREVENT-PI-004: localhost-only config string, not a runtime fetch
const LLAMA_DEFAULT_URL = "http://localhost:8080/v1/embeddings"; // guardrails-allow PREVENT-PI-004: localhost-only config string, not a runtime fetch
const ONNX_DEFAULT_URL = "http://localhost:8081/v1/embeddings"; // guardrails-allow PREVENT-PI-004: localhost-only config string, not a runtime fetch — TEI / ONNX embedding server

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
		if (body.length > 65536) { tooBig = true; return; }
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

export function handleSetupConfigure(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.url !== "/api/setup-configure") return false;
	if (req.method !== "POST") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	readJsonBody(req, (parsed) => {
		if (!parsed.ok) {
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: parsed.error }));
			return;
		}
		const body = parsed.value as unknown as SetupConfigureRequest;
		// ENC-1a (flag-gated, additive): a pure external-embedder configure
		// (new keys, no embedder selection) is handled by the sibling writer.
		// Flag-off = the keys are simply not recognized, falling through to the
		// pre-ENC-1a embedder path below (byte-identical predecessor).
		if (tryEnc1aConfigure(body, res, ctx)) return;
		if (tryEnc1bConfigure(body, res, ctx)) return; // pure ENC-1b configure (dim/headers/allow-remote/native)
		// ENC-1b combined-payload validation: when a payload carries a valid
		// embedder PLUS the ENC-1b keys, tryEnc1bConfigure above returned false
		// (it handles only the pure-ENC-1b shape) and tryEnc1bInto below would
		// write WITHOUT validating. Run the same dim/headers validation here so
		// the combined path is rejected with the same 400 codes. Flag-off:
		// enc1bValidateCombined returns null (byte-identical predecessor — the
		// unknown keys fall through untouched).
		const combinedError = enc1bValidateCombined(body);
		if (combinedError !== null) {
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: combinedError }));
			return;
		}
		// ENC-2a combined-payload validation: when a payload carries a valid
		// embedder PLUS the budget key, validate the budget BEFORE the upsert so
		// the combined path is rejected with the same 400 code. Flag-off:
		// enc2BudgetValidateCombined returns null (byte-identical predecessor —
		// the unknown key falls through untouched).
		const budgetCombinedError = enc2BudgetValidateCombined(body);
		if (budgetCombinedError !== null) {
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: budgetCombinedError }));
			return;
		}
		const embedder = body.embedder;
		if (embedder !== "ollama" && embedder !== "llama" && embedder !== "trigram" && embedder !== "custom" && embedder !== "onnx") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid_embedder" }));
			return;
		}
		const url = body.url;
		let resolvedUrl: string | null;
		let allowRemote = false;
		if (embedder === "ollama") resolvedUrl = typeof url === "string" && url ? url : OLLAMA_DEFAULT_URL;
		else if (embedder === "llama") resolvedUrl = typeof url === "string" && url ? url : LLAMA_DEFAULT_URL;
		else if (embedder === "onnx") resolvedUrl = typeof url === "string" && url ? url : ONNX_DEFAULT_URL;
		else if (embedder === "custom") {
			// Third-party / remote endpoint. Requires a URL; opts in to the
			// non-loopback allowlist so embeddingConfigFromEnv() accepts it.
			if (typeof url !== "string" || !url) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "custom_embedder_requires_url" }));
				return;
			}
			resolvedUrl = url;
			allowRemote = true;
		} else resolvedUrl = null;

		// Upsert-style write of the per-repo .mega-compact.env (sibling impl):
		// preserves ENC-1a's endpoint/key + ENC-1b's dim/headers lines and any
		// operator comments, replacing only the three keys this primary embedder
		// write owns (URL / ALLOW_REMOTE / MINILM).
		const stateDir = ctx.stateDir;
		let envPath: string;
		try {
			envPath = writeEmbedderEnv(stateDir, resolvedUrl, allowRemote);
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `write_failed: ${e instanceof Error ? e.message : String(e)}` }));
			return;
		}
		// ENC-1a: a combined payload (valid embedder + new keys) also upserts
		// the endpoint/key lines onto the freshly-written env file.
		if (wantsEnc1a(body)) {
			writeEnc1aEnv(stateDir, {
				endpointUrl:
					typeof body.embeddingEndpointUrl === "string" && body.embeddingEndpointUrl
						? body.embeddingEndpointUrl
						: null,
				apiKey: typeof body.embeddingApiKey === "string" ? body.embeddingApiKey : null,
			});
		}
		tryEnc1bInto(stateDir, body); // ENC-1b combined upsert (dim/headers/allow-remote/native)
		tryEnc2BudgetInto(stateDir, body); // ENC-2a combined upsert (native budget MiB)
		// Detect if the new config matches what's already active (no restart needed).
		const currentUrl = process.env["MEGACOMPACT_EMBEDDING_URL"];
		const alreadyActive = (resolvedUrl === null && !currentUrl) || (resolvedUrl !== null && currentUrl === resolvedUrl);
		const resp: SetupConfigureResponse = {
			embedder,
			url: resolvedUrl,
			envPath,
			restartRequired: !alreadyActive,
			alreadyActive,
		};
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(resp));
	});
	return true;
}

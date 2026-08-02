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

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: local subprocess detection only
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
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

function detectCurrentEmbedder(): SetupStatusResponse["currentEmbedder"] {
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
	};
	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
	return true;
}

// ---------------------------------------------------------------------------
// handleSetupDetect — "/api/setup-detect"
// ---------------------------------------------------------------------------

function detectOllama(): OllamaDetectResult | null {
	try {
		const version = spawnSync("ollama", ["--version"], {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (version.status !== 0) {
			return { installed: false, models: [], running: false, detail: version.stderr?.trim() || "not found" };
		}
		// Check for running server
		let running = false;
		let models: string[] = [];
		try {
			const listResult = spawnSync("ollama", ["list"], {
				timeout: 5000,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (listResult.status === 0) {
				running = true;
				// Parse lines: NAME  ID  SIZE  MODIFIED
				const lines = listResult.stdout?.split("\n") ?? [];
				for (const line of lines) {
					const name = line.split(/\s+/)[0];
					if (name && name !== "NAME") models.push(name);
				}
			}
		} catch {
			// ollama list failed — server may not be running
			running = false;
		}
		return {
			installed: true,
			models,
			running,
			detail: version.stdout?.trim() || null,
		};
	} catch {
		return { installed: false, models: [], running: false, detail: "detection error" };
	}
}

function detectLlamaCpp(): DetectResult | null {
	try {
		const which = spawnSync("which", ["llama-server", "llama.cpp"], {
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const installed = which.status === 0 && which.stdout.trim().length > 0;
		return {
			installed,
			detail: installed ? which.stdout.trim() : null,
		};
	} catch {
		return { installed: false, detail: "detection error" };
	}
}

function detectOnnx(): DetectResult | null {
	try {
		// Check for onnxruntime-node in a parent node_modules
		const req = createRequire(import.meta.url);
		try {
			req.resolve("onnxruntime-node");
			return { installed: true, detail: "onnxruntime-node found in node_modules" };
		} catch {
			return { installed: false, detail: "onnxruntime-node not found in node_modules" };
		}
	} catch {
		return { installed: false, detail: "detection error" };
	}
}

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

	try {
		ollama = detectOllama();
	} catch (e) {
		error = `ollama detection failed: ${e instanceof Error ? e.message : String(e)}`;
	}

	try {
		llamaCpp = detectLlamaCpp();
	} catch (e) {
		error = error ?? `llama.cpp detection failed: ${e instanceof Error ? e.message : String(e)}`;
	}

	try {
		onnx = detectOnnx();
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
		const embedder = body.embedder;
		if (embedder !== "ollama" && embedder !== "llama" && embedder !== "trigram" && embedder !== "custom") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid_embedder" }));
			return;
		}
		const url = body.url;
		let resolvedUrl: string | null;
		let allowRemote = false;
		if (embedder === "ollama") resolvedUrl = typeof url === "string" && url ? url : OLLAMA_DEFAULT_URL;
		else if (embedder === "llama") resolvedUrl = typeof url === "string" && url ? url : LLAMA_DEFAULT_URL;
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

		// Write .mega-compact.env to the state dir (loaded by env-loader at next startup).
		const stateDir = ctx.stateDir;
		const envPath = join(stateDir, ".mega-compact.env");
		const lines: string[] = [
			"# Mega-Compact Embedder Configuration",
			`# Configured via dashboard Setup tab at ${new Date().toISOString()}`,
		];
		if (resolvedUrl) {
			lines.push(`export MEGACOMPACT_EMBEDDING_URL="${resolvedUrl}"`);
			if (allowRemote) {
				lines.push(`export MEGACOMPACT_ALLOW_REMOTE_EMBEDDER="1"`);
			} else {
				lines.push(`# MEGACOMPACT_ALLOW_REMOTE_EMBEDDER not set (loopback-only)`);
			}
		} else {
			lines.push("# trigram: built-in embedder, no URL needed");
			lines.push("# unset MEGACOMPACT_EMBEDDING_URL (commented to override any shell-set value)");
			lines.push("# export MEGACOMPACT_EMBEDDING_URL=");
			lines.push("# export MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=");
		}
		lines.push("");
		try {
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(envPath, lines.join("\n"), "utf-8");
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `write_failed: ${e instanceof Error ? e.message : String(e)}` }));
			return;
		}
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

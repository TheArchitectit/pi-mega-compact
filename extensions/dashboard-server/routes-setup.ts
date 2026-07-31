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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import type {
	SetupStatusResponse,
	SetupDetectResponse,
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

export function handleSetupStatus(
	req: IncomingMessage,
	res: ServerResponse,
	_ctx: RouteContext,
): boolean {
	if (req.url !== "/api/setup-status") return false;
	if (req.method !== "GET") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	const body: SetupStatusResponse = {
		currentEmbedder: detectCurrentEmbedder(),
		embeddingUrl: process.env["MEGACOMPACT_EMBEDDING_URL"] ?? null,
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

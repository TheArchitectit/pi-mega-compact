/**
 * dashboard-server/routes-setup-enc1a.ts — ENC-1a external-embedder Settings
 * read/write + the additive writer branch.
 *
 * Extracted out of routes-setup.ts (which hovers at the 300-line source soft
 * cap) so the ENC-1a additive read/write of the per-repo `.mega-compact.env`
 * keys AND the pure external-embedder configure branch live in a sibling impl
 * file. The two keys are `MEGACOMPACT_EMBEDDING_URL` and
 * `MEGACOMPACT_EMBEDDING_KEY` — the exact names `embeddingConfigFromEnv`
 * (src/httpEmbedder.ts) reads at runtime.
 *
 * The write is create-or-append: it upserts the two keys into the existing
 * per-repo `.mega-compact.env`, preserving every unrelated line and never
 * deleting other keys. The read reports the endpoint URL (echoed) and an
 * `apiKeySet` boolean ONLY — the raw API key is never returned, logged, or
 * emitted (redaction invariant).
 *
 * Guardrails: PREVENT-PI-004 (local filesystem writes only, zero network),
 * PREVENT-001 (null-safe JSON), PREVENT-011 (no `any`).
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { ENC_1A_ENABLED } from "../../src/config.js";
import type {
	SetupConfigureRequest,
	SetupConfigureResponse,
} from "./api-contracts/setup.js";

const URL_KEY = "MEGACOMPACT_EMBEDDING_URL";
const API_KEY = "MEGACOMPACT_EMBEDDING_KEY";

function envPath(stateDir: string): string {
	return join(stateDir, ".mega-compact.env");
}

/** Extract the value of `export MEGACOMPACT_X="..."` (or unquoted) from a line. */
function lineValue(line: string, key: string): string | null {
	const m = line.match(new RegExp(`^export\\s+${key}=(.*)$`));
	if (!m) return null;
	const rest = m[1].trim();
	const q = rest.match(/^"([^"]*)"$/);
	return q ? q[1] : rest;
}

/** True when the payload carries the ENC-1a keys (flag-gated). */
export function wantsEnc1a(body: SetupConfigureRequest): boolean {
	return (
		ENC_1A_ENABLED() &&
		(typeof body.embeddingEndpointUrl === "string" ||
			typeof body.embeddingApiKey === "string")
	);
}

/** Additive GET status fields for ENC-1a (both omitted when flag-off): the
 *  endpoint URL (echoed) + an apiKeySet boolean (true/false) ONLY — never the
 *  raw key. The boolean is always present when the flag is on so an absent key
 *  is reported as `embeddingApiKeySet:false` (non-fatal, triad B). */
export function enc1aStatusFields(stateDir: string): {
	embeddingEndpointUrl?: string;
	embeddingApiKeySet?: boolean;
} {
	if (!ENC_1A_ENABLED()) return {};
	const enc1a = readEnc1aEnv(stateDir);
	return {
		...(enc1a.endpointUrl !== null ? { embeddingEndpointUrl: enc1a.endpointUrl } : {}),
		embeddingApiKeySet: enc1a.apiKeySet,
	};
}

/** Read the ENC-1a keys from the per-repo `.mega-compact.env` (never the key
 *  itself to callers — only its presence). */
export function readEnc1aEnv(stateDir: string): {
	endpointUrl: string | null;
	apiKeySet: boolean;
} {
	try {
		const p = envPath(stateDir);
		if (!existsSync(p)) return { endpointUrl: null, apiKeySet: false };
		const content = readFileSync(p, "utf8");
		const lines = content.split(/\r?\n/);
		let endpointUrl: string | null = null;
		let apiKeySet = false;
		for (const line of lines) {
			const url = lineValue(line, URL_KEY);
			if (url !== null) endpointUrl = url;
			const key = lineValue(line, API_KEY);
			if (key !== null && key.length > 0) apiKeySet = true;
		}
		return { endpointUrl, apiKeySet };
	} catch {
		return { endpointUrl: null, apiKeySet: false };
	}
}

/** Upsert the ENC-1a keys into the per-repo `.mega-compact.env`. Creates the
 *  file if absent; preserves every unrelated line; never deletes other keys.
 *  Passing `null` for a key leaves that line untouched. */
export function writeEnc1aEnv(
	stateDir: string,
	entries: { endpointUrl?: string | null; apiKey?: string | null },
): string {
	const p = envPath(stateDir);
	const existingLines: string[] = existsSync(p)
		? readFileSync(p, "utf8").split(/\r?\n/)
		: [];
	const out: string[] = [];
	let urlWritten = false;
	let keyWritten = false;
	for (const line of existingLines) {
		if (entries.endpointUrl !== null && lineValue(line, URL_KEY) !== null) {
			out.push(`export ${URL_KEY}="${entries.endpointUrl ?? ""}"`);
			urlWritten = true;
			continue;
		}
		if (entries.apiKey !== null && lineValue(line, API_KEY) !== null) {
			out.push(`export ${API_KEY}="${entries.apiKey ?? ""}"`);
			keyWritten = true;
			continue;
		}
		out.push(line);
	}
	if (entries.endpointUrl !== null && !urlWritten) {
		out.push(`export ${URL_KEY}="${entries.endpointUrl}"`);
	}
	if (entries.apiKey !== null && !keyWritten) {
		out.push(`export ${API_KEY}="${entries.apiKey ?? ""}"`);
	}
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(p, out.join("\n"), "utf-8");
	return p;
}

/** If the payload is a pure ENC-1a configure (new keys, no valid embedder
 *  selection), write them additively to the per-repo env and reply. Returns
 *  true when it fully handled the request. */
export function tryEnc1aConfigure(
	body: SetupConfigureRequest,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!wantsEnc1a(body)) return false;
	const embedder = body.embedder;
	const embedderValid =
		!!embedder &&
		(embedder === "ollama" || embedder === "llama" || embedder === "trigram" ||
			embedder === "custom" || embedder === "onnx");
	if (embedderValid) return false; // combined payload — integrated after the embedder write
	try {
		const envPath = writeEnc1aEnv(ctx.stateDir, {
			endpointUrl:
				typeof body.embeddingEndpointUrl === "string" && body.embeddingEndpointUrl
					? body.embeddingEndpointUrl
					: null,
			apiKey: typeof body.embeddingApiKey === "string" ? body.embeddingApiKey : null,
		});
		const currentUrl = process.env["MEGACOMPACT_EMBEDDING_URL"];
		const alreadyActive =
			typeof body.embeddingEndpointUrl === "string" &&
			currentUrl === body.embeddingEndpointUrl;
		const resp: SetupConfigureResponse = {
			embedder: "custom",
			url:
				typeof body.embeddingEndpointUrl === "string"
					? body.embeddingEndpointUrl
					: null,
			envPath,
			restartRequired: !alreadyActive,
			alreadyActive,
		};
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(resp));
		return true;
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ error: `write_failed: ${e instanceof Error ? e.message : String(e)}` }),
		);
		return true;
	}
}

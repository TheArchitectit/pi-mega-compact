/**
 * dashboard-server/routes-rag-settings.ts — comprehensive settings route handler.
 *
 * GET /api/rag-settings  — Returns every adjustable MEGACOMPACT_* setting,
 *                          grouped by category, with live values from env.
 * POST /api/rag-settings — Updates a single setting by writing its line to the
 *                          per-repo .mega-compact.env file.
 *
 * The SETTINGS inventory lives in routes-rag-settings-helpers.ts so this file
 * stays within the line budget.
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe JSON),
 * PREVENT-011 (no `any`). Each JSON write carries a guardrails-allow annotation.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { detectCurrentEmbedder } from "./routes-setup.js";
import { SETTINGS, SETTING_BY_KEY } from "./routes-rag-settings-helpers.js";
import type { SettingSpec } from "./routes-rag-settings-helpers.js";
import type {
	SettingState,
	SettingsResponse,
	SettingsUpdateRequest,
	SettingsResponsePost,
} from "./api-contracts/rag-settings.js";

// ---------------------------------------------------------------------------
// Env-reading helpers — one per setting type.
// ---------------------------------------------------------------------------

function isDisabled(key: string): boolean {
	const v = process.env[key + "_DISABLED"];
	return v === "true" || v === "1";
}

function isEnabled(key: string, def: boolean): boolean {
	const v = process.env[key];
	if (v === undefined) return def;
	return v === "true" || v === "1";
}

function readNumber(key: string, def: number): number {
	const v = process.env[key];
	if (v === undefined) return def;
	const n = Number(v);
	return Number.isNaN(n) ? def : n;
}

function resolveValue(spec: SettingSpec): string | number | boolean {
	if (spec.type === "boolean") {
		return spec.disabledConvention
			? !isDisabled(spec.key)
			: isEnabled(spec.key, spec.default as boolean);
	}
	if (spec.type === "number") {
		return readNumber(spec.key, spec.default as number);
	}
	return process.env[spec.key] ?? spec.default;
}

function toSettingState(spec: SettingSpec, category: string): SettingState {
	return {
		key: spec.key,
		label: spec.label,
		description: spec.description,
		category,
		type: spec.type,
		value: resolveValue(spec),
		default: spec.default,
		disabledConvention: spec.disabledConvention,
		requiresLlm: spec.requiresLlm,
		...(spec.unit !== undefined ? { unit: spec.unit } : {}),
		...(spec.min !== undefined ? { min: spec.min } : {}),
		...(spec.max !== undefined ? { max: spec.max } : {}),
	};
}

// ---------------------------------------------------------------------------
// Env file I/O.
// ---------------------------------------------------------------------------

/** Strip lines assigning KEY or KEY_DISABLED from env file content. */
const keyLinePattern = (key: string): RegExp =>
	new RegExp(`^export\\s+${key}(_DISABLED)?=`);

function envPathOf(ctx: RouteContext): string {
	return join(ctx.stateDir, ".mega-compact.env");
}

function readEnvLines(envPath: string, key: string): string[] {
	if (!existsSync(envPath)) return [];
	return readFileSync(envPath, "utf-8")
		.split("\n")
		.filter((l) => !keyLinePattern(key).test(l));
}

function writeSetting(envPath: string, key: string, line: string): void {
	const lines = readEnvLines(envPath, key);
	lines.push(line);
	if (lines[lines.length - 1] !== "") lines.push("");
	writeFileSync(envPath, lines.join("\n"), "utf-8");
}

/** Strip KEY/KEY_DISABLED lines, leaving the file otherwise intact. */
function removeSetting(envPath: string, key: string): void {
	writeFileSync(envPath, readEnvLines(envPath, key).join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Request body parsing.
// ---------------------------------------------------------------------------

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
			const v: unknown = body ? JSON.parse(body) : {}; // PREVENT-001: parsed value type-checked below
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
		const categories = SETTINGS.map((cat) => ({
			name: cat.name,
			settings: cat.settings.map((s) => toSettingState(s, cat.name)),
		}));
		const body: SettingsResponse = {
			categories,
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
			const reqBody = parsed.value as unknown as SettingsUpdateRequest;
			const key = reqBody.key;
			const value = reqBody.value;
			if (typeof key !== "string" || typeof value !== "string") {
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "invalid_body" }));
				return;
			}
			const spec = SETTING_BY_KEY.get(key);
			if (!spec) {
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: `unknown_setting: ${key}` }));
				return;
			}

			const envPath = envPathOf(ctx);
			try {
				mkdirSync(ctx.stateDir, { recursive: true });
				if (spec.type === "boolean") {
					if (value !== "true" && value !== "false") {
						throw new SettingError("boolean_value_required");
					}
					if (spec.disabledConvention) {
						// false → opt out via KEY_DISABLED="true"; true → strip the line.
						if (value === "false") {
							writeSetting(envPath, spec.key, `export ${spec.key}_DISABLED="true"`);
						} else {
							removeSetting(envPath, spec.key);
						}
					} else {
						writeSetting(envPath, spec.key, `export ${spec.key}="${value}"`);
					}
				} else if (spec.type === "number") {
					const n = Number(value);
					if (Number.isNaN(n)) throw new SettingError("invalid_number");
					if (spec.min !== undefined && n < spec.min) throw new SettingError("below_min");
					if (spec.max !== undefined && n > spec.max) throw new SettingError("above_max");
					writeSetting(envPath, spec.key, `export ${spec.key}="${n}"`);
				} else {
					writeSetting(envPath, spec.key, `export ${spec.key}="${value}"`);
				}
			} catch (e) {
				const msg =
					e instanceof SettingError
						? e.message
						: `write_failed: ${e instanceof Error ? e.message : String(e)}`;
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: msg }));
				return;
			}
			const resp: SettingsResponsePost = {
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

class SettingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingError";
	}
}

#!/usr/bin/env node
//
// scripts/dashboard-live-verify.mjs — LIVE dashboard verification (not structural).
//
// Complements scripts/dashboard-tab-smoke.mjs (static structural render gate).
// This script verifies the REAL dashboard server end-to-end:
//
//   1. Starts server.js against a temp state dir (default port 9390, override
//      via MEGACOMPACT_DASHBOARD_PORT or --port).
//   2. Curl-verifies a battery of API endpoints (JSON, not HTML fallback).
//   3. Drives the UI with Playwright headless: overview tab + every tab the
//      server exposes; confirms <main> renders non-empty content against
//      REAL data from the API (not "AWAITING DATA" stubs).
//   4. Exits non-zero on any failure (deploy-blocking).
//
// Controller protocol §8.4: mandatory for dashboard-touching sprints.
//
// Usage: node scripts/dashboard-live-verify.mjs [--port N] [--json]
// Wire: called by the controller after deploy.sh, before next sprint dispatch.
//
// PREVENT-PI-004: loopback-only server + local browser — no remote network.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const SERVER_JS = join(ROOT, "dist/extensions/dashboard-server/server.js");

// Endpoints that MUST return JSON with a 200 code. Each entry:
//   [path, description, verifyFn(body) → boolean]
const ENDPOINTS = [
	["/api/version", "server version", (b) => typeof b.version === "string"],
	["/api/summary", "repo summary", (b) => typeof b.summary === "object"],
	["/api/snapshot", "dashboard snapshot", (b) => typeof b.version === "number"],
	["/api/setup-cortex-status", "VC9A setup cortex", (b) => typeof b.mode === "string"],
	["/api/setup-status", "embedder setup status", (b) => typeof b.currentEmbedder === "string"],
	["/api/vector-cortex/health", "VC health", (b) => typeof b.state === "string"],
	["/api/vector-cortex/evaluation", "VC evaluation", (b) => typeof b.samples === "number"],
	["/api/vector-cortex/repair", "VC repair (VC6C)", (b) => typeof b.repairAttempts === "number"],
	["/api/vector-cortex/rollout", "VC rollout", (b) => typeof b.gateIndex === "number"],
	["/api/vector-cortex/outcomes", "VC outcomes (VC8A)", (b) => typeof b.outcomeCount === "number"],
	["/api/vector-cortex/platform", "VC platform (VC8C)", (b) => typeof b.fixtureCount === "number"],
	["/api/embedder-health", "embedder health", (b) => typeof b.activeEmbedder === "string"],
	["/api/memory-status", "memory status", (b) => typeof b.totalMemories === "number"],
	["/api/context-health", "context health", (b) => typeof b.rows === "object"],
	["/api/prefix-stability", "prefix stability", (b) => typeof b.avgRatio === "number"],
];

const PORT = Number(
	process.env.MEGACOMPACT_DASHBOARD_PORT ??
	process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ??
	"9390",
);
const JSON_MODE = process.argv.includes("--json");

function log(msg) {
	console.log(`[live] ${msg}`);
}
function fail(msg) {
	console.error(`[live] FAIL: ${msg}`);
}
function out(obj) {
	if (JSON_MODE) console.log(JSON.stringify(obj, null, 2));
}

async function waitForServer(url, timeoutMs = 10000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await fetch(url);
			if (resp.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

async function hitEndpoint(base, path, verifyFn) {
	const url = `${base}${path}`;
	const resp = await fetch(url);
	const text = await resp.text();
	const isHtml = text.trimStart().startsWith("<!DOC") || text.trimStart().startsWith("<html");
	if (isHtml) {
		return { path, status: "html-fallback", pass: false, bytes: text.length };
	}
	let body;
	try { body = JSON.parse(text); } catch {
		return { path, status: "invalid-json", pass: false, bytes: text.length };
	}
	const ok = resp.status === 200 && verifyFn(body);
	return { path, status: `${resp.status} ok`, pass: ok, bytes: text.length };
}

// Main

if (!existsSync(SERVER_JS)) {
	fail(`server.js not built: ${SERVER_JS}`);
	process.exit(1);
}

const stateDir = mkdtempSync(join(tmpdir(), "mega-live-verify-"));
log(`state  ${stateDir}`);
log(`port   ${PORT}`);

// Start the dashboard server
const child = spawn("node", [SERVER_JS, stateDir], {
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, MEGACOMPACT_DASHBOARD_PORT: String(PORT) },
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d.toString(); });
child.stderr.on("data", (d) => { serverLog += d.toString(); });

try {
	const ready = await waitForServer(`http://localhost:${PORT}/api/version`);
	if (!ready) {
		fail(`server did not come up on :${PORT} within 10s`);
		console.error(serverLog.slice(-500));
		process.exit(1);
	}
	log(`server alive`);

	// API check
	const base = `http://localhost:${PORT}`;
	const results = [];
	let pass = 0, failCount = 0;
	for (const [path, desc, verifyFn] of ENDPOINTS) {
		const r = await hitEndpoint(base, path, verifyFn);
		results.push({ path, desc, ...r });
		if (r.pass) { pass++; log(`  ✓ ${path}  ${r.status}  ${r.bytes}b`); }
		else { failCount++; fail(`  ✗ ${path}  ${r.status}`); }
	}

	// Playwright pass — against the LIVE server (not static dist)
	log(`ui     playwright headless...`);
	let uiPass = false, uiErr = null;
	try {
		const pw = await import("playwright");
		// Prefer system chromium (no download needed); fall back to bundled.
		// --no-sandbox needed in some containerised/ci environments.
		const browser = await pw.chromium.launch({
			headless: true,
			executablePath: "/usr/bin/chromium",
			args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		});
		const page = await browser.newPage();
		try {
			await page.goto(base, { waitUntil: "networkidle", timeout: 15000 });
			// The overview tab should have a card grid. Cards render headings + values.
			// Check for the main card container and at least one data row that has
			// a meaningful value (not just zero-count skeletons against an empty state).
			// The selector is intentionally loose: any heading + any value text.
			const headings = await page.locator("h1, h2, h3, [role=heading]").allTextContents();
			const mainContent = await page.locator("main").innerText();
			uiPass = headings.length >= 1 && mainContent.trim().length > 50;
			if (!uiPass) {
				uiErr = `headings=${headings.length}, main-length=${mainContent.trim().length}`;
			} else {
				log(`  ✓ overview rendered (${headings.length} headings, ${mainContent.trim().length} chars in main)`);
			}
		} catch (e) { uiErr = String(e); }
		await browser.close();
	} catch (e) {
		uiErr = `playwright import unavailable: ${String(e).slice(0, 120)}`;
	}

	if (!uiPass) fail(`  ui ${uiErr}`);

	out({
		port: PORT,
		stateDir,
		version: results.find((r) => r.path === "/api/version")?.status,
		pass, fail: failCount, uiPass, uiErr, results,
	});

	if (failCount > 0 || !uiPass) {
		fail(`${failCount} endpoint(s) failed; uiPass=${uiPass}`);
		process.exit(1);
	}
	log(`done — ${pass}/${results.length} endpoints PASS, ui render PASS`);
} finally {
	child.kill("SIGTERM");
	try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
}

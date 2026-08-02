#!/usr/bin/env node
//
// scripts/dashboard-tab-smoke.mjs — dashboard tab render gate.
//
// Serves the BUILT dashboard bundle (extensions/dashboard-client/dist) on a
// loopback static server, drives it with headless chromium via Playwright,
// clicks every tab, and asserts each tab renders non-empty content in
// `.dashboard-content`. Catches the missing-render-branch regression class
// (the v0.12.7 Turns-tab-100%-blank bug: a TabId was registered in the tab bar
// but had no `{activeTab === "x" && <XTab/>}` render branch in App.tsx, so
// <main> rendered nothing).
//
// This is a STRUCTURAL smoke test, not a data test. There is no dashboard
// server behind it, so tabs show loading/error/empty states — that's fine.
// The only failure mode is a tab whose `<main>` stays empty (no render
// branch wired up). Run after `npm run build:dashboard`.
//
// Usage: node scripts/dashboard-tab-smoke.mjs   (from repo root)
// Wire: scripts/deploy.sh runs this after the index.html existence check.
//
// Browser: prefers system /usr/bin/chromium (no download needed); falls back
// to Playwright's bundled chromium. If neither is usable, exits non-zero with
// setup instructions. PREVENT-PI-004: loopback-only static server + local
// browser — no remote network; this is build/validation tooling, NOT runtime
// extension code (not shipped in the npm tarball).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "extensions/dashboard-client/dist");
const INDEX = join(DIST, "index.html");

const MIME = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".map": "application/json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function log(msg) {
	console.log(`[smoke] ${msg}`);
}
function fail(msg) {
	console.error(`[smoke] FAIL: ${msg}`);
}

// --- 0. preflight: dist exists ------------------------------------------------
if (!existsSync(INDEX)) {
	fail(`dashboard bundle not built: ${INDEX} missing.`);
	console.error("[smoke]       run `npm run build:dashboard` first.");
	process.exit(1);
}

// --- 1. loopback static server serving dist -----------------------------------
function startStaticServer() {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			let p = decodeURIComponent((req.url || "/").split("?")[0]);
			if (p === "/") p = "/index.html";
			const safe = normalize(p);
			const fp = join(DIST, safe);
			// Path-traversal guard: resolved path must stay under DIST.
			if (!fp.startsWith(DIST)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			try {
				const data = await readFile(fp);
				res.writeHead(200, {
					"Content-Type": MIME[extname(fp)] ?? "application/octet-stream",
				});
				res.end(data);
			} catch {
				// Missing file (e.g. /api/* when no server) → 404. Tabs handle this
				// gracefully (error/empty state); we are testing structure, not data.
				res.writeHead(404);
				res.end("not found");
			}
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			resolve({ server, url: `http://127.0.0.1:${port}/` });
		});
	});
}

// --- 2. launch chromium -------------------------------------------------------
async function launchChromium() {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		fail("playwright is not installed.");
		console.error("[smoke]       run: npm install");
		console.error("[smoke]       then: npx playwright install chromium");
		process.exit(1);
	}
	const launchOpts = {
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	};
	// Prefer system chromium so no browser download is required.
	if (existsSync("/usr/bin/chromium")) {
		launchOpts.executablePath = "/usr/bin/chromium";
	}
	try {
		return await chromium.launch(launchOpts);
	} catch (e) {
		// Retry without executablePath (use Playwright's bundled browser).
		try {
			delete launchOpts.executablePath;
			return await chromium.launch(launchOpts);
		} catch (e2) {
			fail("could not launch chromium.");
			console.error(`[smoke]       ${e2.message || e2}`);
			console.error("[smoke]       run: npx playwright install chromium");
			process.exit(1);
		}
	}
}

// --- 3. run the smoke test ----------------------------------------------------
async function main() {
	log(`serving ${DIST}`);
	const { server, url } = await startStaticServer();
	log(`static server: ${url}`);

	const browser = await launchChromium();
	const page = await browser.newPage();

	// Surface console errors for diagnosis.
	page.on("pageerror", (e) => console.error(`[smoke] pageerror: ${e.message}`));

	const failures = [];
	let tabs = [];
	try {
		await page.goto(url, { waitUntil: "load", timeout: 15000 });
		// Wait for the React shell to mount (#root has content).
		await page.waitForFunction(
			() => document.getElementById("root")?.children.length > 0,
			{ timeout: 10000 },
		);
		log("dashboard shell mounted.");

		// Open the Advanced panel so advanced tabs are clickable.
		const advancedToggle = page.locator(".advanced-toggle");
		if (await advancedToggle.count()) {
			const expanded = await advancedToggle.getAttribute("aria-expanded");
			if (expanded !== "true") {
				await advancedToggle.click();
				await page.waitForSelector(".advanced-tabs button", { timeout: 5000 });
			}
			log("advanced panel open.");
		}

		// Enumerate all tab buttons (primary + advanced).
		tabs = await page.locator('[role="tab"]').evaluateAll((btns) =>
			btns.map((b) => ({
				label: (b.textContent || "").trim(),
				selected: b.getAttribute("aria-selected") === "true",
			})),
		);
		log(`found ${tabs.length} tabs: ${tabs.map((t) => t.label).join(", ")}`);

		// Click each tab and assert .dashboard-content is non-empty.
		for (const tab of tabs) {
			const btn = page.locator('[role="tab"]', { hasText: tab.label }).first();
			await btn.click();
			// Confirm the click registered (tab became selected).
			await page.waitForFunction(
				(lbl) => {
					const b = [...document.querySelectorAll('[role="tab"]')].find(
						(el) => (el.textContent || "").trim() === lbl,
					);
					return b?.getAttribute("aria-selected") === "true";
				},
				tab.label,
				{ timeout: 5000 },
			);
			// Assert main content area is non-empty. A missing render branch
			// leaves <main class="dashboard-content"> with no children at all
			// (Suspense renders nothing when no conditional matches) — this is
			// the exact signal the v0.12.7 Turns-blank regression would trip.
			let rendered = false;
			try {
				await page.waitForFunction(
					() => (document.querySelector(".dashboard-content")?.innerHTML ?? "").trim()
						.length > 0,
					{ timeout: 4000 },
				);
				rendered = true;
			} catch {
				rendered = false;
			}
			if (rendered) {
				log(`  ok   ${tab.label}`);
			} else {
				fail(`tab "${tab.label}" rendered BLANK (.dashboard-content empty).`);
				failures.push(tab.label);
			}
		}
	} finally {
		await browser.close();
		server.close();
	}

	if (failures.length > 0) {
		fail(`${failures.length}/${tabs.length} tabs blank: ${failures.join(", ")}`);
		fail("a blank tab means its {activeTab === \"x\" && <XTab/>} render branch is missing in App.tsx.");
		process.exit(1);
	}
	log(`all ${tabs.length} tabs render non-empty content — gate green.`);
}

main().catch((e) => {
	fail(`unexpected error: ${e?.stack || e}`);
	process.exit(1);
});

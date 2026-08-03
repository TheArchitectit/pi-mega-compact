#!/usr/bin/env node
//
// scripts/dashboard-tab-smoke.mjs — dashboard tab render gate.
//
// Serves the BUILT dashboard bundle (extensions/dashboard-client/dist) on a
// loopback static server, drives it with headless chromium via Playwright,
// clicks every tab, and asserts each tab renders non-empty content.
// Catches the missing-render-branch regression class
// (the v0.12.7 Turns-tab-100%-blank bug: a TabId was registered in the tab bar
// but had no `{activeTab === "x" && <XTab/>}` render branch in App.tsx, so
// <main> rendered nothing).
//
// Handles both layouts:
//   - OldDashboard (NEW_UI off): TabBar with [role="tab"] + .dashboard-content
//   - NewDashboard (NEW_UI on, default): Sidebar with aria-current + plain <main>
//
// This is a STRUCTURAL smoke test, not a data test. There is no dashboard
// server behind it, so tabs show loading/error/empty states — that's fine.
// The only failure mode is a tab whose content area stays empty (no render
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
	} catch {
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

// --- 3. detect layout mode ----------------------------------------------------
// Returns "old" (TabBar/[role=tab]/.dashboard-content) or "new" (Sidebar/aria-current/<main>).
async function detectLayout(page) {
	const tabBarCount = await page.locator('[role="tab"]').count();
	if (tabBarCount > 0) return "old";
	// NewDashboard sidebar uses <aside class="glass-panel">; check for it or bottom bar.
	const sidebarCount = await page.locator("aside.glass-panel").count();
	if (sidebarCount > 0) return "new";
	// Check if any tab-like buttons exist with aria-current (BottomBar for mobile).
	const bottomBarCount = await page.locator("nav.glass-panel").count();
	if (bottomBarCount > 0) return "new";
	return "old";
}

// --- 4. enumerate tabs for each layout -----------------------------------------
async function enumerateOldTabs(page) {
	// Open the Advanced panel so advanced tabs are clickable.
	const advancedToggle = page.locator(".advanced-toggle");
	if ((await advancedToggle.count()) > 0) {
		const expanded = await advancedToggle.getAttribute("aria-expanded");
		if (expanded !== "true") {
			await advancedToggle.click();
			await page.waitForSelector(".advanced-tabs button", { timeout: 5000 });
		}
		log("advanced panel open.");
	}
	return page.locator('[role="tab"]').evaluateAll((btns) =>
		btns.map((b) => ({
			label: (b.textContent || "").trim(),
			selected: b.getAttribute("aria-selected") === "true",
		})),
	);
}

async function enumerateNewTabs(page) {
	// Sidebar: get all <button> inside <aside> that have visible text (tab labels).
	// The advanced toggle in Sidebar is a <button> with text "Advanced" — open it first.
	const advBtn = page.locator("aside button", { hasText: "Advanced" });
	if ((await advBtn.count()) > 0) {
		const expanded = await advBtn.getAttribute("aria-expanded");
		if (expanded !== "true") {
			await advBtn.click();
			// Wait for the advanced section to appear.
			await page.waitForSelector("#sidebar-advanced-section", { timeout: 5000 });
		}
		log("sidebar advanced section open.");
	}
	// Collect all sidebar tab buttons. Exclude the "Advanced" toggle itself
	// (it has aria-controls="sidebar-advanced-section").
	const sidebarTabs = await page.locator("aside button").evaluateAll((btns) =>
		btns
			.filter((b) => !b.hasAttribute("aria-expanded"))
			.map((b) => ({
				label: (b.textContent || "").trim().replace(/\s*●\s*$/, ""),
				selected: b.getAttribute("aria-current") === "page",
			})),
	);
	// BottomBar is hidden on desktop (lg:hidden) but may also exist — merge
	// labels from both sources, deduplicating.
	const bottomTabs = await page.locator("nav.glass-panel button").evaluateAll((btns) =>
		btns
			.filter((b) => !b.hasAttribute("aria-expanded") && (b.textContent || "").trim() !== "More")
			.map((b) => ({
				label: (b.textContent || "").trim(),
				selected: b.getAttribute("aria-current") === "page",
			})),
	);
	const seen = new Set();
	const merged = [];
	for (const t of [...sidebarTabs, ...bottomTabs]) {
		if (!seen.has(t.label)) {
			seen.add(t.label);
			merged.push(t);
		}
	}
	return merged;
}

// --- 5. click + verify a tab in each layout ------------------------------------
async function clickOldTab(page, label) {
	const btn = page.locator('[role="tab"]', { hasText: label }).first();
	await btn.click();
	await page.waitForFunction(
		(lbl) => {
			const b = [...document.querySelectorAll('[role="tab"]')].find(
				(el) => (el.textContent || "").trim() === lbl,
			);
			return b?.getAttribute("aria-selected") === "true";
		},
		label,
		{ timeout: 5000 },
	);
}

async function clickNewTab(page, label) {
	// Try sidebar first; fall back to bottom bar (scrollable "More" section).
	let btn = page.locator("aside button", { hasText: label }).first();
	if ((await btn.count()) === 0) {
		// Open the "More" dropdown if it exists.
		const moreBtn = page.locator("nav.glass-panel button", { hasText: "More" });
		if ((await moreBtn.count()) > 0) {
			await moreBtn.click();
			await page.waitForSelector("#bottombar-more-section", { timeout: 3000 });
			btn = page.locator("#bottombar-more-section button", { hasText: label }).first();
		}
	}
	await btn.click();
	// Confirm the click registered (tab became current).
	await page.waitForFunction(
		(lbl) => {
			const btns = [
				...document.querySelectorAll("aside button"),
				...document.querySelectorAll("nav.glass-panel button"),
			];
			const b = btns.find(
				(el) => (el.textContent || "").trim().replace(/\s*●\s*$/, "") === lbl,
			);
			return b?.getAttribute("aria-current") === "page";
		},
		label,
		{ timeout: 5000 },
	);
}

async function assertContentNonEmpty(page, layout) {
	const selector = layout === "old" ? ".dashboard-content" : "main";
	let rendered = false;
	try {
		await page.waitForFunction(
			(sel) =>
				(document.querySelector(sel)?.innerHTML ?? "").trim().length > 0,
			selector,
			{ timeout: 4000 },
		);
		rendered = true;
	} catch {
		rendered = false;
	}
	return rendered;
}

// --- 6. run the smoke test ----------------------------------------------------
async function main() {
	log(`serving ${DIST}`);
	const { server, url } = await startStaticServer();
	log(`static server: ${url}`);

	const browser = await launchChromium();
	// Use a desktop viewport so the sidebar is visible (sidebar is hidden below lg).
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

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

		const layout = await detectLayout(page);
		log(`layout: ${layout}`);

		tabs = layout === "old" ? await enumerateOldTabs(page) : await enumerateNewTabs(page);
		log(`found ${tabs.length} tabs: ${tabs.map((t) => t.label).join(", ")}`);

		if (tabs.length === 0) {
			fail("no tabs found — layout detection may be broken.");
			process.exit(1);
		}

		for (const tab of tabs) {
			if (layout === "old") {
				await clickOldTab(page, tab.label);
			} else {
				await clickNewTab(page, tab.label);
			}
			const rendered = await assertContentNonEmpty(page, layout);
			if (rendered) {
				log(`  ok   ${tab.label}`);
			} else {
				fail(
					`tab "${tab.label}" rendered BLANK (${layout === "old" ? ".dashboard-content" : "<main>"} empty).`,
				);
				failures.push(tab.label);
			}
		}
	} finally {
		await browser.close();
		server.close();
	}

	if (failures.length > 0) {
		fail(`${failures.length}/${tabs.length} tabs blank: ${failures.join(", ")}`);
		fail('a blank tab means its {activeTab === "x" && <XTab/>} render branch is missing in App.tsx.');
		process.exit(1);
	}
	log(`all ${tabs.length} tabs render non-empty content — gate green.`);
}

main().catch((e) => {
	fail(`unexpected error: ${e?.stack || e}`);
	process.exit(1);
});

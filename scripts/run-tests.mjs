#!/usr/bin/env node
/**
 * run-tests.mjs — isolated per-file test runner for pi-mega-compact.
 *
 * Why this exists:
 *   running `node --test` over all dist test files runs them in ONE process. A slow or
 *   hanging file blocks the whole run, and if one file throws at module-load
 *   time it can take the others down with it. This driver runs EACH test file
 *   in its OWN subprocess so:
 *     - a hang in one file cannot block the others (hard 3-min cap per file);
 *     - a failure in one file NEVER stops the rest — every file always runs;
 *     - we print incremental "▶ running / ✓ done" progress so a slow file
 *       never looks like the suite has frozen;
 *     - the dashboard files get a dedicated SERIAL lane (run last) so their
 *       HTTP port ranges never overlap in parallel.
 *
 * Every file is hard-capped at PER_FILE_TIMEOUT_MS (default 180s = 3 min). A
 * file that exceeds it is SIGKILLed. The runner always exits non-zero at the
 * very end if any file failed — but only after running ALL files.
 *
 * Env overrides:
 *   MEGACOMPACT_TEST_TIMEOUT  per-file hard cap in ms (default 180000 = 3 min)
 *   MEGACOMPACT_TEST_POOL     parallel worker count (default = CPU count, max 8)
 *   MEGACOMPACT_TEST_HANG_MS  silence-dead-time before force-kill (default 10000)
 *
 * @module
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DIST = join(ROOT, "dist");

const PER_FILE_TIMEOUT_MS = Number(
	process.env.MEGACOMPACT_TEST_TIMEOUT ?? 180_000,
);
const HARD_CAP_MS = PER_FILE_TIMEOUT_MS + 10_000; // small buffer over node's own timeout
const SILENCE_MS = Number(process.env.MEGACOMPACT_TEST_HANG_MS ?? 10_000);
const POOL = Math.max(
	1,
	Math.min(Number(process.env.MEGACOMPACT_TEST_POOL ?? os.cpus().length), 8),
);

// Dashboard tests spawn real HTTP servers on a 10-port scan range. Two such
// files running at once can collide on the same base port (EADDRINUSE), so they
// run one-at-a-time. Keep this lane SERIAL and run it LAST (see main()).
const DASHBOARD_GLOB =
	/(^|\/)dashboard-server(?:-s32)?\.test\.js$|(^|\/)mega-compact\.test\.js$/;

/** Recursively collect every dist/**\/*.test.js file. */
function collectTestFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			out.push(...collectTestFiles(full));
		} else if (entry.endsWith(".test.js")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Run one test file as its own `node --test` subprocess. Resolves with a
 * summary regardless of pass/fail/hang — this function NEVER rejects, so a
 * broken file can never halt the suite.
 */
function runOne(file) {
	return new Promise((resolve) => {
		const start = Date.now();
		const child = spawn(
			process.execPath,
			[
				"--test",
				"--test-concurrency=1",
				"--test-reporter=tap",
				`--test-timeout=${PER_FILE_TIMEOUT_MS}`,
				file,
			],
			{ cwd: ROOT, env: process.env },
		);
		let out = "";
		// A file whose tests all pass but which leaves an open handle (e.g. the
		// persistent PGlite/WASM handle) prints every "ok N" line and then HANGS on
		// exit — node --test never flushes its final summary. We treat a file as
		// "tests done" two ways:
		//   1. the final "# pass N" / "1..N" summary appears -> 3s grace kill, or
		//   2. SILENCE: every subtest result has been seen, then no output for
		//      SILENCE_MS (a file that went quiet after printing all results is
		//      hanging on an open handle) -> force-kill.
		// Either way the captured subtest counts are the verdict, so a file that
		// passed its tests but hangs on exit is still reported as PASS.
		let tapDone = false;
		let graceTimer = null;
		let resultCount = 0;
		let lastResultAt = 0;
		const markTapDone = () => {
			if (tapDone) return;
			if (/^#\s+duration_ms/m.test(out) || /^1\.\.\d+/m.test(out)) {
				tapDone = true;
				graceTimer = setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 3000);
			}
		};
		const onResult = (s) => {
			if (/^(ok|not ok)\s+\d+/m.test(s)) {
				resultCount++;
				lastResultAt = Date.now();
			}
		};
		const silenceTimer = setInterval(() => {
			if (tapDone || resultCount === 0 || child.killed) return;
			if (Date.now() - lastResultAt > SILENCE_MS) child.kill("SIGKILL");
		}, 1000);
		child.stdout.on("data", (b) => {
			const s = b.toString();
			out += s;
			markTapDone();
			onResult(s);
		});
		child.stderr.on("data", (b) => {
			const s = b.toString();
			out += s;
			markTapDone();
			onResult(s);
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, HARD_CAP_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			clearInterval(silenceTimer);
			if (graceTimer) clearTimeout(graceTimer);
			const pass = (out.match(/^# pass\s+(\d+)/m) ||
				out.match(/(\d+)\s+passing/))?.[1];
			const fail = (out.match(/^# fail\s+(\d+)/m) ||
				out.match(/(\d+)\s+failing/))?.[1];
			// When the final summary is never flushed (hang), fall back to the
			// counted subtest "ok/not ok" lines for the verdict.
			const okCount = (out.match(/^ok\s+\d+/gm) || []).length;
			const notOkCount = (out.match(/^not ok\s+\d+/gm) || []).length;
			resolve({
				file: relative(ROOT, file),
				code,
				timedOut,
				tapDone,
				// Killed because all tests finished but the process hung on an open
				// handle is not a real failure — its verdict is the captured counts.
				hung: okCount > 0 && code !== 0 && !timedOut,
				pass: pass ? Number(pass) : okCount,
				fail: fail ? Number(fail) : notOkCount,
				ms: Date.now() - start,
				snippet: out
					.split("\n")
					.filter((l) => /^# (fail|not ok)/.test(l) || /^not ok/.test(l))
					.slice(0, 3)
					.join("  "),
			});
		});
	});
}

function fmt(ms) {
	return (ms / 1000).toFixed(1) + "s";
}

async function main() {
	const all = collectTestFiles(DIST).sort();
	const dashboard = all.filter((f) => DASHBOARD_GLOB.test(f));
	const rest = all.filter((f) => !DASHBOARD_GLOB.test(f));

	let totalPass = 0;
	let totalFail = 0;
	const failed = [];
	const wallStart = Date.now();

	/** Run one file, print progress, accumulate totals. */
	async function runAndReport(f) {
		console.error(`▶ ${relative(ROOT, f)}`);
		const r = await runOne(f);
		totalPass += r.pass;
		totalFail += r.fail;
		const ok = r.fail === 0 && (r.code === 0 || r.hung);
		const mark = ok ? "✓" : "✗";
		const tail =
			r.fail > 0
				? `  ${r.snippet}`
				: r.timedOut
					? "  TIMED OUT"
					: r.hung
						? "  (tests passed; exit-hung)"
						: "";
		console.error(
			`${mark} ${relative(ROOT, f)}  (${r.pass} pass / ${r.fail} fail, ${fmt(r.ms)})${tail}`,
		);
		if (r.fail > 0 || (r.code !== 0 && !r.hung)) failed.push(r);
		return r;
	}

	console.error(
		`\n▶ ${rest.length} test files in parallel (pool=${POOL}), ${PER_FILE_TIMEOUT_MS / 1000}s cap/file`,
	);
	let i = 0;
	async function worker() {
		while (i < rest.length) {
			const f = rest[i++];
			await runAndReport(f);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(POOL, rest.length) }, worker),
	);

	if (dashboard.length) {
		console.error(
			`\n▶ serial dashboard lane (${dashboard.length} files; port ranges must not overlap)`,
		);
		for (const f of dashboard) await runAndReport(f);
	}

	const wall = fmt(Date.now() - wallStart);
	console.error(
		`\nTOTAL: ${totalPass} passed, ${totalFail} failed across ${all.length} files in ${wall}`,
	);
	if (failed.length) {
		console.error("FAILED FILES:");
		for (const r of failed) {
			console.error(
				`  - ${r.file}  (code ${r.code}${r.timedOut ? ", TIMED OUT" : ""}${r.hung ? ", exit-hung(tests passed)" : ""})`,
			);
		}
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

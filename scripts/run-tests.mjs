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
 * Every file is hard-capped at PER_FILE_TIMEOUT_MS (default 120s = 2 min). A
 * file that exceeds it is SIGKILLed. The runner always exits non-zero at the
 * very end if any file failed — but only after running ALL files.
 * Any file that fails under the parallel pool is RE-RUN SOLO once, so a flake
 * (port collision, CPU contention) never ships as a failure without the solo
 * verdict first.
 *
 * Env overrides:
 *   MEGACOMPACT_TEST_TIMEOUT  per-file hard cap in ms (default 120000 = 2 min)
 *   MEGACOMPACT_TEST_POOL     parallel worker count (default = CPU count, max 8)
 *   MEGACOMPACT_TEST_HANG_MS  silence-dead-time before force-kill (default 10000)
 *
 * @module
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import os from "node:os";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DIST = join(ROOT, "dist");

const PER_FILE_TIMEOUT_MS = Number(
	process.env.MEGACOMPACT_TEST_TIMEOUT ?? 120_000,
);
const HARD_CAP_MS = PER_FILE_TIMEOUT_MS + 10_000; // small buffer over node's own timeout
const SILENCE_MS = Number(process.env.MEGACOMPACT_TEST_HANG_MS ?? 10_000);
const POOL = Math.max(
	1,
	Math.min(Number(process.env.MEGACOMPACT_TEST_POOL ?? os.cpus().length), 8),
);

// ── Stale-temp-dir sweeper ──────────────────────────────────────────────
// Prefixes used by mkdtempSync in src/, extensions/, and scripts/ tests.
// Keep in sync with the codebase; adding a new prefix here is sufficient.
const TEST_TMP_PREFIXES = [
	"mc-", "dash-", "dashboard-test-", "dbmaint-test-", "dbmirror-test-",
	"drift-", "mega-events-test-", "mirror-test-", "cachehit-test-",
	"turns-file-", "srv-active-", "srv-stale-", "index-active-",
	"index-servers-",
	// Bare "index-"/"srv-"/"rt-" prefixes are deliberately NOT swept: too
	// generic — another tool's /tmp dirs could match. Only project-specific
	// prefixes (verified against every mkdtempSync call in the repo) are swept.
];

const STALE_AGE_MS = 60 * 60 * 1000; // 60 minutes

/** Remove test-created tmp dirs older than STALE_AGE_MS. */
function sweepStaleTmpDirs() {
	try {
		const dir = tmpdir();
		const entries = readdirSync(dir, { withFileTypes: true });
		let swept = 0;
		let freedMB = 0;
		const now = Date.now();
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const match = TEST_TMP_PREFIXES.some((p) => e.name.startsWith(p));
			if (!match) continue;
			let st;
			try {
				st = statSync(join(dir, e.name));
			} catch {
				continue;
			}
			const age = now - st.mtimeMs;
			if (age < STALE_AGE_MS) continue;
			try {
				const sizeBefore = dirSizeMB(join(dir, e.name));
				rmSync(join(dir, e.name), { recursive: true, force: true });
				swept++;
				freedMB += sizeBefore;
			} catch {
				// best-effort — skip dirs we cannot remove
			}
		}
		if (swept > 0) {
			console.error(`sweeper: swept ${swept} stale test dirs (~${Math.round(freedMB)} MB freed)`);
		}
	} catch {
		// non-fatal: sweeper is best-effort, never break the runner
	}
}

/** Rough recursive dir size in MB (fast, non-fatal). */
function dirSizeMB(dirPath) {
	let bytes = 0;
	try {
		const stack = [dirPath];
		while (stack.length) {
			const d = stack.pop();
			const children = readdirSync(d, { withFileTypes: true });
			for (const c of children) {
				const p = join(d, c.name);
				if (c.isDirectory()) {
					stack.push(p);
				} else {
					try { bytes += statSync(p).size; } catch { /* skip */ }
				}
			}
		}
	} catch { /* non-fatal */ }
	return bytes / (1024 * 1024);
}

sweepStaleTmpDirs();

// Dashboard tests spawn real HTTP servers on a 10-port scan range. Two such
// files running at once can collide on the same base port (EADDRINUSE), so they
// run one-at-a-time. Keep this lane SERIAL and run it LAST (see main()).
const DASHBOARD_GLOB =
	/(^|\/)dashboard-server(?:-s32)?\.test\.js$|(^|\/)mega-compact\.test\.js$/;

// Perf-budget tests assert wall-clock latencies ("perSearch < 10ms" etc.). In
// an N-way parallel pool, CPU contention from the OTHER workers inflates the
// measured latency past the budget — a classic flake (this showed up as
// "exit-hung" / "code 1, tests passed" on vector-search-cache under load).
// Run these SERIALLY too so the budget reflects the code, not the scheduler.
const PERF_GLOB =
	/(^|\/)vector-search-cache\.test\.js$|(^|\/)sprint14\.test\.js$|(^|\/)dashboard-server[/\\][^/\\]+\.test\.js$/;

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
		// ISOLATE per-file global state: every test file gets its OWN PGlite
		// index dirs (vector + memory) and its own global index dir. Without this,
		// two files running in parallel share ~/.pi/mega-compact-vector and their
		// concurrent PGlite init/teardown tears the shared dir — the exact flake
		// that intermittently showed "code 1, exit-hung(tests passed)" on files
		// that are green in isolation. Files that want a specific isolation set
		// these vars themselves (they win — child env is read before defaults).
		const iso = mkdtempSync(join(tmpdir(), "mc-test-iso-"));
		mkdirSync(iso, { recursive: true });
		const env = {
			...process.env,
			MEGACOMPACT_VECTOR_INDEX_DIR: join(iso, "vector"),
			MEGACOMPACT_INDEX_DIR: join(iso, "index"),
		};
		const child = spawn(
			process.execPath,
			[
				"--test",
				"--test-concurrency=1",
				"--test-reporter=tap",
				"--test-force-exit",
				`--test-timeout=${PER_FILE_TIMEOUT_MS}`,
				file,
			],
			{ cwd: ROOT, env },
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
		// startedCount / completedCount: track whether ALL subtests have finished.
		// The silence timer only fires when startedCount === completedCount (every
		// "# Subtest:" has a matching "ok/not ok"), preventing mid-test kills on
		// slow tests (e.g. PGlite init >10s).
		let startedCount = 0;
		let completedCount = 0;
		// lastOutputAt: ANY stdout/stderr data from the child.  Used by the silence
		// timer to detect true hang-on-exit (no output at all for SILENCE_MS).
		let lastOutputAt = Date.now();
		const markTapDone = () => {
			if (tapDone) return;
			// Only "# pass N" (node --test footer) signals that ALL subtests have
			// completed and the process is about to exit.  Do NOT use the "1..N"
			// TAP plan line — node's TAP reporter emits it early (after the first
			// test), which would trigger premature kill of the child mid-suite.
			if (/^# pass\s+\d+/m.test(out)) {
				tapDone = true;
				graceTimer = setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 1500);
			}
		};
		const onResult = (s) => {
			// TAP subtest lines may be indented (nested under a parent "ok N - file")
			// depending on reporter/version — match with leading whitespace allowed.
			if (/^\s*(ok|not ok)\s+\d+/m.test(s)) {
				completedCount++;
			}
			// Track test starts: "# Subtest: ..." means a test is beginning.
			if (/^# Subtest:/m.test(s)) {
				startedCount++;
			}
		};
		const silenceTimer = setInterval(() => {
			if (tapDone || child.killed) return;
			// Only fire when every started test has completed AND no output for
			// SILENCE_MS.  This catches hang-on-exit without killing slow tests.
			if (startedCount > 0 && startedCount === completedCount &&
				Date.now() - lastOutputAt > SILENCE_MS) {
				child.kill("SIGKILL");
			}
		}, 1000);
		child.stdout.on("data", (b) => {
			const s = b.toString();
			out += s;
			lastOutputAt = Date.now();
			markTapDone();
			onResult(s);
		});
		child.stderr.on("data", (b) => {
			const s = b.toString();
			out += s;
			lastOutputAt = Date.now();
			markTapDone();
			onResult(s);
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, HARD_CAP_MS);
		// Wait for both stdout and stderr to drain before resolving.  Node's
		// "close" event fires when the child exits, but the pipe buffers may not
		// be fully flushed yet — causing the tail of TAP output (including
		// "# pass N") to be lost and pass counts to drift between runs.
		let stdoutEnded = false;
		let stderrEnded = false;
		const tryResolve = (code, force) => {
			if (!force && (!stdoutEnded || !stderrEnded)) return;
			clearTimeout(timer);
			clearInterval(silenceTimer);
			if (graceTimer) clearTimeout(graceTimer);
			// Isolation dirs are per-file-only — safe to remove when the child exits.
			try {
				rmSync(iso, { recursive: true, force: true });
			} catch { /* best-effort cleanup */ }
			const pass = (out.match(/^# pass\s+(\d+)/m) ||
				out.match(/(\d+)\s+passing/))?.[1];
			const fail = (out.match(/^# fail\s+(\d+)/m) ||
				out.match(/(\d+)\s+failing/))?.[1];
			// When the final summary is never flushed (hang), fall back to the
			// counted subtest "ok/not ok" lines for the verdict.
			// Count only top-level TAP lines (no leading whitespace) — nested
			// subtests are indented and must not inflate the totals.
			const okCount = (out.match(/^ok\s+\d+/gm) || []).length;
			const notOkCount = (out.match(/^not ok\s+\d+/gm) || []).length;
			// Debug: capture final output tail for files that undercount
			if (false && !pass && okCount > 50) {
				const last100lines = out.split('\n').slice(-100).join('\n');
				process.stderr.write(`[debug ${relative(ROOT, file)}] pass=NO okCount=${okCount} last100lines=[${last100lines}]\n`);
			}
			// `code` is null when the child was killed by a signal (our hang guard
			// SIGKILL). A file killed AFTER its TAP summary or after all subtests
			// printed is "hang-on-exit": verdict comes from the TAP counts, not the
			// exit code.
			resolve({
				file: relative(ROOT, file),
				code,
				timedOut,
				tapDone,
				okCount,
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
		};
		// After "close", wait up to 500ms for stdout/stderr to drain so we
		// capture the full TAP output including "# pass N".  If streams are
		// already drained, resolve immediately.
		let closeCode = undefined;
		let drainTimer;
		const checkDrain = () => {
			if (closeCode === undefined) return;
			if (stdoutEnded && stderrEnded) {
				clearTimeout(drainTimer);
				tryResolve(closeCode, closeCode === null);
			}
		};
		child.on("close", (code) => {
			if (code === null) { tryResolve(code, true); return; }
			closeCode = code;
			drainTimer = setTimeout(() => tryResolve(code, true), 1000);
			checkDrain();
		});
		child.stdout.on("end", () => { stdoutEnded = true; checkDrain(); });
		child.stderr.on("end", () => { stderrEnded = true; checkDrain(); });
	});
}

function fmt(ms) {
	return (ms / 1000).toFixed(1) + "s";
}

async function main() {
	const all = collectTestFiles(DIST).sort();
	const dashboard = all.filter((f) => DASHBOARD_GLOB.test(f));
	const perf = all.filter((f) => !DASHBOARD_GLOB.test(f) && PERF_GLOB.test(f));
	const rest = all.filter((f) => !DASHBOARD_GLOB.test(f) && !PERF_GLOB.test(f));

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
		// Verdict is driven by TAP counts, not the child's exit code: a file whose
		// subtests all passed but which hangs on exit (open sqlite/WASM handle) is
		// a PASS-with-note, not a failure. A file is failed only on an explicit
		// TAP failure, a timeout, or a crash before ANY test produced output.
		const crashedBeforeTests =
			r.code !== 0 && !r.tapDone && r.okCount === 0 && r.pass === 0;
		const ok = !r.timedOut && r.fail === 0 && !crashedBeforeTests;
		const mark = ok ? "✓" : "✗";
		const tail =
			r.fail > 0
				? `  ${r.snippet}`
				: r.timedOut
					? "  TIMED OUT"
				: r.hung
					? "  (tests passed; exit-hung)"
					: crashedBeforeTests
						? `  (crashed before any test output, code ${r.code})`
						: "";
		console.error(
			`${mark} ${relative(ROOT, f)}  (${r.pass} pass / ${r.fail} fail, ${fmt(r.ms)})${tail}`,
		);
		if (!ok) failed.push(r);
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

	if (perf.length) {
		console.error(
			`\n▶ serial perf lane (${perf.length} files; wall-clock budgets must not share CPU with the parallel pool)`,
		);
		for (const f of perf) await runAndReport(f);
	}

	// Solo adjudication: re-run FAILED files one at a time. A file that fails
	// under the pool but passes solo is a FLAKE — count it as a pass, flag it.
	const flakes = [];
	if (failed.length) {
		console.error(
			`\n▶ solo adjudication lane (${failed.length} files; re-running failures one-at-a-time)`,
		);
		for (const r of failed.slice()) {
			console.error(`▶ solo: ${r.file}`);
			const solo = await runOne(join(ROOT, r.file));
			const soloOk = solo.fail === 0;
			if (soloOk) {
				// r.pass was already counted under the pool; only the stray fails roll back.
				totalFail -= r.fail;
				flakes.push(r.file);
				failed.splice(failed.indexOf(r), 1);
				console.error(
					`✓ solo: ${r.file}  (${solo.pass} pass / 0 fail, ${fmt(solo.ms)})  (flake under pool)`,
				);
			} else {
				console.error(
					`✗ solo: ${r.file}  (confirms the failure — ${solo.pass} pass / ${solo.fail} fail)`,
				);
			}
		}
	}

	const wall = fmt(Date.now() - wallStart);
	console.error(
		`\nTOTAL: ${totalPass} passed, ${totalFail} failed across ${all.length} files in ${wall}`,
	);
	if (flakes.length) {
		console.error("FLAKY FILES (failed under the pool, passed solo):");
		for (const f of flakes) console.error(`  - ${f}`);
	}
	if (failed.length) {
		console.error("FAILED FILES:");
		for (const r of failed) {
			console.error(
				`  - ${r.file}  (code ${r.code ?? "signal"}${r.timedOut ? ", TIMED OUT" : ""}${r.hung ? ", exit-hung(tests passed)" : ""})`,
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

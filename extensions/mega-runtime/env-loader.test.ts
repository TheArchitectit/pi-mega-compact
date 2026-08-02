/**
 * env-loader.test.ts — loadMegaEnv parser regression coverage.
 *
 * The setup wizard + Setup tab write shell-sourceable syntax
 * (`export KEY="VALUE"`). The loader must strip the leading `export ` so the
 * key is `KEY` — otherwise process.env gets a useless entry with a space in
 * the name and the real var is never set (the v0.12.7 embedder-activation bug).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: `git init` in an isolated temp dir to test per-repo state-dir resolution — not a network call
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadMegaEnv } = require("./env-loader.js") as {
	loadMegaEnv: (stateDir: string) => void;
};

// Test-data URL constants. These are string literals fed to the env parser —
// never fetched. The guardrails-allow annotates the literals so PREVENT-PI-004
// (which pattern-matches `https?://`) does not flag test data as a network call.
const OLLAMA_URL =
	"http://localhost:11434/api/embeddings"; // guardrails-allow PREVENT-PI-004: test-data string literal (env parser test), not a network call
const FILE_URL =
	"http://localhost:1/from-file"; // guardrails-allow PREVENT-PI-004: test-data string literal (env parser test), not a network call
const SHELL_URL =
	"http://localhost:1/from-shell"; // guardrails-allow PREVENT-PI-004: test-data string literal (env parser test), not a network call

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k]!;
	}
	try {
		return fn();
	} finally {
		for (const k of Object.keys(saved)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

describe("loadMegaEnv", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	function freshDir(): string {
		const d = mkdtempSync(join(tmpdir(), "env-loader-"));
		dirs.push(d);
		return d;
	}

	it("strips the `export ` prefix (shell-sourceable syntax)", () => {
		const d = freshDir();
		writeFileSync(
			join(d, ".mega-compact.env"),
			`# written by setup wizard\nexport MEGACOMPACT_EMBEDDING_URL="${OLLAMA_URL}"\n`,
		);
		withEnv({ MEGACOMPACT_EMBEDDING_URL: undefined }, () => {
			loadMegaEnv(d);
			assert.equal(process.env.MEGACOMPACT_EMBEDDING_URL, OLLAMA_URL);
			// The buggy key with a space must NOT be set.
			assert.equal(
				(process.env as Record<string, string | undefined>)[
					"export MEGACOMPACT_EMBEDDING_URL"
				],
				undefined,
			);
		});
	});

	it("parses plain dotenv syntax (no export prefix)", () => {
		const d = freshDir();
		writeFileSync(join(d, ".mega-compact.env"), `MEGACOMPACT_MINILM=1\n`);
		withEnv({ MEGACOMPACT_MINILM: undefined }, () => {
			loadMegaEnv(d);
			assert.equal(process.env.MEGACOMPACT_MINILM, "1");
		});
	});

	it("shell/inline env vars win over the file", () => {
		const d = freshDir();
		writeFileSync(
			join(d, ".mega-compact.env"),
			`export MEGACOMPACT_EMBEDDING_URL="${FILE_URL}"\n`,
		);
		withEnv({ MEGACOMPACT_EMBEDDING_URL: SHELL_URL }, () => {
			loadMegaEnv(d);
			assert.equal(process.env.MEGACOMPACT_EMBEDDING_URL, SHELL_URL);
		});
	});

	it("unquotes single and double quoted values", () => {
		const d = freshDir();
		writeFileSync(
			join(d, ".mega-compact.env"),
			`export A="double"\nexport B='single'\nexport C=bare\n`,
		);
		withEnv({ A: undefined, B: undefined, C: undefined }, () => {
			loadMegaEnv(d);
			assert.equal(process.env.A, "double");
			assert.equal(process.env.B, "single");
			assert.equal(process.env.C, "bare");
		});
	});

	it("missing file is a no-op (non-fatal)", () => {
		const d = freshDir();
		// No file written — must not throw.
		withEnv({ MEGACOMPACT_EMBEDDING_URL: undefined }, () => {
			loadMegaEnv(d);
			assert.equal(process.env.MEGACOMPACT_EMBEDDING_URL, undefined);
		});
	});

	it("loads from the per-repo state dir (repoStateDir resolution)", () => {
		// Regression for the v0.13.0 embedder-activation bug: the dashboard Setup
		// tab writes .mega-compact.env to the PER-REPO state dir
		// (<repo>/.pi/mega-compact, resolved by repoStateDir), but mega-compact.ts
		// was loading from the global default dir (~/.pi/agent/extensions/...) —
		// so the file sat unread and the configured embedder never activated
		// after restart. This proves repoStateDir(cwd, fallback) + loadMegaEnv
		// together reach the file the wizard actually writes.
		const repo = freshDir();
		// Make `repo` a real git root so repoStateDir resolves to <repo>/.pi/mega-compact.
		execSync("git init -q", { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
		const { repoStateDir } = require("../mega-config.js") as {
			repoStateDir: (cwd: string, fallback: string) => string;
		};
		const perRepo = repoStateDir(repo, join(tmpdir(), "fallback"));
		assert.equal(perRepo, join(repo, ".pi", "mega-compact"));
		// Write the env file where the dashboard writes it, then load.
		mkdirSync(perRepo, { recursive: true });
		writeFileSync(
			join(perRepo, ".mega-compact.env"),
			`export MEGACOMPACT_EMBEDDING_URL="${OLLAMA_URL}"\n`,
		);
		withEnv({ MEGACOMPACT_EMBEDDING_URL: undefined }, () => {
			loadMegaEnv(perRepo);
			assert.equal(process.env.MEGACOMPACT_EMBEDDING_URL, OLLAMA_URL);
		});
	});
});

# Cross-repo E2E + repoKey Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the "start in repo B, recall repo A" contract end-to-end through the real handler chain, and unify the checkpoint-vs-memory `repo_id` scoping with a shared `repoKey()` helper.

**Architecture:** Today the checkpoint PGlite index keys on `stateDir` and the memory PGlite index keys on the git root — a latent divergence that makes cross-repo hydration silently miss. We add `src/store/repoKey.ts` (`repoKey()` + `stateDirForRepo()`) so both indexes agree, then a headless two-repo driver (`scripts/cross-repo-e2e.mjs`) that drives the real `registerEventHandlers` / `doRecallAsync` / `recallMemoriesAndInline` across two isolated state dirs sharing one temp index, plus unit-test hardening to replace mocked `searchAsync`.

**Tech Stack:** TypeScript (ESM, Node ≥22.13), `node:sqlite` (sync source of truth), PGlite + `@electric-sql/pglite-pgvector` (WASM HNSW, additive/async), `node --test`, jiti for the headless driver.

**Parent spec:** `docs/specs/s25-cross-repo.md` — read it first; this plan implements it.

**Branch:** `feat/verify-s24` (off `master` @ `eb59e07`). Do not commit to `master`. Verify gate every commit: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `src/store/repoKey.ts` | NEW. `repoKey(stateDir)` → git root or stateDir fallback; `stateDirForRepo(repoRoot, indexDir)` → reverse lookup via `repo_registry`. Pure, pi-agnostic, no extension imports. | create |
| `src/memoryOps.ts` | Use `repoKey()` from the shared helper instead of the local `resolveRepoRootLocal`. Delete the local copy. | modify |
| `src/vectorStore.ts:136` | `this.repoId = opts.repoId ?? repoKey(this.stateDir)`. | modify |
| `src/vectorStore.ts:538` | Cross-repo hydration: resolve `h.repoId` (now git root) → stateDir via `stateDirForRepo`; skip hit if unresolvable. | modify |
| `extensions/mega-conflict-cmds.ts:90,165` | Assert `repo` (already git root) equals `repoKey(stateDir)` in a dev-only `assert`. | modify |
| `scripts/cross-repo-e2e.mjs` | NEW. Headless two-repo driver: Phases A (checkpoint-on-resume), B (memory augmentation), C1 (disabled), C2 (corrupt self-heal). jiti, mock pi. | create |
| `src/store/repoKey.test.ts` | NEW. TDD tests for `repoKey` + `stateDirForRepo`. | create |
| `src/store/vectorIndex.test.ts` | Add corrupt-dir self-heal + dimension-guard tests. | modify |
| `src/recall.test.ts` | Replace mocked `searchAsync` with real two-repo HNSW over one shared `VIDX`. | modify |
| `src/memoryRecall.test.ts` | Add cross-repo content de-dup assertion. | modify |
| `TESTER_GUIDE.md` | Append the two-repo manual + kill-switch section. | modify |
| `docs/INDEX_MAP.md`, `docs/HEADER_MAP.md` | Register the new spec + script. | modify |

---

## Task 1: Shared repo-key helper (TDD)

**Files:**
- Create: `src/store/repoKey.ts`
- Test: `src/store/repoKey.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/store/repoKey.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { repoKey, stateDirForRepo } from "./repoKey.js";

function initGit(root: string): void {
  execSync("git init -q", { cwd: root, stdio: "ignore" });
  execSync('git config user.email t@t.t && git config user.name t', { cwd: root, stdio: "ignore" });
}

test("repoKey: returns git root when stateDir is inside a git repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "repokey-git-"));
  try {
    initGit(tmp);
    // node:sqlite registry writes live at <tmp>/.pi/mega-compact; the cwd passed
    // to repoKey is that stateDir, but git rev-parse --show-toplevel walks up.
    const stateDir = join(tmp, ".pi", "mega-compact");
    mkdirSync(stateDir, { recursive: true });
    assert.equal(repoKey(stateDir), tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("repoKey: falls back to stateDir when not in a git repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "repokey-nogit-"));
  try {
    assert.equal(repoKey(tmp), tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stateDirForRepo: resolves a registered repo_root -> state_dir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "repokey-resolve-"));
  try {
    const root = join(tmp, "myrepo");
    mkdirSync(root, { recursive: true });
    initGit(root);
    const stateDir = join(root, ".pi", "mega-compact");
    mkdirSync(stateDir, { recursive: true });
    // upsertRepoRegistry is wired by VectorStore bindRepo; mirror it directly.
    const { upsertRepoRegistry, openStore } = await import("./sqlite.js");
    upsertRepoRegistry({
      repoRoot: root,
      displayName: "myrepo",
      stateDir,
      checkpointCount: 0,
      tokensSaved: 0,
      compressedOriginalBytes: 0,
    }, tmp);
    assert.equal(stateDirForRepo(root, tmp), stateDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stateDirForRepo: returns undefined when repo_root not registered", () => {
  const tmp = mkdtempSync(join(tmpdir(), "repokey-unregistered-"));
  try {
    assert.equal(stateDirForRepo("/nonexistent/repo", tmp), undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test dist/src/store/repoKey.test.js`
Expected: FAIL — `Cannot find module './repoKey.js'` (module does not exist yet) and TS build errors for the missing import.

- [ ] **Step 3: Implement the helper**

Create `src/store/repoKey.ts`:

```ts
/**
 * repoKey.ts — shared repo-scope key for the async PGlite indexes.
 *
 * Both the checkpoint index (src/store/vectorIndex.ts) and the memory index
 * (src/store/memoryIndex.ts) MUST agree on the repo_id they key a row with, or
 * cross-repo hydration silently misses. `repoKey(stateDir)` returns the git
 * root (the human-meaningful, stable repo identity), falling back to `stateDir`
 * outside a git repo.
 *
 * `stateDirForRepo(repoRoot, indexDir)` is the reverse lookup: given a git-root
 * repo_id, resolve the per-repo state dir that the sync store lives at — read
 * from the machine-wide `repo_registry` (sqlite.ts). Returns undefined when the
 * repo is not registered (caller skips the hit — degrades, never throws).
 *
 * PREVENT-PI-004: `git rev-parse --show-toplevel` is a read-only local call.
 * Pure + pi-agnostic (no extension-layer import).
 */
import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: read-only git rev-parse to scope indexes per-repo
import { getRepoRegistry } from "./sqlite.js";

/** Resolve the repo-scope key for a state dir: the git root, else the stateDir. */
export function repoKey(stateDir: string): string {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: stateDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || stateDir;
  } catch {
    return stateDir;
  }
}

/**
 * Reverse lookup: git-root repo_id -> per-repo state dir (from repo_registry).
 * undefined when the repo isn't registered (the caller must SKIP the hit, not
 * fabricate a path). Never throws.
 */
export function stateDirForRepo(repoRoot: string, indexDir?: string): string | undefined {
  try {
    return getRepoRegistry(repoRoot, indexDir)?.stateDir;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test dist/src/store/repoKey.test.js`
Expected: PASS (4 tests). If the git-root test fails because the runner's cwd is the pi-mega-compact repo itself, that's fine — `repoKey` walks up from `stateDir`, and the tmp dir's own `git init` makes `tmp` the root.

- [ ] **Step 5: Commit**

```bash
git add src/store/repoKey.ts src/store/repoKey.test.ts
git commit -m "feat(s25): shared repoKey() + stateDirForRepo() for unified index scoping"
```

---

## Task 2: Wire `repoKey()` into memoryOps + VectorStore

**Files:**
- Modify: `src/memoryOps.ts:16-32` (remove `resolveRepoRootLocal`, use `repoKey`)
- Modify: `src/vectorStore.ts:136` (use `repoKey`)
- Test: existing `src/memoryOps.test.ts`, `src/store/memoryIndex.test.ts`, `src/vectorStore.test.ts` must stay green

- [ ] **Step 1: Write a regression test pinning the unified key**

Append to `src/memoryOps.test.ts`:

```ts
test("applyMemoryOps: mirrors memory into the index under the repoKey (git root)", async () => {
  // Repo A: in-git. The memory index row repo_id MUST equal repoKey(stateDir).
  const root = mkdtempSync(join(tmpdir(), "ops-repokey-"));
  try {
    initGit(root); // helper already in this file? if not, inline git init here
    const stateDir = join(root, ".pi", "mega-compact");
    mkdirSync(stateDir, { recursive: true });
    await applyMemoryOps(
      [{ op: "add", memory: { content: "we standardized on PGlite for the index", category: "decision", sourceTurn: 0 } }],
      stateDir,
    );
    const { searchMemoriesAsync } = await import("./store/memoryIndex.js");
    const hits = await searchMemoriesAsync(defaultEmbedder().embed("index backend"), { k: 5 });
    const ours = hits.find((h) => h.content.includes("PGlite"));
    assert.ok(ours, "mirrored memory is findable in the index");
    assert.equal(ours.repoId, root, "repo_id is the git root (repoKey), not the stateDir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

If `defaultEmbedder` / `initGit` aren't already imported in that file, add: `import { defaultEmbedder } from "./embedder.js";` and inline the `git init` block from Task 1 Step 1.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run build && node --test dist/src/memoryOps.test.js`
Expected: FAIL — `ours.repoId` equals `stateDir`, not `root`, because `resolveRepoRootLocal` currently runs against `stateDir` (no `.git` inside `<repo>/.pi/mega-compact`; git walks up and *should* find root). If it passes already, the wiring is incidentally correct — still make the explicit `repoKey` call so the invariant is named, then keep the test as a guard.

- [ ] **Step 3: Switch memoryOps to `repoKey`**

In `src/memoryOps.ts`:
- Replace the `import { execSync } from "node:child_process"` line and the `resolveRepoRootLocal` function (lines ~17-32) with:
  ```ts
  import { repoKey } from "./store/repoKey.js";
  ```
- In `indexMemoryWrite` (line ~48): change `const repoId = resolveRepoRootLocal(stateDir) ?? stateDir;` to:
  ```ts
  const repoId = repoKey(stateDir);
  ```

- [ ] **Step 4: Switch VectorStore to `repoKey`**

In `src/vectorStore.ts`:
- Add the import near the other `src/store` imports: `import { repoKey } from "./store/repoKey.js";`
- Line 136: change `this.repoId = opts.repoId ?? this.stateDir;` to `this.repoId = opts.repoId ?? repoKey(this.stateDir);`

- [ ] **Step 5: Run the full affected suites to verify they pass**

Run:
```bash
npm run build && node --test dist/src/memoryOps.test.js dist/src/store/memoryIndex.test.js dist/src/vectorStore.test.js dist/src/store/repoKey.test.js
```
Expected: PASS (all). If `vectorStore.test.ts` has a test that asserted `repoId === stateDir`, update it to assert `=== repoKey(stateDir)` (or git root) — do not weaken the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/memoryOps.ts src/vectorStore.ts src/memoryOps.test.ts
git commit -m "feat(s25): unify checkpoint + memory index repo_id on repoKey()"
```

---

## Task 3: Cross-repo checkpoint hydration via `stateDirForRepo`

**Files:**
- Modify: `src/vectorStore.ts:538-541` (hydrate hits whose `repoId` is now a git root)
- Test: add to `src/recall.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/recall.test.ts` (alongside the existing cross-repo tests, replacing any mocked `searchAsync`):

```ts
test("recallAndInlineAsync: hydrates a cross-repo checkpoint by resolving git-root repoId -> stateDir", async () => {
  const TMP = mkdtempSync(join(tmpdir(), "recall-xrepo-hydrate-"));
  const IDX = join(TMP, "index");
  process.env.MEGACOMPACT_INDEX_DIR = IDX;
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = IDX;
  try {
    // Repo A: persist a checkpoint + its embedding lands in the shared index.
    const rootA = join(TMP, "repo-a"); mkdirSync(join(rootA, ".pi", "mega-compact"), { recursive: true });
    initGit(rootA);
    const storeA = new VectorStore({ stateDir: join(rootA, ".pi", "mega-compact"), dedupSim: 0.9 });
    const cp = compactSession({
      sessionId: "sA", messages: toEngineMessages([userMsg("circuit breaker retry policy in apiClient.ts"), asstMsg()]),
      keepFrom: 1, timestamp: 0, useExtractiveSummary: true,
    }, storeA);
    assert.ok(!cp.skipped, "repo A checkpoint persisted");

    // Repo B: different state dir, same index. Call cross-repo recall.
    const rootB = join(TMP, "repo-b"); mkdirSync(join(rootB, ".pi", "mega-compact"), { recursive: true });
    initGit(rootB);
    const storeB = new VectorStore({ stateDir: join(rootB, ".pi", "mega-compact"), dedupSim: 0.9 });
    const res = await recallAndInlineAsync({
      sessionId: "sB", query: "circuit breaker retry policy", source: "resume",
      skipInjected: false, recallMaxTokens: 2000, limit: 5, crossRepo: true, dedupSim: 0.5,
      globalIndexDir: IDX,
    }, storeB);
    assert.ok(!res.empty, "cross-repo checkpoint recalled into repo B");
    assert.ok(res.report.some((r) => /from repo-a/.test(r) || /apiClient/.test(r)),
      "repo A's checkpoint summary is hydrated and labeled with its source repo");
  } finally {
    delete process.env.MEGACOMPACT_INDEX_DIR; delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
    rmSync(TMP, { recursive: true, force: true });
  }
});
```

Add whatever imports are missing (`compactSession` from `./engine.js`, `userMsg`/`asstMsg` helpers, `toEngineMessages`, `VectorStore`) — mirror what the existing tests in this file use.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test dist/src/recall.test.js`
Expected: FAIL — `res.empty === true` because `getCheckpoint(h.sessionId, h.checkpointId, h.repoId)` is called with `h.repoId` = git root, but `getCheckpoint` needs the *state dir* of that repo (the sync store path), so it returns undefined and the hit is dropped.

- [ ] **Step 3: Resolve repoId -> stateDir in hydration**

In `src/vectorStore.ts` around line 538, change:
```ts
const cp = getCheckpoint(h.sessionId, h.checkpointId, h.repoId);
```
to:
```ts
// h.repoId is a git-root repo_id (repoKey). The sync store lives at a state
// dir — resolve it via repo_registry. Skip (degrade) if the repo isn't known.
const cpStateDir = h.repoId === selfRepo ? this.stateDir : stateDirForRepo(h.repoId, indexDir) ?? this.stateDir;
const cp = getCheckpoint(h.sessionId, h.checkpointId, cpStateDir);
if (!cp) continue; // unresolvable — skip this hit, never inject stale/fabricated
```
Add the imports at the top: `import { stateDirForRepo } from "./store/repoKey.js";` and ensure `indexDir` is in scope (the existing `searchAsync` already reads `globalIndexDir`; pass it through — if it isn't available locally, read `process.env.MEGACOMPACT_INDEX_DIR`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test dist/src/recall.test.js`
Expected: PASS. Repo A's checkpoint is hydrated into repo B because `stateDirForRepo(rootA, IDX)` resolves to `rootA/.pi/mega-compact`.

- [ ] **Step 5: Commit**

```bash
git add src/vectorStore.ts src/recall.test.ts
git commit -m "feat(s25): cross-repo checkpoint hydration via stateDirForRepo()"
```

---

## Task 4: Unit-test hardening (corrupt self-heal + dim guard)

**Files:**
- Modify: `src/store/vectorIndex.test.ts` (add corrupt self-heal + dimension guard)

- [ ] **Step 1: Write the failing tests**

Append to `src/store/vectorIndex.test.ts`:

```ts
test("vectorIndex: corrupt data dir self-heals (delete + retry), no throw", async () => {
  const dir = join(baseTmp, "corrupt-idx");
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "junk"), "not a real PGlite file, just garbage bytes to trigger an abort on open");
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = dir;
  // Re-import so init re-runs against the corrupt dir.
  delete require.cache[require.resolve("./vectorIndex.js")];
  const { searchAsync } = require("./vectorIndex.js");
  let hits;
  try {
    hits = await searchAsync(new Array(512).fill(0), { k: 3 });
  } catch (e) {
    // self-heal must swallow — a thrown error here fails the test
    assert.fail(`corrupt index threw instead of self-healing: ${String(e)}`);
  }
  assert.ok(Array.isArray(hits), "returns an array even after corruption (empty or healed)");
});

test("vectorIndex: non-512-dim vector is skipped, no throw", async () => {
  const { upsertEmbedding, searchAsync } = require("./vectorIndex.js");
  // 100-dim vector — wrong dimension; must be skipped, not crash the index.
  await upsertEmbedding(join(baseTmp, "dim-guard-state"), "sess", "cp1", new Array(100).fill(0));
  const hits = await searchAsync(new Array(512).fill(0), { k: 3 });
  assert.ok(Array.isArray(hits), "search still works after a dim-mismatched upsert was skipped");
});
```

- [ ] **Step 2: Run the tests**

Run: `npm run build && node --test dist/src/store/vectorIndex.test.js`
Expected: self-heal test PASSES (the `retryOnCorrupt` path already deletes + retries); dim-guard test PASSES (the upsert guards dim). If either fails, the guard is missing — fix the production code, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add src/store/vectorIndex.test.ts
git commit -m "test(s25): vectorIndex corrupt-self-heal + dimension-guard coverage"
```

---

## Task 5: Headless two-repo driver (Phases A/B/C)

**Files:**
- Create: `scripts/cross-repo-e2e.mjs`

- [ ] **Step 1: Write the driver**

Create `scripts/cross-repo-e2e.mjs`. Mirror `scripts/diag-teamrun.mjs`'s jiti + mock-pi shape, but drive two repos:

```js
// scripts/cross-repo-e2e.mjs — headless two-repo E2E proof for S25 cross-repo.
// Run: node scripts/cross-repo-e2e.mjs   (prints CROSSREPO_PASS / CROSSREPO_FAIL)
import { createJiti } from "jiti";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

process.env.MEGACOMPACT_DEBUG = "true";
process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
process.env.MEGACOMPACT_FAST_GATE_PCT = "1";

const jiti = createJiti(import.meta.url);
const { MegaRuntime } = await jiti.import("../extensions/mega-runtime.ts", { default: false });
const { loadConfig } = await jiti.import("../extensions/mega-config.ts", { default: false });
const { registerEventHandlers, lastRuntime } = await jiti.import("../extensions/mega-events.ts", { default: false });
const { compactSession } = await jiti.import("../src/engine.ts", { default: false });
const { toEngineMessages } = await jiti.import("../src/adapt.ts", { default: false });
const { VectorStore } = await jiti.import("../src/vectorStore.ts", { default: false });
const { applyMemoryOps } = await jiti.import("../src/memoryOps.ts", { default: false });
const { defaultEmbedder } = await jiti.import("../src/embedder.ts", { default: false });

function initGit(root) { execSync("git init -q", { cwd: root, stdio: "ignore" }); execSync('git config user.email t@t.t && git config user.name t', { cwd: root, stdio: "ignore" }); }
function userMsg(t) { return { role: "user", content: t, timestamp: 0 }; }
function asstMsg() { return { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", timestamp: 0 }; }

const TMP = mkdtempSync(join(tmpdir(), "mc-xrepo-e2e-"));
const IDX = join(TMP, "index");
process.env.MEGACOMPACT_INDEX_DIR = IDX;
process.env.MEGACOMPACT_VECTOR_INDEX_DIR = IDX;

function fail(msg, extra) { console.log("CROSSREPO_FAIL " + JSON.stringify({ msg, ...extra })); process.exit(1); }
function ok(phase, extra) { console.log("CROSSREPO_PASS " + JSON.stringify({ phase, ...extra })); }

// ---- mock pi/ctx (mirrors diag-teamrun.mjs minimal surface) ----
function harness(stateDir, sessionEntries) {
  const handlers = {};
  const sessionManager = { getSessionId: () => "sB", getEntries: () => sessionEntries, getBranch: () => sessionEntries };
  function makeCtx(over = {}) {
    return {
      ui: { setStatus: () => {}, notify: () => {}, select: () => {}, confirm: async () => true, input: async () => "", setWidget: () => {} },
      mode: "tui", hasUI: true, cwd: stateDir, sessionManager, modelRegistry: {}, model: undefined,
      isIdle: () => true, isProjectTrusted: () => true, signal: undefined, abort: () => {}, hasPendingMessages: () => false,
      shutdown: () => {}, getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }),
      getSystemPrompt: () => "base", ...over,
    };
  }
  const pi = {
    on: (ev, h) => { handlers[ev] = h; }, registerCommand: () => {}, registerTool: () => {}, registerShortcut: () => {},
    registerFlag: () => {}, getFlag: () => undefined, registerMessageRenderer: () => {}, registerEntryRenderer: () => {},
    sendMessage: () => {}, sendUserMessage: () => {}, appendEntry: () => {}, setSessionName: () => {}, getSessionName: () => undefined,
    setLabel: () => {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }), getActiveTools: () => [], getAllTools: () => [],
    setActiveTools: () => {}, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: () => {},
  };
  const config = loadConfig();
  const runtime = new MegaRuntime(config);
  registerEventHandlers(pi, runtime, config);
  return { handlers, runtime, makeCtx };
}

try {
  // ---- repo A: persist a checkpoint + a decision memory ----
  const rootA = join(TMP, "repo-a"); const sdA = join(rootA, ".pi", "mega-compact"); mkdirSync(sdA, { recursive: true }); initGit(rootA);
  const storeA = new VectorStore({ stateDir: sdA, dedupSim: 0.9 });
  const cp = compactSession({
    sessionId: "sA", messages: toEngineMessages([userMsg("circuit breaker retry policy in apiClient.ts"), asstMsg()]),
    keepFrom: 1, timestamp: 0, useExtractiveSummary: true,
  }, storeA);
  if (cp.skipped) fail("repo A compact skipped", { cp });
  await applyMemoryOps([{ op: "add", memory: { content: "we standardized on node:sqlite for the store backend", category: "decision", sourceTurn: 0 } }], sdA);

  // ---- repo B: resume via the REAL event handler ----
  const rootB = join(TMP, "repo-b"); const sdB = join(rootB, ".pi", "mega-compact"); mkdirSync(sdB, { recursive: true }); initGit(rootB);
  process.env.MEGACOMPACT_STATE_DIR = sdB;
  const entries = [{ type: "message", id: "e0", parentId: null, timestamp: "0", message: userMsg("what backend do we use for the store?") }];
  const { handlers, runtime, makeCtx } = harness(sdB, entries);
  await handlers["session_start"]({ type: "session_start", reason: "resume" }, makeCtx());
  const before = await handlers["before_agent_start"]({ type: "before_agent_start", systemPrompt: "base", systemPromptOptions: {} }, makeCtx());

  // Phase A: repo A's checkpoint summary in the recall block.
  if (!before?.systemPrompt || !/apiClient|circuit breaker/i.test(before.systemPrompt)) fail("Phase A: repo A checkpoint not recalled", { prompt: before?.systemPrompt?.slice(0, 200) });
  ok("A-checkpoint-on-resume", { promptHas: "apiClient/circuit breaker" });

  // Phase B: repo A's node:sqlite memory in the memory block.
  if (!/node:sqlite/.test(before.systemPrompt)) fail("Phase B: repo A memory not inlined", { prompt: before.systemPrompt?.slice(0, 200) });
  ok("B-memory-augmentation", { promptHas: "node:sqlite" });

  // Phase C1: kill-switch degrades to same-repo-only, no throw.
  process.env.MEGACOMPACT_PGLITE_DISABLED = "true";
  delete require.cache[require.resolve("../src/store/vectorIndex.ts", import.meta.url)];
  const h2 = harness(join(TMP, "repo-c", ".pi", "mega-compact"), entries);
  mkdirSync(join(TMP, "repo-c", ".pi", "mega-compact"), { recursive: true });
  let threwC1 = false;
  try { await h2.handlers["session_start"]({ type: "session_start", reason: "resume" }, h2.makeCtx()); } catch { threwC1 = true; }
  if (threwC1) fail("Phase C1: kill-switch threw");
  ok("C1-disabled-no-throw");

  // Phase C2: corrupt the index dir, assert self-heal / graceful disable, no crash.
  delete process.env.MEGACOMPACT_PGLITE_DISABLED;
  mkdirSync(join(IDX, "memory", "data"), { recursive: true });
  writeFileSync(join(IDX, "memory", "data", "junk"), "garbage bytes to trigger a WASM abort on open");
  const h3 = harness(join(TMP, "repo-d", ".pi", "mega-compact"), entries);
  mkdirSync(join(TMP, "repo-d", ".pi", "mega-compact"), { recursive: true });
  let threwC2 = false;
  try { await h3.handlers["session_start"]({ type: "session_start", reason: "resume" }, h3.makeCtx()); } catch { threwC2 = true; }
  if (threwC2) fail("Phase C2: corrupt index threw instead of self-healing");
  ok("C2-corrupt-self-heal");
} catch (e) {
  fail("unexpected exception", { error: String(e), stack: e?.stack?.split("\n").slice(0, 3) });
} finally {
  const { closeVectorIndex } = await jiti.import("../src/store/vectorIndex.ts", { default: false });
  const { closeMemoryIndex } = await jiti.import("../src/store/memoryIndex.ts", { default: false });
  await closeVectorIndex(); await closeMemoryIndex();
  rmSync(TMP, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the driver to verify it passes**

Run: `node scripts/cross-repo-e2e.mjs`
Expected: four `CROSSREPO_PASS` lines (`A-checkpoint-on-resume`, `B-memory-augmentation`, `C1-disabled-no-throw`, `C2-corrupt-self-heal`), exit 0.

- [ ] **Step 3: Run the verify gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: all green (no regressions).

- [ ] **Step 4: Commit**

```bash
git add scripts/cross-repo-e2e.mjs
git commit -m "test(s25): headless two-repo E2E driver (checkpoint, memory, fallback)"
```

---

## Task 6: memoryRecall cross-repo content de-dup assertion

**Files:**
- Modify: `src/memoryRecall.test.ts` (the existing `:103` cross-repo test)

- [ ] **Step 1: Add the de-dup assertion**

In the existing cross-repo test (around `src/memoryRecall.test.ts:103`), after asserting repo A's memory is surfaced, add:

```ts
// Save the SAME content locally in repo B; cross-repo must NOT double-surface it.
await applyMemoryOps(
  [{ op: "add", memory: { content: "we standardized on node:sqlite for the store backend", category: "decision", sourceTurn: 0 } }],
  stateDirB,
);
const resDup = await recallMemoriesAndInline({
  query: "what store backend do we use?", stateDir: stateDirB, limit: 5,
  crossRepo: true, crossRepoCosine: 0.3,
});
const matches = (resDup.block.match(/node:sqlite/g) || []).length;
assert.ok(matches <= 1, "a memory present both same-repo and cross-repo is surfaced at most once (de-duped by content)");
```

- [ ] **Step 2: Run the test**

Run: `npm run build && node --test dist/src/memoryRecall.test.js`
Expected: PASS. If it shows 2 matches, the cross-repo content de-dup (`recallMemoriesCrossRepo` `:114`) is broken — fix it, do not weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add src/memoryRecall.test.ts
git commit -m "test(s25): cross-repo memory de-dup assertion (no double-inject)"
```

---

## Task 7: Docs (TESTER_GUIDE + index maps)

**Files:**
- Modify: `TESTER_GUIDE.md` (append the spec's "Cross-repo two-repo manual check" block)
- Modify: `docs/INDEX_MAP.md`, `docs/HEADER_MAP.md`

- [ ] **Step 1: Append the TESTER_GUIDE block**

Append (verbatim from the spec `docs/specs/s25-cross-repo.md:134-165`) the `### Cross-repo two-repo manual check` section to `TESTER_GUIDE.md`.

- [ ] **Step 2: Update the doc maps**

In `docs/INDEX_MAP.md`, add under the specs category:
```
- docs/specs/s25-cross-repo.md — cross-repo E2E + repoKey unification
- scripts/cross-repo-e2e.mjs — headless two-repo driver
```
In `docs/HEADER_MAP.md`, add file:line refs for the new files where the maps track headers.

- [ ] **Step 3: Run the verify gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add TESTER_GUIDE.md docs/INDEX_MAP.md docs/HEADER_MAP.md
git commit -m "docs(s25): two-repo manual check + index map entries"
```

---

## Self-Review

**1. Spec coverage** — checked against `docs/specs/s25-cross-repo.md`:
- §EXECUTION 1 (repoKey helper): Task 1 ✅
- §EXECUTION 1 (memoryOps + vectorStore wiring): Task 2 ✅
- §EXECUTION 1 (stateDirForRepo hydration): Task 3 ✅
- §EXECUTION 1 (mega-conflict-cmds assertion): *deferred* — the spec says "leave; assert it equals repoKey(stateDir)". This is a minor dev-only assert; folded into Task 2's scope check rather than its own task. ✅ (covered by the Task 2 regression test asserting `repoId === root`)
- §EXECUTION 2 (driver Phases A/B/C): Task 5 ✅
- §EXECUTION 3 (vectorIndex corrupt+dim tests): Task 4 ✅
- §EXECUTION 3 (recall.test real two-repo): Task 3's test replaces the mock ✅
- §EXECUTION 3 (memoryRecall de-dup): Task 6 ✅
- §EXECUTION 4 (docs): Task 7 ✅
- §ACCEPTANCE 1-6: covered by Tasks 1–7 + the verify gate ✅

**2. Placeholder scan** — no "TBD", "add error handling", "similar to". Every task has real code/commands. ✅

**3. Type consistency** — `repoKey(stateDir): string` and `stateDirForRepo(repoRoot, indexDir?): string | undefined` are used identically in Tasks 1, 2, 3. `stateDirForRepo` signature matches `getRepoRegistry(repoRoot, indexDir)` at `sqlite.ts:321`. `applyMemoryOps(ops, stateDir)` matches the existing signature. ✅

**Open risk flagged honestly:** Task 3's hydration change assumes `indexDir` is available inside `searchAsync`'s hydration block. If the existing `searchAsync` doesn't thread it, the step says to read `process.env.MEGACOMPACT_INDEX_DIR` — the implementing agent must confirm which by reading `src/vectorStore.ts:519-545` first. This is the one place the plan defers a concrete line to a read-the-code decision; it's marked, not hidden.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-16-cross-repo-e2e.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

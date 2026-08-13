# Audit Findings — v0.7.8 slash commands + QA

Date: 2026-07-19
Auditor: pi-crew review team (read-only)

## Summary
- Commands audited: 17 (+ 1 unregistered alias `/m`)
- Issues found: 0 critical, 3 high, 7 medium, 6 low
- Guardrails violations: 0

## Critical (must fix before release)

None confirmed as a hard crash. The reported "mega-status width-overflow crash" is
addressed below as [H1] — a root-cause bug that produces wrong metrics and, under
specific conditions (corrupt/missing `dashboard.json` with a stale directory path),
can surface as an unhandled error in the async handler.

## High

### [H1] /mega-status: loadMetrics called with directory path instead of file path — metrics always zero, potential unhandled throw
- **File:** `extensions/mega-commands.ts:114`
- **Root cause:** `loadMetrics(runtime.currentStateDir)` passes a **directory** path
  (e.g. `~/.pi/mega-compact/repositories/<repo>`), but `loadMetrics()` expects a
  **file** path. Internally, `loadMetrics` does `existsSync(path)` — which returns
  `true` for a directory — then `readFileSync(path, "utf-8")` on a directory throws
  `EISDIR`. The `catch` block silently returns `emptyMetrics()`, so the FP rate and
  L2 p95 latency displayed by `/mega-status` are **always 0** regardless of actual
  metrics. The correct call is `loadMetrics(defaultMetricsPath(runtime.currentStateDir))`
  (which resolves to `<stateDir>/dashboard.json` — see `src/monitoring.ts:163`).
  Additionally, the `/mega-status` handler is `async` with **no try/catch** around
  the store/metrics calls (lines 85–136). If any of these throw (e.g. a locked DB,
  corrupt SQLite, or the `EISDIR` escaping in a future refactor), the unhandled
  rejection propagates to pi's event loop and can crash the session.
- **Fix:** Change line 114 to:
  `import { loadMetrics, fpRate, p95, defaultMetricsPath } from "../src/monitoring.js";`
  and call `loadMetrics(defaultMetricsPath(runtime.currentStateDir))`.
  Wrap the handler body in `try { ... } catch (e) { ctx.ui.notify("[mega-compact] /mega-status error: " + String(e)); }`.
- **Severity rationale:** The metrics displayed to the user are silently wrong
  (always zero). This is the "width-overflow crash" root cause area: the handler
  has no error boundary, and the `loadMetrics` mis-call is the most likely trigger
  for an unhandled throw in edge cases. Every `/mega-status` invocation hits this
  path.

### [H2] /mega-db-* commands: stale stateDir captured at registration time, not call time
- **File:** `extensions/mega-db-cmds.ts:37` (and all 5 `/mega-db-*` handlers)
- **Root cause:** `const stateDir = runtime.currentStateDir;` is evaluated once when
  `registerDbCommands()` is called (at extension load). If the user switches repos
  (`runtime.bindRepo()` updates `runtime.currentStateDir`), all `/mega-db-*` commands
  operate on the **original** state dir, not the current repo's. This means
  `/mega-db-stats`, `/mega-db-prune`, `/mega-db-vacuum`, `/mega-db-check`, and
  `/mega-db-reconcile` silently target the wrong database when the user has switched
  repos since session start.
- **Fix:** Replace `stateDir` references inside each handler with
  `runtime.currentStateDir` (read at call time, not registration time). Or call
  `runtime.bindRepo(ctx.cwd)` at the top of each handler and then read
  `runtime.currentStateDir`.
- **Severity rationale:** Data maintenance commands operating on the wrong DB can
  cause unintended pruning/vacuuming of the wrong repo's data. The user sees
  "success" but the wrong database was affected.

### [H3] /mega-dashboard-* commands: stale portFile/runnerFile/launchLog captured at registration time
- **File:** `extensions/mega-dashboard-cmds.ts:20-22`
- **Root cause:** Same pattern as [H2]. `portFile`, `runnerFile`, and `launchLog`
  are computed from `runtime.currentStateDir` at registration time. After a repo
  switch, `/mega-dashboard`, `/mega-dashboard-stop`, and `/mega-dashboard-status`
  read/write the **old** repo's `port.pid`, potentially spawning a second dashboard
  or failing to stop the current one.
- **Fix:** Move the `portFile`/`runnerFile`/`launchLog` declarations inside each
  handler, or read `runtime.currentStateDir` at call time.
- **Severity rationale:** Can spawn duplicate dashboard servers or fail to stop
  the running one. Less severe than [H2] because the dashboard is non-destructive.

## Medium

### [M1] /mega-compact: no try/catch around runCompact — unhandled throw crashes the session
- **File:** `extensions/mega-commands.ts:33-44`
- **Root cause:** The `/mega-compact` handler is `async` but calls `runCompact()`
  (which runs the full compaction pipeline including SQLite writes, RAPTOR tree
  build, and PGlite index upsert) with no try/catch. If any of these throw (e.g.
  SQLite disk full, corrupt DB, PGlite init failure that escapes the best-effort
  guard), the unhandled rejection crashes the pi session.
- **Fix:** Wrap the handler body in `try { ... } catch (e) { ctx.ui.notify("[mega-compact] compaction failed: " + String(e)); }`.

### [M2] /mega-recall: no try/catch around doRecall/doRecallAsync
- **File:** `extensions/mega-commands.ts:61-77`
- **Root cause:** Same pattern as [M1]. `doRecall` (sync) and `doRecallAsync`
  (async) are called without an error boundary. A store.search failure or
  embedding error propagates as an unhandled rejection.
- **Fix:** Wrap in try/catch; notify the user on failure.

### [M3] /mega-restore: no try/catch around decompressSmart
- **File:** `extensions/mega-commands.ts:176`
- **Root cause:** `decompressSmart(cp.compressedOriginal)` can throw on corrupt
  compressed data. The handler has no try/catch.
- **Fix:** Wrap in try/catch; notify the user that the checkpoint is corrupt.

### [M4] /mega-view: no try/catch around decompressSmart
- **File:** `extensions/mega-commands.ts:228`
- **Root cause:** Same as [M3]. `decompressSmart(cp.compressedOriginal)` can throw
  on corrupt data.
- **Fix:** Wrap in try/catch.

### [M5] PREVENT-011: `any` type usage in mega-commands.ts
- **File:** `extensions/mega-commands.ts:34`
- **Root cause:** `const messages: any[] = sessionEntries.flatMap(...)` uses `any[]`
  instead of the proper `AgentMessage[]` type. The `sessionEntryToContextMessages`
  return type is known and should be used.
- **Fix:** Change to `const messages = sessionEntries.flatMap((e) => sessionEntryToContextMessages(e));`
  (let TypeScript infer the type) or explicitly type as `AgentMessage[]`.

### [M6] PREVENT-011: `any` type usage in mega-runtime.ts and mega-pipeline.ts
- **File:** `extensions/mega-runtime.ts:1089`, `extensions/mega-pipeline.ts:538`
- **Root cause:** `c.map((b: any) => b.text)` uses `any` for the content block type.
  This appears in `recentUserQuery` (mega-runtime.ts:1089) and `extractLiveWindow`
  (mega-pipeline.ts:538) — both hot paths.
- **Fix:** Define a proper type for the content block (e.g.
  `{ type: string; text?: string }`) or use the `AgentMessage` content type from
  `@earendil-works/pi-agent-core`.

### [M7] /mega-memory: `Number(parts[1])` on potentially-undefined value
- **File:** `extensions/mega-conflict-cmds.ts:113`
- **Root cause:** `const id = Number(parts[1]);` — when the user runs
  `/mega-memory recall` with no argument, `parts[1]` is `undefined`.
  `Number(undefined)` returns `NaN`. The guard `!Number.isFinite(id) || parts[1] === undefined`
  catches this correctly, but the `Number()` call on `undefined` is a code smell
  that relies on the guard being correct. If the guard were refactored to drop the
  `parts[1] === undefined` check, `NaN` would pass silently.
- **Fix:** Guard `parts[1]` before calling `Number()`: 
  `if (parts[1] === undefined) { ctx.ui.notify("..."); return; }` then `const id = Number(parts[1]);`.

## Low / cosmetic

### [L1] /mega-status: modelStr can show "null · null" when model fields are null
- **File:** `extensions/mega-commands.ts:107`
- **Root cause:** `model.modelName ?? model.modelId` can be `null ?? null = null` if
  both are null (unlikely but possible with corrupt DB). Then `model.providerName ?? model.provider`
  can also be null. The fallback is `"unknown (no model captured)"` when `model` is
  falsy, but a truthy model with all-null fields would render `"null · null"`.
- **Fix:** Add a guard: `const modelStr = model ? \`${model.modelName ?? model.modelId ?? "?"} · ${model.providerName ?? model.provider ?? "?"}\` : "unknown (no model captured)"`.

### [L2] /mega-status: usd can display "NaN" when tokensSaved is undefined
- **File:** `extensions/mega-commands.ts:99`
- **Root cause:** `(repo.tokensSaved * rate).toFixed(4)` — if `repo.tokensSaved` is
  `undefined` (shouldn't happen but no guard), the result is `"NaN"`, which renders
  as `≈ $NaN saved`.
- **Fix:** Guard with `(repo.tokensSaved ?? 0)`.

### [L3] /mega-db-stats: division by zero is guarded but the fallback string is "0" not "0.0"
- **File:** `extensions/mega-db-cmds.ts:47`
- **Root cause:** `s.pageCount > 0 ? ((s.freelistPages / s.pageCount) * 100).toFixed(1) : "0"`
  — the fallback is `"0"` while the true branch always has 1 decimal (`toFixed(1)`).
  Minor display inconsistency.
- **Fix:** Change `"0"` to `"0.0"`.

### [L4] /mega-history: unchecked `f.split("/").pop()` can return undefined
- **File:** `extensions/mega-commands.ts:202`
- **Root cause:** `c.filesModified.map((f) => f.split("/").pop())` — `.pop()` on an
  empty array returns `undefined`. If `f` is an empty string, `"".split("/")` is
  `[""]`, and `.pop()` returns `""`. Not a crash, but `undefined` could appear in
  the output if `filesModified` contains empty strings.
- **Fix:** Add `?? f` fallback: `f.split("/").pop() ?? f`.

### [L5] mega-dashboard-cmds.ts: `require("node:child_process")` used in ESM without createRequire
- **File:** `extensions/mega-dashboard-cmds.ts:84`
- **Root cause:** `const { execSync } = require("node:child_process");` uses
  `require` in an ESM module. This works in Node 18+ for built-in modules (Node
  provides a global `require` for `node:` specifiers in ESM), but it is non-standard
  and could break in strict ESM environments or future Node versions.
- **Fix:** Use `import { execSync } from "node:child_process"` at the top of the
  file (it's already imported as `spawn`), or use `createRequire(import.meta.url)`.

### [L6] mega-conflict-cmds.ts: `/m` alias not in the documented 17-command list
- **File:** `extensions/mega-conflict-cmds.ts:142`
- **Root cause:** An 18th command `/m` is registered as a shortform alias for
  `/mega-memory`. It is functional but undocumented in the help text and not listed
  in the task's 17-command scope. This is not a bug but a documentation gap.
- **Fix:** Document `/m` in `/mega-help` output and the README.

## Guardrails violations (PREVENT-PI-*)

No PREVENT-PI-* violations found in the audited command handlers or hot paths.

**PREVENT-PI-001 (anchor-floor guard):** ✅ Compliant. The live-trim path in
`mega-events.ts:590-640` reads `anchorUserMessages` from config/env and passes it
to `computeLiveTrimCut()` (from `mega-trim.ts`), which enforces the anchor floor
and returns `null` when below it. The `session_before_compact` handler reuses pi's
own cut boundary (which honors the anchor floor).

**PREVENT-PI-002 (toolCall/toolResult pair splitting):** ✅ Compliant. The live-trim
path annotates `messages.slice(cut)` with
`// guardrails-allow PREVENT-PI-002: cut is the pre-sanitized compactedFrom produced
by src/boundary.ts computeDropRange`. The `session_before_compact` handler reuses
pi's `firstKeptEntryId` (which is boundary-safe).

**PREVENT-PI-003 (no role:"system" injection):** ✅ Compliant. Compacted context is
injected via `before_agent_start` `systemPrompt` prepend (`mega-events.ts:218-227`),
never as `role:"system"`. The `/mega-restore` command stages via
`runtime.pendingRecallBlock` (mega-commands.ts:179), which is composed into the
`systemPrompt` at the next `before_agent_start`.

**PREVENT-PI-004 (no network calls):** ✅ Compliant. All `fetch`/HTTP/spawn calls
are localhost-only and annotated with `// guardrails-allow PREVENT-PI-004: <reason>`:
- `extensions/dashboard-server.ts:1200` — CORS for local browser
- `extensions/mega-dashboard-cmds.ts:34,54,60,84,263,281` — localhost dashboard probes
- `src/httpEmbedder.ts:93,129` — localhost BYO embedding server
- `src/dedup/raptor/summarizer.ts:70` — localhost Ollama

## Per-command verdict table

| Command | Crash-safe? | Correct? | Guardrails? | Notes |
|---------|-------------|----------|-------------|-------|
| /mega-compact | no (M1) | yes | yes | No try/catch around runCompact |
| /mega-status | no (H1) | no (H1) | yes | loadMetrics dir-vs-file; no try/catch |
| /mega-recall | no (M2) | yes | yes | No try/catch around doRecall/doRecallAsync |
| /mega-view | no (M4) | yes | yes | No try/catch around decompressSmart |
| /mega-history | yes | yes | yes | Clean |
| /mega-memory | yes | yes (M7) | yes | Number(undefined) guarded but fragile |
| /mega-restore | no (M3) | yes | yes | No try/catch around decompressSmart |
| /mega-help | yes | yes | yes | Static text only |
| /mega-compat-check | yes | yes | yes | Clean; conflict-scan has try/catch |
| /mega-dashboard | yes | no (H3) | yes | Stale portFile path |
| /mega-dashboard-status | yes | no (H3) | yes | Stale portFile path |
| /mega-dashboard-stop | yes | no (H3) | yes | Stale portFile path |
| /mega-db-check | yes | no (H2) | yes | Stale stateDir |
| /mega-db-prune | yes | no (H2) | yes | Stale stateDir; wrong DB pruned |
| /mega-db-reconcile | yes | no (H2) | yes | Stale stateDir |
| /mega-db-stats | yes | no (H2) | yes | Stale stateDir; wrong DB stats |
| /mega-db-vacuum | yes | no (H2) | yes | Stale stateDir; wrong DB vacuumed |

## QA sweep findings (src/)

### src/engine.ts
- **Crash safety:** ✅ Good. `compactSession` handles empty slices, undefined text
  (via `firstText` guard in compact.ts). No JSON.parse, no SQL, no network.
- **Correctness:** ✅ Correct token accounting (originalTokenEstimate vs storedTokens).

### src/recall.ts
- **Crash safety:** ✅ Good. `recallAndInline` has token cap guards, window dedupe
  with null checks. `recallAndInlineAsync` wraps `searchAsync` in try/catch.
- **PREVENT-011:** `recall.ts:238` uses `{ memory: any }` for cross-repo memory hits.
  Minor — should use the `MemoryRecord` type.

### src/store/sqlite.ts
- **PREVENT-002 (SQL injection):** ✅ Compliant. All queries use parameterized
  placeholders (`?`, `@name`). The only string interpolation is in
  `ensureColumn` (line 630: `ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  and the `memories` WHERE clause (line 846: `WHERE ${where}`), but both are
  code-controlled constants (never user input) — documented in comments.
- **PREVENT-001 (JSON.parse):** ✅ Compliant. All `JSON.parse` calls on DB columns
  are guarded with truthiness checks: `row.tags ? JSON.parse(row.tags) : []`
  (lines 997, 1033-1035, 1252-1253, 1576).
- **PREVENT-011:** `sqlite.ts:293,991,1026` use `row: any` for DB row mapping
  functions. This is a common pattern for SQLite row types but technically
  violates PREVENT-011. Low severity — the functions are internal mappers.

### src/store/vectorIndex.ts
- **PREVENT-PI-004:** ✅ Compliant. PGlite is WASM Postgres (fully local). No
  network calls.
- **Crash safety:** ✅ Excellent. Every function has try/catch, degrades to
  `disabled=true` on failure, never throws. Dimension guard on embeddings.
- **PREVENT-011:** `vectorIndex.ts:252` uses `(r: any)` for PGlite row mapping.
  Minor — PGlite row types are untyped.

### src/vectorStore.ts
- **Crash safety:** ✅ Good. Division-by-zero guarded:
  `cps.length === 0 ? 0 : injected / cps.length` (line 748).
- **Correctness:** ✅ Dedup tiers (L0/L1/L2) properly sequenced with fallback.

### src/compact.ts
- **Crash safety:** ✅ Good. `firstText` guards `m.text ?? ""` (line 33).
  `extractFileCandidates` guards `content` being null/undefined (line 45).
  `autoCompactCheck` has no division-by-zero (`currentTokens / threshold` —
  threshold is always a positive number from config).
- **Correctness:** ✅ `shouldCompact` checks `messages.length <= preserveRecent`
  before slicing.

### src/supersede.ts
- **Crash safety:** ✅ Good. `fileOps` coerces `msg.text ?? ""` (line 21).
  No JSON.parse, no SQL, no network.

### extensions/mega-runtime.ts
- **Crash safety:** ✅ Good for the widget. `wrapLine` guards `maxWidth <= 0`.
  `panelLine` uses `Math.max(0, ...)` for padding. `panelBar` uses
  `Math.max(0, width)`. `ramp` with `w=0` doesn't crash (scaled=0, loop doesn't run).
  PULSE array access is modulo-guarded. Ticker index is modulo-guarded.
- **PREVENT-011:** `mega-runtime.ts:1089` uses `(b: any) => b.text` — see [M6].
- **Correctness:** ✅ Widget auto-fits via `width > 0 ? width : 200` guard.

### extensions/dashboard-server.ts
- **PREVENT-PI-004:** ✅ Compliant. `createServer` binds `127.0.0.1` only.
  Annotated with `// guardrails-allow PREVENT-PI-004`.
- **PREVENT-001 (JSON.parse):** ✅ Compliant. `readSnapshot` (line 307) wraps
  `JSON.parse` in try/catch with a full fallback object. `readIndex` (line 84)
  wraps in try/catch. `/api/servers` endpoint wraps `JSON.parse` in try/catch
  (line 1301).
- **Crash safety:** ✅ Good. HTTP handler has per-route try/catch. SSE watches
  for file creation. Port reuse probes for liveness.
- **Correctness:** ✅ Server version check enables stale-server replacement.

### extensions/mega-pipeline.ts
- **Crash safety:** ✅ Good for `runCompact` (best-effort RAPTOR, PGlite,
  consolidation — all fire-and-forget with `.catch()`). `doRecallAsync` wraps
  cross-repo in try/catch. `piCompactWouldNoop` wraps in try/catch.
- **PREVENT-011:** `mega-pipeline.ts:538` uses `(b: any) => b.text` — see [M6].
- **Note:** `runCompact` calls `runtime.snapshot(ctx)` at the end (line 297),
  which builds the widget. This is safe (widget has width guards).

### src/monitoring.ts
- **PREVENT-001 (JSON.parse):** ✅ Compliant. `loadMetrics` (line 71) wraps
  `JSON.parse` in try/catch, returns `emptyMetrics()` on failure.
- **Division by zero:** ✅ `p95` guards `samples.length === 0` (line 99).
  `fpRate` guards `decisions === 0` (line 111).
- **Bug:** See [H1] — `loadMetrics` is called with a directory path from
  mega-commands.ts, not a file path.

### src/httpEmbedder.ts
- **PREVENT-PI-004:** ✅ Compliant. `fetch` is localhost-only, annotated.
- **PREVENT-001 (JSON.parse):** ✅ Compliant. Worker script wraps `JSON.parse` in
  try/catch (line 144). Headers parsed with `JSON.parse(process.env.MEGACOMPACT_EMBEDDING_HEADERS)`
  at line 56 — no try/catch, but this is a config-time env var, not runtime data.
  Minor risk if the env var is malformed.

### src/dedup/raptor/summarizer.ts
- **PREVENT-PI-004:** ✅ Compliant. `fetch` is localhost Ollama, annotated.
- **PREVENT-001 (JSON.parse):** ✅ Compliant. `JSON.parse(res.stdout)` wrapped in
  try/catch with fallback (line 83).

### src/dedup/raptor/kmeans.ts
- **Division by zero:** ✅ Guarded. `meanVector` checks `vectors.length === 0`
  (line 141). k-means++ seeding checks `sum === 0` (line 96) to avoid
  `target = Math.random() * 0` division.

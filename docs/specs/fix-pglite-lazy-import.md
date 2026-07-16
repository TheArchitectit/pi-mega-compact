# Fix: lazy-load PGlite so a missing package degrades instead of crashing extension load

**Status:** Shipped (v0.6.3) · **Type:** Bug fix · **Risk:** Low · **Author:** TheArchitectit

## Safety
- No schema change. No change to the authoritative `node:sqlite` store or the
  sync recall path (the DEFAULT recall path is untouched).
- PREVENT-PI-004 preserved: PGlite stays WASM Postgres, fully local, zero network.
- The redundant async index remains best-effort/non-fatal; this fix only makes
  "best-effort" true at *module-load* time, which it was not before.
- Guardrail gate passed: `npm run lint`, `scripts/guardrails-scan.mjs`,
  `python3 scripts/regression_check.py --all`, plus the vector/memory index tests.

## Problem
`src/store/vectorIndex.ts` and `src/store/memoryIndex.ts` used a **static
top-level `import { PGlite } from "@electric-sql/pglite"`**. A static import is
resolved at module-load time, so when the package is absent from the install
(`~/.pi/agent/extensions/pi-mega-compact/node_modules/@electric-sql` missing in
the published `0.6.2`), pi throws at load:

```
Error: Failed to load extension ".../extensions/mega-compact.ts":
Failed to load extension: Cannot find module '@electric-sql/pglite'
Require stack:
- .../src/store/vectorIndex.ts
```

That crashes the **entire** extension before pi starts — compaction, memory
recall, everything dead — even though the async PGlite index is only a redundant
add-on. The files' own header comments claimed the package was "Imported lazily
so a missing/broken package degrades gracefully instead of crashing module load."
The code did the opposite of its own contract.

**Root cause:** static import ≠ lazy import. The redundancy/degradation promise
relied on the import being deferred to first use, but it was hoisted to load time.

## Scope
- In: `src/store/vectorIndex.ts`, `src/store/memoryIndex.ts`.
- Out: the `package.json` dependency declarations (already correct — `@electric-sql/pglite`
  and `@electric-sql/pglite-pgvector` are listed `^0.5.4` / `^0.0.5`). The separate
  question of *why* the published tarball didn't deliver pglite into `node_modules`
  is a packaging/install concern, not fixed here; this fix makes that class of
  failure non-fatal regardless.

## Execution
1. Replace the static value import with a **dynamic `import()`** of both packages,
   invoked from a new `loadPgLite()` helper inside each module.
2. Keep the `import type { PGlite, Extension }` (and the `PGliteInstance` alias) —
   `import type` is erased at compile time and emits no runtime load, so types are
   retained with zero load-time cost.
3. `loadPgLite()` caches success (`pgliteMod`) and permanent failure
   (`pgliteLoadFailed`), returns `undefined` on any error, and never throws. It
   logs one warning (`package unavailable … (falling back to sync scan)`).
4. `openPgLite()` now awaits `loadPgLite()` first and returns `undefined` if the
   package is unavailable. Every public entry (`initVectorIndex`, `initMemoryIndex`,
   `upsertEmbedding`, `searchAsync`, `rebuildFromSqlite`) already degrades to the
   authoritative sync scan when it receives `undefined`.
5. `postinstall` already rebuilds `@mongodb-js/zstd` (native) but pglite needs no
   build step (WASM), so no install-script change is required.

## Acceptance
- `dist/src/store/vectorIndex.js` and `memoryIndex.js` contain **no** top-level
  `import "@electric-sql/pglite"` — only `import("@electric-sql/pglite")` inside
  functions. Verified via grep on built output.
- Faithful missing-package repro (built module in a dir with no pglite in
  `node_modules`): module loads, emits exactly one warning, `initVectorIndex()`
  returns `undefined`; no `Cannot find module` load crash.
- Kill-switch `MEGACOMPACT_PGLITE_DISABLED=true` still returns `undefined`.
- When pglite *is* present, the cross-repo HNSW path works unchanged (tests pass).
- `src/store/vectorIndex.test.ts` + `memoryIndex.test.ts` (14 cases incl. cross-repo
  recall and disabled/kill-switch) all green.

## Rollback
- Revert the two file edits (`git revert <sha>`). No migration, no config, no
  data impact. The fix is pure load-time restructuring; the runtime contract for
  callers is identical.

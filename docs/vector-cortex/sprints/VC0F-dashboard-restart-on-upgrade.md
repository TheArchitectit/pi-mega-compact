# VC Dashboard Restart-on-Upgrade (session_start auto-restart)

Status: **PLANNED** | Branch: (to be created from `master` after v0.20.26+) | Date: 2026-08-05

Follow-up to VC0E. The v0.20.25 release shipped honest status badges, but
the underlying **dashboard runner staleness gap** remains for the durable case:
`pi update --extensions` replaces the on-disk package under
`~/.pi/agent/npm/node_modules/pi-mega-compact/`, but any long-running
`_dashboard-runner.mjs` process keeps serving the OLD in-memory bundle
indefinitely. The user must notice the version mismatch and run
`/mega-dashboard-stop` + `/dashboard` themselves. The immediate mitigation
shipped in `scripts/deploy.sh` (post-publish bounce of local runners — see
commit `ea2e097`), but that only helps on the host running the deploy. Devices
that later run `pi update --extensions` are unprotected.

## Problem Statement

After v0.20.25 was published and `pi update --extensions` ran on this host, six
orphan dashboard servers on ports 9320–9325 were still serving v0.20.24 —
the published bundle on disk was v0.20.25, but every `/api/version` reported
the old version and the new `status` fields were missing from the JSON. The
stale-replace logic that already exists in `extensions/mega-dashboard-cmds.ts`
(handles the `/mega-dashboard` COMMAND) is **passive**: it only fires when a
user runs `/mega-dashboard`. Nothing probes for staleness at session start or
on upgrade. There is no signal that `pi update --extensions` happened.

### Evidence (v0.20.25 deploy)

```
$ curl -s localhost:9320/api/version | jq .version
"0.20.24"           # ← stale; on-disk package.json is 0.20.25
$ ss -ltnp | grep 932
… pid=1345187 …      # ← orphan: no port.pid marker anywhere in $HOME
```

Six orphans found, none with markers (markers only exist when the server wrote
them this process lifetime; orphans from a previous upgrade have none).

## Goals

1. **Durable auto-restart**: the first `/dashboard` or session-start that
   detects a version mismatch kills the stale runner and spawns a fresh one
   loading the current on-disk code — no user intervention required.
2. **Once-per-process**: avoid re-probing on every `/dashboard` invocation
   within a single extension process (probe is cheap but the kill+respawn
   is disruptive).
3. **Multi-repo safe**: a dashboard server is per-repo (each repo's state dir
   spawns its own runner); killing one must not affect another repo's server
   unless that server is ALSO stale.
4. **Best-effort, non-fatal**: any failure in the staleness probe or kill must
   never break the dashboard command itself.
5. **No new network calls beyond the existing local probe** (PREVENT-PI-004
   stay-local — `fetch http://localhost:PORT/api/version` is already audited
   in `mega-dashboard-cmds.ts:66`).

## Design

### Existing assets to reuse (no rewriting)

`extensions/mega-dashboard-cmds.ts` already has every primitive needed:

- `findLivePort()` (line 37) — probes ports 9320–9329 for `/api/snapshot`.
- `isServerRunning()` (line 51) — returns `{port, hasPidFile}`.
- `serverVersion(port)` (line 64) — `GET /api/version` → `j.version`.
- `ownVersion()` (line 76) — reads the extension's own `package.json`.
- `killServerOnPort(port)` (line 101) — SIGTERM via port.pid then `ss` fallback; removes marker.
- The in-handler stale-replace block (lines 186–209): `const stale = orphan || (want != null && running != null && running !== want);`

The gap is that this block lives INSIDE the `/mega-dashboard` command handler,
so it only runs when a user explicitly invokes the command. VC0F lifts it into
a reusable `bounceStaleRunnerIfAny()` function and calls it from a new
session-start hook as well.

### Wave A: Extract + reuse the stale-replace seam

- **A1. Extract `bounceStaleRunnerIfAny()`** — pull the
  `orphan || versionMismatch` block out of the `/mega-dashboard` handler into
  a standalone `async function bounceStaleRunnerIfAny(ctx): Promise<{bounced: boolean}>`
  in `mega-dashboard-cmds.ts`. The `/mega-dashboard` handler calls it first
  (behavior unchanged for the interactive case — it still notifies the user
  before killing).

- **A2. Once-per-process marker** — add a module-level
  `let stalenessCheckedThisProcess = false;` gate. `bounceStaleRunnerIfAny`
  short-circuits when it's already true (set after the FIRST successful
  probe, regardless of outcome). This bounds the cost to one probe per
  extension load.

- **A3. Session-start trigger** — register a `session_start` (or equivalent
  pi lifecycle hook) that calls `bounceStaleRunnerIfAny(ctx)` silently
  (no `ctx.ui.notify` on the session-start path — only on the explicit
  `/mega-dashboard` path). This is the durable fix for the upgrade case:
  after `pi update --extensions`, the next pi session probes the running
  dashboard, sees the version mismatch, kills + respawns.

### Wave B: Runner version stamping (defensive)

- **B1. `_dashboard-runner.mjs` stamps its bundle version** — `writeRunnerScript()`
  currently writes a generic import launcher. Add a comment or constant in the
  generated script that records `ownVersion()` at WRITE time, so a future
  probe could compare the marker's stamped version against `ownVersion()`
  WITHOUT needing to hit `/api/version` (useful when the server is hung and
  the HTTP probe times out). Non-blocking optimization — the HTTP probe
  remains the primary signal.

- **B2. `port.pid` marker gains `version`** — when the server writes
  `port.pid` (server.ts:307), include `version: <pkg version>` alongside
  `{port, pid}`. `bounceStaleRunnerIfAny` reads the marker first (cheap) and
  only falls back to the HTTP probe when the marker is missing or stale.
  This closes the orphan case: a server whose marker doesn't match
  `ownVersion()` is stale by definition.

### Wave C: Tests + guardrails

- **C1. Unit test** — `bounceStaleRunnerIfAny` with a stubbed
  `serverVersion`/`ownVersion` returns `{bounced: true}` when versions
  differ, `{bounced: false}` when they match, and never throws on
  `fetch` failure.
- **C2. Once-per-process test** — second call within the same module
  instance short-circuits (no `killServerOnPort` call).
- **C3. Multi-repo isolation test** — killing a stale server for repo A
  does not affect a live current-version server for repo B (different
  state dir, different port).
- **C4. Guardrails** — `bounceStaleRunnerIfAny`'s `fetch` calls carry the
  existing `// guardrails-allow PREVENT-PI-004` audit comment (already
  present on `serverVersion`). No new network surface.

## What's NOT changing

- **`pi update --extensions` itself** — pi's package manager is untouched;
  VC0F only fixes what happens AFTER the on-disk update.
- **The `scripts/deploy.sh` bounce step** — that remains as the
  immediate-enforcement for the host running the deploy; VC0F is the
  durable, device-side complement.
- **Dashboard bundling** — no change to `build:dashboard` or the `dist/`
  verification gate.
- **Orphan sweep on port range** — the deploy.sh orphan sweep (9320–9329
  without a marker) is NOT duplicated in the runtime; the runtime relies
  on `isServerRunning()` + `hasPidFile` as the existing discovery primitive.
  The orphan case is covered by B2's marker-version check (a missing marker
  on a live port is already an orphan by the existing rule).

## Acceptance Gates

1. `bounceStaleRunnerIfAny` extracted, called from both `/mega-dashboard`
   and `session_start`.
2. Once-per-process gate prevents repeated probes.
3. `port.pid` marker includes `version`; stale-marker path skips the HTTP
   probe when marker version mismatches `ownVersion()`.
4. Unit + integration tests pass; `npm test` stays green (3295+ baseline
   from VC0E).
5. Full gate: `build + test + lint + regression_check --all + guardrails-scan
   + soft-as-hard + dashboard-client tsc`.
6. `./scripts/deploy.sh <version>` publishes; post-publish device steps
   note that `/dashboard` now self-heals on the next session.

## Execution

Sonnet agents perform implementation; controller performs review and fixes.
Single-branch sprint (small surface area: `mega-dashboard-cmds.ts` +
`dashboard-server/server.ts` + tests). Estimated 2–3 file touches, well
under the 400-line extension soft limit for each.

## Relationship to VC0E

VC0E (v0.20.25) made the dashboard HONEST about its state — every card now
shows LIVE / AWAITING DATA / DEFERRED instead of bare zeros. VC0F makes the
dashboard REFRESH ITS OWN CODE on upgrade — the natural complement, since a
stale runner serving v0.20.24 wouldn't even have the VC0E status badges.
Together: the dashboard always tells the truth, and it always runs the
latest truth.

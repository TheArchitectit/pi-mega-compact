# Provider and Model Analytics Program (PMA-0–PMA-7)

**Date:** 2026-08-09
**Owner:** pi-mega-compact
**Status:** PLANNED — documentation only; no implementation, version bump, publish, or deploy occurs on this branch.
**Branch:** `feat/provider-model-analytics-spec`
**Reference UI:** TheArchitectit-authored, merged Plexus PRs [#35](https://github.com/mcowger/plexus/pull/35), [#36](https://github.com/mcowger/plexus/pull/36), [#38](https://github.com/mcowger/plexus/pull/38), [#59](https://github.com/mcowger/plexus/pull/59), [#60](https://github.com/mcowger/plexus/pull/60), [#61](https://github.com/mcowger/plexus/pull/61), [#62](https://github.com/mcowger/plexus/pull/62), [#63](https://github.com/mcowger/plexus/pull/63), [#64](https://github.com/mcowger/plexus/pull/64), and [#68](https://github.com/mcowger/plexus/pull/68).

---

## 1. Vision and outcome

Add truthful provider/model analytics beneath the existing **Cache+Performance** dashboard surface without changing its current Overview behavior. The surface gains five sub-tabs:

1. **Overview** — the current `extensions/dashboard-client/src/tabs/CacheTab.tsx` behavior.
2. **Providers** — provider pulse, aggregates, velocity, and comparisons.
3. **Models** — model pulse, stack, aggregates, and comparisons.
4. **Live** — measured in-flight activity, request velocity, timeline, and freshness.
5. **Detailed** — filterable/grouped drill-down and request stream.

Analytics facts live in `analytics.db`, a new local `node:sqlite` database under `stateDir`. It is isolated from `sqlite.db`, `turns.db`, and every current provider/cache performance path, and owns its complete connection, schema, migration, retention, backup, integrity, and close lifecycle.

## 2. Goals and non-goals

### Goals

- Preserve CacheTab exactly as the Overview sub-tab.
- Provide all merged Plexus dashboard behavior authored by TheArchitectit, adapted to telemetry pi can actually measure.
- Establish a host-agnostic `src/store/analytics/` contract reusable by another local host.
- Capture append-only request/event/sample facts and derive dashboard views by query.
- Keep analytics failures non-fatal and outside the agent loop's correctness path.
- Make data origin, freshness, quality, and unavailable measurements explicit.

### Non-goals

- No runtime implementation on this planning branch.
- No remote telemetry, external analytics service, or new runtime network path.
- No fabricated TTFT, TPS, provider identity, or concurrency.
- No removal or repurposing of current performance/cache storage during this program.
- No mandatory parity for Metrics and Alerts cards later authored by Matt Cowger. They are optional follow-up work, not TheArchitectit parity.
- No version bump, `scripts/deploy.sh`, npm publish, tag, or release from this branch.

## 3. Locked architecture decisions

1. **Local isolated database.** `analytics.db` uses `node:sqlite` `DatabaseSync`, parameterized SQL, WAL, a bounded busy timeout, and foreign-key checks. It introduces no network calls.
2. **Independent lifecycle.** Analytics owns open/cache/close, schema versions, migration markers, retention, backup, restore, integrity check, and vacuum. A typed lifecycle coordinator owns the connection cache and restore sequence; maintenance cannot operate on another DB.
3. **Contract first.** `src/store/analytics/types.ts` is approved before implementation. Consumers import types and the factory, never SQLite internals.
4. **Capability gates.** `AnalyticsReader` queries only; `AnalyticsWriter` appends facts only; `AnalyticsAdmin` migrates, prunes, backs up, checks integrity, and vacuums. `AnalyticsLifecycleCoordinator` alone restores a backup because it can close and evict every cached handle before replacing the file. Production consumers receive the narrowest handle.
5. **Append-only ledger.** Request lifecycle facts, samples, and identity observations are inserts. No regular writer update/delete exists. Schema metadata and admin maintenance are lifecycle exceptions.
6. **Host push/store pull.** The host supplies facts; the store never subscribes, emits, polls, or calls the host.
7. **Best effort.** Extension adapters catch and structurally log failures; analytics never interrupts requests, compaction, recall, or the dashboard server.
8. **Feature flag.** `MEGACOMPACT_PROVIDER_MODEL_ANALYTICS` defaults ON. `=0` preserves pre-program runtime and CacheTab behavior byte-for-byte and does not open/write `analytics.db`. Register it in dashboard Settings. Any install-time DB-path override is read-only and listed in `EXCLUDED_SETTINGS`.
9. **Routes stay split.** New handlers live in `extensions/dashboard-server/routes-analytics.ts`; typed contracts live in `extensions/dashboard-server/api-contracts/analytics.ts`; client calls live in a dedicated analytics client module. Do not grow `route-dispatch.ts` centrally.
10. **Truth before parity.** Nullable values and data-quality notes are contractual. A card renders `N/A`, not zero, if an upstream measurement is unavailable.

## 4. Current-state baseline and correction

Relevant local seams include:

- `extensions/dashboard-client/src/App.tsx` mounts `CacheTab` for `cache-perf`.
- `extensions/dashboard-client/src/tabs/registry.ts` registers the Cache+Performance surface.
- `extensions/dashboard-client/src/tabs/CacheTab.tsx` fetches current cache, performance, stability, snapshot, and settings data.
- `extensions/dashboard-server/routes-cache.ts` serves provider-cache/cache-stripe views.
- `extensions/dashboard-server/route-dispatch.ts` is currently a compact dispatcher; analytics routing must remain delegated.
- `src/store/sqlite/perf-samples.ts` reads/writes current `perf_samples`-based provider/cache data through the main store path.
- `src/store/turns/` is the reference for a separately owned, capability-gated SQLite store.
- `extensions/dashboard-client/src/hooks/useApi.ts` is the polling/staleness data-fetch pattern.

**Correction:** exploration did not prove a current `provider-cache.db`. The authoritative plan must treat provider/cache data as residing in the current main-store `perf_samples` path until PMA-0 verifies actual schema, file ownership, and migration sources. The new `analytics.db` must be demonstrated as a different resolved path and handle before ingestion is enabled.

## 5. Store contract

The approved contract shape is:

```ts
interface AnalyticsReader {
  providers(query: AggregateQuery): ProviderAggregate[];
  models(query: AggregateQuery): ModelAggregate[];
  live(query: LiveQuery): LiveSnapshot;
  detailed(query: DetailQuery): DetailPage;
  status(): AnalyticsStatus;
}
interface AnalyticsWriter {
  appendRequestEvent(fact: RequestEventFact): AppendResult;
  appendMeasurement(sample: MeasurementFact): AppendResult;
  appendIdentity(observation: IdentityObservation): AppendResult;
}
interface AnalyticsAdmin {
  migrate(input: VerifiedBackfillSource): MigrationReport;
  prune(policy: AnalyticsRetentionPolicy): PruneReport;
  backup(): BackupReport;
  integrityCheck(): IntegrityReport;
  vacuum(): MaintenanceReport;
  close(): void;
}
interface AnalyticsStore {
  asReader(): AnalyticsReader;
  asWriter(): AnalyticsWriter;
  asAdmin(): AnalyticsAdmin;
}
type AnalyticsRestoreResult =
  | { ok: true; report: AnalyticsRestoreReport; store: AnalyticsStore }
  | { ok: false; report: AnalyticsRestoreReport; store?: never };
interface AnalyticsLifecycleCoordinator {
  open(options: AnalyticsStoreOptions): AnalyticsStore;
  restore(request: AnalyticsRestoreRequest): AnalyticsRestoreResult;
  close(stateDir: string): void;
}
```

`AnalyticsLifecycleCoordinator`, not `AnalyticsAdmin`, owns the connection manager and cached handles. `restore()` must checkpoint the WAL, close and evict the analytics handle, perform WAL-safe replacement of only `analytics.db`, reopen it, then validate schema version, `PRAGMA integrity_check`, and `PRAGMA foreign_key_check`. Only the successful result contains the reopened, usable `AnalyticsStore`; failure returns a typed report with no store and must not expose a closed or unvalidated handle. An admin handle never replaces its own open backing file.

`AppendResult` identifies accepted/duplicate/failed without throwing into the host. Query results include `window`, `generatedAt`, `freshThrough`, and `dataQuality` so clients can distinguish real zeroes, stale data, and unavailable fields.

## 6. `analytics.db` schema

### Lifecycle tables

- `analytics_schema(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, digest TEXT NOT NULL)` — ordered schema versions.
- `analytics_migrations(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, completed_at INTEGER, source_fingerprint TEXT, rows_copied INTEGER, status TEXT NOT NULL, detail TEXT)` — idempotent backfill ledger. Admin-owned.

### Append-only fact tables

- `request_events(id TEXT PRIMARY KEY, correlation_id TEXT, session_id TEXT, repo_id TEXT, turn_id TEXT, event_kind TEXT NOT NULL, observed_at INTEGER NOT NULL, provider TEXT, model TEXT, status TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, duration_ms REAL, ttft_ms REAL, source TEXT NOT NULL, quality_json TEXT NOT NULL)`.
- `measurement_samples(id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, sample_kind TEXT NOT NULL, provider TEXT, model TEXT, value REAL, unit TEXT NOT NULL, correlation_id TEXT, source TEXT NOT NULL, quality_json TEXT NOT NULL)`.
- `identity_observations(id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, provider TEXT, model TEXT, source TEXT NOT NULL, metadata_json TEXT NOT NULL)`.

Allowed `event_kind` values begin with `request_started`, `provider_selected`, `first_token`, `request_completed`, and `request_failed`; additions require a schema/contract migration. A true concurrency series is derived only from correlated start and terminal events. A missing terminal event is marked incomplete and excluded or bounded according to the response's quality note.

### Indexes

- `request_events(observed_at)`
- `request_events(provider, observed_at)`
- `request_events(model, observed_at)`
- `request_events(event_kind, observed_at)`
- `request_events(correlation_id, observed_at)`
- `measurement_samples(sample_kind, observed_at)`
- `measurement_samples(provider, model, observed_at)`
- `identity_observations(provider, model, observed_at)`

All query dimensions are allowlisted; dynamic grouping chooses predefined SQL statements rather than interpolating identifiers.

## 7. Measurement truth and data quality

| Metric | Required source | Rule |
| --- | --- | --- |
| Provider/model | Verified pi event/usage field | Nullable until PMA-0 identifies a stable seam; never infer provider from model text without an explicit mapping source. |
| Request velocity | Count of completed/failed request facts per measured window | Label with window and freshness. |
| Latency | Monotonic request start to terminal response | Persist duration only when both timestamps exist. |
| Concurrency | Correlated request-start and terminal facts | `N/A` until PMA-0/PMA-2 proves both events and crash/timeout reconciliation. |
| TTFT | Request start to actual first streamed token/chunk event | `N/A` unless the host exposes that event. End-to-end latency is not TTFT. |
| TPS | Known output tokens divided by known generation duration | Label **Estimated TPS** unless the provider supplies a measured TPS field; never use total turn time without disclosure. |
| Cache tokens/hit rate | Host usage fields with documented semantics | Keep read/write tokens distinct; include source and sample coverage. |
| Cost | Local pricing tables or existing opted-in cost API | Existing optional cost API remains OFF unless user-enabled; analytics adds no fetch. |

Every aggregate returns sample count, null count, coverage ratio, and notes. UI tooltips explain estimated and unavailable values.

## 8. Ingestion and lifecycle ownership

PMA-0 must inventory actual pi events before choosing adapters. Expected candidates include existing event/runtime seams near `extensions/mega-events/`, but this spec does not assert that start, provider-selected, or first-token hooks exist.

When verified, PMA-2 adds a thin extension adapter that:

1. creates stable event/correlation IDs;
2. normalizes plain host values into contract facts;
3. obtains only `AnalyticsWriter`;
4. appends facts in event order where available;
5. catches/logs failures with `ts`, `event`, source, and non-sensitive IDs;
6. does nothing when the flag is OFF.

The runtime that opens a store asks the lifecycle coordinator to close it. Dashboard routes obtain a reader, never a raw DB. Maintenance obtains admin explicitly for backup/prune/vacuum and obtains the lifecycle coordinator for restore. Restore follows the close-and-evict sequence in §5 before file replacement and reports failures without touching `sqlite.db` or `turns.db`.

## 9. Migration, backfill, retention, and recovery

- **No assumed source.** PMA-0 records actual table columns, units, timestamps, file path, row counts, and ownership for any candidate backfill source.
- **Copy only.** A migration reads a verified source and inserts normalized facts transactionally. It never drops or modifies legacy data.
- **Idempotent.** Source fingerprint plus migration ID prevents recopy. A failed transaction leaves the completion marker unset and retries safely.
- **No synthetic reconstruction.** Missing provider, model, timing, or correlation fields remain null with a quality marker.
- **Defaults proposed for approval in PMA-1:** request events 90 days and high-frequency measurements 30 days, with minimum recent coverage protection. PMA-0 measures expected volume before locking values.
- **Admin-only prune.** Prune is transactional, logs counts/range, and requires a successful `analytics.db` backup first.
- **Integrity.** Open validates schema version; maintenance runs `PRAGMA quick_check`, `integrity_check`, and `foreign_key_check` as appropriate. Release schema-health tooling must be extended to address `analytics.db` explicitly.
- **Backup/restore.** Backups are clearly named `analytics.db.bak-<timestamp>` and use WAL-safe checkpoint/copy behavior. Restore is available only through `AnalyticsLifecycleCoordinator.restore()`, which owns checkpoint, close+evict, file replacement, reopen, schema/integrity/foreign-key validation, and usable-store return; `AnalyticsAdmin` never replaces its own backing file.

## 10. HTTP API contracts

All endpoints are local dashboard endpoints and return typed JSON from `api-contracts/analytics.ts`:

- `GET /api/analytics/status` — feature/store status, schema version, retention, coverage, freshness, and unavailable measurements.
- `GET /api/analytics/providers?from=&to=&provider=&groupBy=` — provider aggregates and pulse series.
- `GET /api/analytics/models?from=&to=&provider=&model=&groupBy=` — model aggregates and stack series.
- `GET /api/analytics/live?window=` — concurrency if measurable, velocity, pulse, timeline, freshness, and quality.
- `GET /api/analytics/detailed?from=&to=&provider=&model=&status=&groupBy=&cursor=&limit=` — filtered buckets plus cursor-paged request stream.
- Maintenance actions use the existing authenticated/guarded maintenance pattern and AnalyticsAdmin; they are not mixed into read endpoints.

`groupBy` is an enum such as `minute | hour | provider | model | status`. Ranges and limits are bounded. Invalid input returns a typed 400; disabled analytics returns a typed disabled state without opening the DB. Route tests call `handleAnalytics` directly with a temporary state directory.

## 11. Dashboard information architecture

`CacheTab.tsx` becomes a thin sub-tab shell before it crosses its soft limit. Existing Overview rendering moves intact to a sibling component; no behavior or endpoint changes are bundled with the move.

### Providers

- Provider pulse chart and freshness marker.
- Provider stats table: requests, success/failure, measured latency percentiles, token/cache totals, coverage.
- Request velocity by provider.
- Filters for time window/provider and grouping.

### Models

- Model pulse and model-stack composition.
- Model stats table with provider, volume, token/cache totals, measured latency, Estimated TPS when valid, and N/A TTFT until measured.
- Filters for time window/provider/model and grouping.

### Live

- Measured concurrency or prominent N/A/data-quality state.
- Request velocity, provider/model pulse, timeline, and recent request stream.
- Manual refresh; 5/10/30-second polling; visibility-aware pause/resume; last-updated and stale state.

### Detailed

- URL-addressable drill-down from an Analyze action.
- Provider/model/status/time filters; minute/hour/provider/model/status grouping.
- Chart/table modes, cursor pagination, and export of currently queried local data only if an existing safe export pattern is approved.

### Layout parity

Card grids use the project's existing drag-and-drop dependency/pattern if still present at implementation time. Order is persisted in namespaced localStorage keys per sub-tab. Import/export validates schema version, known card IDs, uniqueness, and complete/default recovery. Invalid JSON never partially applies. Layout data contains presentation only, never analytics facts or secrets.

## 12. Plexus traceability and parity

| PR | Authored behavior | PMA destination |
| --- | --- | --- |
| [#35](https://github.com/mcowger/plexus/pull/35) | Live dashboard route/surface | Live sub-tab and request/timeline cards |
| [#36](https://github.com/mcowger/plexus/pull/36) | Refresh, polling, stale/visibility controls, provider window | Shared freshness controls; Providers/Live |
| [#38](https://github.com/mcowger/plexus/pull/38) | Velocity and provider/model pulse | Providers, Models, Live |
| [#59](https://github.com/mcowger/plexus/pull/59) | DnD foundation and persisted card order | Namespaced sub-tab card layouts |
| [#60](https://github.com/mcowger/plexus/pull/60) | Analyze drill-down action | URL-addressable Detailed navigation |
| [#61](https://github.com/mcowger/plexus/pull/61) | Detailed analytics, charts, filters/grouping | Detailed sub-tab |
| [#62](https://github.com/mcowger/plexus/pull/62) | Concurrency endpoint/usage views | Instrumentation-dependent Live contract |
| [#63](https://github.com/mcowger/plexus/pull/63) | Layout JSON import/export | Validated per-sub-tab layout exchange |
| [#64](https://github.com/mcowger/plexus/pull/64) | Integrated reorderable live cards | Live/Providers/Models card grids |
| [#68](https://github.com/mcowger/plexus/pull/68) | Correlated in-flight lifecycle tracking | Start/terminal facts only after seam proof |

Required parity inventory: live concurrency (when measurable), velocity, provider/model pulse, provider/model stats, timeline, model stack, request stream, detailed drill-down, filters/grouping, polling/freshness, DnD persistence, and layout import/export. Metrics/Alerts cards subsequently authored by Matt Cowger are explicitly outside required parity and may be proposed separately.

## 13. Security, privacy, and observability

- Data remains local in the configured state directory; no new fetch/HTTP client is added.
- Store plain operational metadata only. Do not persist prompts, responses, tool arguments/results, credentials, API keys, or headers in analytics facts.
- Hash or omit any provider request identifier not needed for local correlation.
- Parameterize values; allowlist sort/group fields; bound windows, page sizes, and import sizes.
- Dashboard routes receive `AnalyticsReader`; ingestion receives `AnalyticsWriter`; maintenance receives `AnalyticsAdmin`.
- Structured events include at least `ts` and `event`: `analytics_recorded`, `analytics_record_failed`, `analytics_migration_completed/failed`, `analytics_pruned`, `analytics_backup_completed/failed`, `analytics_integrity_checked`, and `analytics_closed`.
- `/api/analytics/status` exposes counts and health, not private payloads or filesystem paths.

## 14. Test strategy and mandatory gates

Tests use temporary `MEGACOMPACT_STATE_DIR` values and never a real user database.

- Contract compliance for in-memory and SQLite implementations.
- Capability tests proving reader cannot write and writer cannot prune.
- Append-only/schema tests, parameterized query tests, and duplicate-ID behavior.
- Separate-path/handle tests proving analytics writes do not alter `sqlite.db` or `turns.db`.
- Migration tests with a PMA-0-verified legacy fixture: copy-only, lossless for available fields, idempotent, retryable, and null-honest.
- Retention/backup/restore/integrity/close tests, including WAL and busy-handle cases.
- Adapter tests for flag OFF, missing fields, out-of-order/incomplete lifecycle, and non-fatal write failure.
- Handler tests for filters, grouping, bounds, cursors, disabled state, N/A, and quality metadata.
- React tests for all sub-tabs, empty/error/stale/N/A states, Analyze routing, polling pause/resume, layout validation/import/export, and Overview preservation.
- No mock or synthetic metric is presented as production measurement.

Every implementation sub-sprint must pass before commit:

```bash
npm run build
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
```

Also run file-size checks, schema-health checks extended for `analytics.db`, a flag-off test run, and targeted grep proving no host imports under `src/store/analytics/`. Release readiness is not permission to publish; a later authorized release must use `./scripts/deploy.sh <new-version>`.

## 15. Implementation-ready sub-sprints

### PMA-0 — Discovery and baseline

**Depends on:** none.
**Scope/files:** read-only event/store audit; planning evidence under the implementation PR; no production behavior.
**Tasks:** verify current DB paths/tables/columns and ownership; inventory pi lifecycle events and provider/model fields; prove whether first-token and request-start/terminal correlation exist; baseline volume/latency; record current CacheTab output and flag-off fixture; confirm DnD/layout utilities and exact target files; measure line counts.
**Acceptance:** evidence names exact source seams and units; separate-DB and backfill sources are proven, not assumed; TTFT/concurrency decisions are recorded as measurable or N/A; retention proposal is volume-informed.
**Rollback:** none (research only).
**Gate:** mandatory full gate on the unchanged baseline plus evidence review.

### PMA-1 — Contracts and isolated store

**Depends on:** PMA-0.
**Scope/files:** `src/store/analytics/types.ts` first; then small sibling files for connection, schema, migrations, SQLite/in-memory implementations, read/write/admin, config, and tests.
**Tasks:** approve capability contracts; create `analytics.db`; implement append-only schema/indexes; independent open/close; status; backup/integrity/retention primitives; register default-ON flag and dashboard setting/path exclusion.
**Acceptance:** both implementations pass compliance; DB path differs from all existing stores; each capability is restricted; flag OFF opens no DB; no file crosses its soft limit.
**Rollback:** flag OFF, close/delete additive `analytics.db`, revert new modules.
**Gate:** mandatory full gate plus contract/capability/schema-health/file-size checks.

### PMA-2 — Verified ingestion

**Depends on:** PMA-1 and PMA-0 seam decisions.
**Scope/files:** a split analytics adapter under `extensions/mega-events/` or the verified host seam; narrow runtime lifecycle wiring; tests.
**Tasks:** append identity/request/measurement facts only from verified fields; correlation; incomplete lifecycle handling; structured failure logs; store close wiring; optional copy-only backfill from the verified PMA-0 source.
**Acceptance:** real fixture facts round-trip; TTFT/concurrency remain null unless proven; estimated TPS is labeled; failures are non-fatal; flag OFF matches baseline.
**Rollback:** unregister adapter/backfill; flag OFF; legacy stores remain untouched.
**Gate:** mandatory full gate plus non-fatal, append-only, migration, and flag-off checks.

### PMA-3 — Typed analytics APIs

**Depends on:** PMA-2.
**Scope/files:** `api-contracts/analytics.ts`, contract barrel, `routes-analytics.ts`, delegated route registration, client analytics module, handler tests.
**Tasks:** implement status/providers/models/live/detailed queries; allowlisted grouping; bounded filtering/pagination; quality/freshness fields; reader-only route context.
**Acceptance:** seeded temp DB yields correct aggregates and N/A semantics; invalid queries are typed 400s; disabled state does not open DB; all old routes remain green.
**Rollback:** remove delegated registration/routes; store and ingestion remain harmless behind flag.
**Gate:** mandatory full gate plus route regression and capability checks.

### PMA-4 — Sub-tab shell and Overview preservation

**Depends on:** PMA-3.
**Scope/files:** split `CacheTab.tsx` before growth; sub-tab shell/types; Overview sibling; focused React tests.
**Tasks:** add Overview/Providers/Models/Live/Detailed navigation; preserve Overview markup/data behavior; URL/local state behavior; accessible keyboard/focus semantics.
**Acceptance:** Overview snapshot/behavior matches baseline; flag OFF is byte-identical; empty new tabs fail safely; CacheTab remains below soft limit.
**Rollback:** flag OFF or revert shell while retaining backend.
**Gate:** mandatory full gate plus Overview parity and file-size checks.

### PMA-5 — Providers and Models

**Depends on:** PMA-4.
**Scope/files:** small sub-tab/card/filter/chart modules and React tests; no monolithic tab.
**Tasks:** provider/model pulse, stats, velocity, model stack, filters/grouping, coverage/tooltips, honest Estimated TPS/N/A TTFT.
**Acceptance:** aggregates match API fixtures; null/partial coverage displays truthfully; keyboard/table alternatives exist; no fabricated fields.
**Rollback:** hide sub-tabs behind feature flag; Overview remains available.
**Gate:** mandatory full gate plus UI data-quality and file-size checks.

### PMA-6 — Live, Detailed, and layout parity

**Depends on:** PMA-5 and proven lifecycle instrumentation from PMA-2.
**Scope/files:** Live/Detailed/card-layout modules, Analyze routing, tests.
**Tasks:** concurrency/N/A, timeline, request stream, drill-down, polling/freshness/visibility behavior, DnD, namespaced persistence, validated layout import/export.
**Acceptance:** Plexus parity matrix is complete or explicitly N/A with evidence; no overlapping polls; stale state is visible; invalid layouts recover atomically; details are filterable and paged.
**Rollback:** disable analytics UI/ingestion; local layout keys may be ignored; Overview unchanged.
**Gate:** mandatory full gate plus polling, layout, accessibility, and parity review.

### PMA-7 — Retention, maintenance, docs, and release readiness

**Depends on:** PMA-6.
**Scope/files:** analytics maintenance integration, schema-health tooling, dashboard/operator docs, navigation maps, release checklist; no publish without separate authorization.
**Tasks:** schedule bounded prune through the verified maintenance lifecycle; backup-before-destructive action; close/restore drill; integrity/status UI; privacy and runbook docs; migration/rollback rehearsal.
**Acceptance:** retention and DR drill pass on a disposable state dir; all gates green; docs identify N/A limitations and flags; release diff includes built dashboard only when an authorized release later runs deploy.sh.
**Rollback:** flag OFF, restore analytics-only backup or delete additive DB; do not alter other stores.
**Gate:** mandatory full gate, DR/integrity/schema-health checks, and independent release-readiness review.

## 16. File-size and split plan

- `src/store/analytics/`: one responsibility per file; `types.ts`/`index.ts` remain contract/barrel sized; split query implementations by providers/models/live/detailed.
- `extensions/dashboard-server/routes-analytics.ts`: thin dispatch plus handler delegates if approaching 400 lines. `route-dispatch.ts` receives at most one delegated call/import and must not become the implementation site.
- `extensions/dashboard-client/src/tabs/CacheTab.tsx` is an extensions file currently at 274 lines and is governed by the 400-line extension soft limit. Split out the current Overview before PMA additions would cross that threshold; each new sub-tab and substantial card gets a sibling file.
- Tests split by contract, lifecycle, route, and sub-tab before test soft limits.
- The authoritative spec remains below the 500-line spec limit.

## 17. Rollout and rollback

Roll out append-only and locally: store/contracts, ingestion, APIs, shell, provider/model views, live/detail parity, then maintenance. Existing CacheTab and current stores remain operational throughout. Observe write failures, DB size, query p95, incomplete lifecycle ratio, field coverage, and freshness before declaring parity.

Emergency rollback is `MEGACOMPACT_PROVIDER_MODEL_ANALYTICS=0`: no analytics store open/write/routes/sub-tabs, and pre-program CacheTab behavior remains. `analytics.db` is additive and may remain for later recovery or be removed after backup. Never roll back by deleting or mutating legacy performance data.

## 18. Open questions and recommendations

1. **Which pi events expose request start, provider selection, terminal status, and first token?** Recommendation: PMA-0 must cite signatures and tests; otherwise keep dependent fields N/A.
2. **Is provider identity supplied independently from model?** Recommendation: store null provider until a stable host field is verified; do not parse model names heuristically.
3. **What is the actual current backfill source and DB ownership?** Recommendation: inspect live schema/path via disposable state and record a fingerprint before PMA-1 migration design approval.
4. **What retention defaults fit real event volume?** Recommendation: baseline rows/day and projected DB size in PMA-0, then approve defaults in PMA-1.
5. **Which existing DnD/layout utility is current and dependency-safe?** Recommendation: reuse only after PMA-0 verifies it is shipped; add no package speculatively.
6. **Should analytics be per-stateDir or machine-wide across repos?** Current decision is under each resolved `stateDir`; recommendation: retain `repo_id` in facts so a later approved global reader can aggregate without changing provenance.
7. **Should Matt Cowger's Metrics/Alerts cards be included later?** Recommendation: track as a separate optional follow-up with its own attribution and requirements; do not expand PMA parity silently.

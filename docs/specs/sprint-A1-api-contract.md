# Sprint A1 — Dashboard API Contract

**Date:** 2026-07-21
**Focus:** Formalize all dashboard HTTP endpoints into typed TypeScript contracts
**Priority:** P0 (foundation for React frontend)
**Effort:** S (≈ ½ day)
**Status:** PLANNED
**Depends on:** Existing `extensions/dashboard-server/server.ts` endpoints

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: contract types are pure TypeScript — zero network. No runtime fetch/http.
- PREVENT-011: all interfaces explicitly typed, no `any`.
- No feature creep: only files in SCOPE below.

---

## PROBLEM STATEMENT

The dashboard server (`extensions/dashboard-server/server.ts`, 607 lines) serves 12+ JSON endpoints with ad-hoc response shapes. Types are scattered across `types.ts` (135 lines) with partial coverage. A React frontend needs strict, importable contracts for every endpoint to avoid drift between server responses and client expectations.

**Root cause:** no single source of truth for API shapes; types are implicit in handler code.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-server/api-contracts.ts` (NEW) — all request/response interfaces, endpoint constants, status codes.
- `extensions/dashboard-server/types.ts` — refactor: re-export from `api-contracts.ts` where shapes overlap; keep backward compat.
- `extensions/dashboard-server/api-contracts.test.ts` (NEW) — compile-time structural tests (satisfies checks) + runtime JSON schema validation.

**OUT OF SCOPE:**
- Server handler changes (existing behavior preserved).
- React/frontend code (Sprint B1+).
- New endpoints not already served.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. AUDIT     Enumerate every endpoint in server.ts: GET /, /api/snapshot, /api/version,
             /api/index, /api/repos, /api/summary, /api/drift, /api/servers,
             /api/events (SSE), /api/game-state (GET/PUT), /api/game-scores,
             /api/achievements, /api/perf, /api/diag
2. CONTRACTS extensions/dashboard-server/api-contracts.ts: define EndpointDef<Req,Res>
             for each. Export const ENDPOINTS = { snapshot: {...}, version: {...}, ... }
             with path, method, request schema, response schema. TypeScript interfaces
             for every response payload.
3. RE-EXPORT types.ts: import from api-contracts.ts for shared shapes (Snapshot,
             IndexIndex, IndexRepo, IndexSummary, etc). Keep existing exports working.
4. VALIDATE  api-contracts.test.ts: for each endpoint, verify the response type
             is assignable (compile-time satisfies) and that a sample JSON payload
             matches the schema at runtime (JSON.parse + field presence checks).
5. DOCUMENT  Add JSDoc to every interface field with description + example value.
```

**Key details:**
- `EndpointDef<M, Req, Res>` = `{ method: M; path: string; query?: Req; response: Res; description: string }`.
- SSE endpoint typed as `{ type: 'sse'; path: string; event: string; data: SseEvent }`.
- All numeric fields documented with units (tokens, seconds, bytes, percent).
- Enum-like fields (tier, trigger state, session state) use string literal unions.

---

## QA VERIFICATION ROUND

Before proceeding to B1, verify:

1. **Compile check:** `npm run build` — all existing imports from `types.ts` still resolve.
2. **Test gate:** `npm test` — zero regressions.
3. **Lint:** `npm run lint` — clean.
4. **Regression:** `python3 scripts/regression_check.py --all` — clean.
5. **Guardrails:** `node scripts/guardrails-scan.mjs` — no new network, no `any` types.
6. **Contract completeness:** every `/api/*` endpoint in `server.ts` has a corresponding `EndpointDef` in `api-contracts.ts`.
7. **Backward compat:** `types.ts` re-exports are identical to prior exports (no downstream breakage).
8. **Manual spot check:** import `api-contracts.ts` from a test file and verify `satisfies` against a real snapshot JSON.

---

## ACCEPTANCE CRITERIA

- [ ] `api-contracts.ts` defines typed contracts for all 14+ endpoints.
- [ ] `types.ts` re-exports shared shapes from `api-contracts.ts` without breaking existing consumers.
- [ ] `api-contracts.test.ts` passes: compile-time + runtime validation of sample payloads.
- [ ] `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs` — all green.
- [ ] JSDoc on every interface field.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>   # removes api-contracts.ts; types.ts unchanged
```

No data migration. `types.ts` is additive (re-exports); original types preserved.

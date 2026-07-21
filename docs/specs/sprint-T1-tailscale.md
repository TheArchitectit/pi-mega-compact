# Sprint T1 — Tailscale Remote Access

**Date:** 2026-07-21
**Focus:** Secure remote dashboard access via Tailscale with auth and CSRF protection
**Priority:** P2
**Effort:** M (≈ 1 day)
**Status:** PLANNED
**Depends on:** Sprint D3 (docs/release)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm run build:dashboard && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: Tailscale access is localhost/VPN only. No public internet exposure.
- PREVENT-003: no hardcoded credentials. Auth tokens are generated per-session.
- Security review required before merge.

---

## PROBLEM STATEMENT

The dashboard only works on localhost. Users running pi on a remote machine (SSH, cloud VM) cannot access the dashboard without port forwarding. Tailscale provides a secure VPN mesh, but the dashboard server needs to bind to the Tailscale interface and handle auth/CSRF for non-localhost requests.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-server/server.ts` — bind to `0.0.0.0` when `MEGACOMPACT_DASHBOARD_BIND=ts` (Tailscale interface detection).
- `extensions/dashboard-server/auth.ts` (NEW) — token-based auth for remote access.
- `extensions/dashboard-server/csrf.ts` (NEW) — CSRF token generation + validation.
- `extensions/dashboard-client/src/utils/auth.ts` (NEW) — client-side auth token storage.
- `extensions/dashboard-client/src/hooks/useApi.ts` — add auth headers.
- `extensions/dashboard-client/src/components/RemoteAccessBanner.tsx` (NEW) — shows remote URL.
- `DASHBOARD.md` — add remote access section.
- `README.md` — add Tailscale setup instructions.

**OUT OF SCOPE:**
- Public internet access.
- OAuth/OIDC integration.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. BIND      server.ts: if MEGACOMPACT_DASHBOARD_BIND=ts:
             - Detect Tailscale interface (100.x.x.x range or `tailscale ip`).
             - Bind to that interface instead of 127.0.0.1.
             - Generate random auth token (crypto.randomBytes(32)).
             - Write token to stateDir/.dashboard-auth.
             - Log remote URL to terminal.
2. AUTH      auth.ts: middleware that checks Authorization header.
             - Localhost (127.0.0.1, ::1): always allowed (no auth).
             - Tailscale range (100.x.x.x): require Bearer token.
             - Other: reject (403).
             Token is per-session (regenerated on server restart).
3. CSRF      csrf.ts: generate CSRF token per session.
             - Stored in cookie (httpOnly, sameSite=strict).
             - Validated on PUT/POST requests.
             - Token rotated on server restart.
4. CLIENT    utils/auth.ts: read token from URL hash or manual input.
             Store in sessionStorage. Include in Authorization header.
5. API HOOK   useApi.ts: add Authorization header when token present.
6. BANNER    RemoteAccessBanner.tsx: shown when accessing remotely.
             "Remote access: copy URL with auth token" button.
             Security warning about sharing the URL.
7. CONFIG     env vars:
             MEGACOMPACT_DASHBOARD_BIND=ts (enable Tailscale binding)
             MEGACOMPACT_DASHBOARD_PORT=3000 (fixed port, optional)
8. DOCUMENT   DASHBOARD.md + README.md: Tailscale setup guide.
             Security considerations.
             Troubleshooting.
9. TEST       Unit: auth middleware, CSRF token generation.
             Integration: remote access with token.
             Security: no token → 403, wrong token → 403.
```

---

## QA VERIFICATION ROUND

Final QA round:

1. **Build + Test + Lint + Regression + Guardrails** — all green.
2. **Security review:** auth middleware rejects unauthorized requests.
3. **CSRF:** PUT requests without CSRF token are rejected.
4. **Local:** localhost access works without auth (backward compat).
5. **Remote:** Tailscale access with token works.
6. **Token:** token is random, per-session, not hardcoded.
7. **Banner:** remote access banner shows correctly.
8. **Docs:** Tailscale setup guide is complete.

---

## ACCEPTANCE CRITERIA

- [ ] Dashboard binds to Tailscale interface when configured.
- [ ] Auth token required for non-localhost access.
- [ ] CSRF protection on state-changing requests.
- [ ] Localhost access unchanged (no auth required).
- [ ] Remote access banner shows URL + security warning.
- [ ] Documentation updated with Tailscale guide.
- [ ] Security review passed.
- [ ] All gates green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>
```

Server reverts to localhost-only binding. No data migration needed.

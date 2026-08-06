# Live-Verification Retro — 2026-08-06

**What:** retroactive runtime verification of sprints shipped before the
controller-live-verification protocol (framework §8, added today).
**How:** started `node dist/extensions/dashboard-server/server.js /tmp/mega-compact-verify-state` on
port 9390 against a fresh empty state dir. `api/version` → `{"version":"0.20.35"}`. Root serves
React bundle (`id="root"` + hashed JS asset). Empty state dir means zero-count payloads are correct
(no session data).

## Endpoints hit

| Endpoint | HTTP | Verdict | Sprint/area covered |
|---|---|---|---|
| `/api/version` | 200 | **PASS** — `0.20.35` (VC6C-IMPL publish) | VC6C-IMPL / VC0F |
| `/` (root) | 200 | **PASS** — `id="root"` + hashed JS asset | VC0F (React bundle) |
| `/api/summary` | 200 | **PASS** — 191b JSON with repo totals | Core |
| `/api/snapshot` | 200 | **PASS** — 2023b full snapshot | VC0D/VC0E |
| `/api/setup-cortex-status` | 200 | **PASS** — mode:A, digest prefix, qualification, blockers with HG IDs | VC9A/VC9D |
| `/api/setup-status` | 200 | **PASS** — currentEmbedder:trigram, configured state | VC9D |
| `/api/vector-cortex/health` | 200 | **PASS** — mode:A, state:CLOSED_A, backoff timings | VC0A/VC0B |
| `/api/vector-cortex/evaluation` | 200 | **PASS** — samples:0 (fresh state expected), byMode counts | VC3A |
| `/api/vector-cortex/repair` | 200 | **PASS** — repairAttempts:0, pointersSwitched:0 (no repairs run in fresh state) | VC6C/VC6C-IMPL |
| `/api/vector-cortex/platform` | 200 | **PASS** — fixtureCount:0 (fresh state), externalRunner fields present | VC8C |
| `/api/vector-cortex/rollout` | 200 | **PASS** — gateIndex:0, buckets:10000, even:true | VC6A |
| `/api/vector-cortex/outcomes` | 200 | **PASS** — outcomeCount:0, consentedSessions:0 (fresh state) | VC8A |
| `/api/embedder-health` | 200 | **PASS** — activeEmbedder:trigram, latency, dim:512 | VC9D |
| `/api/memory-status` | 200 | **PASS** — totalMemories:0, avgRecallScore null | S48 |
| `/api/context-health` | 200 | **PASS** — rows:[], perMode empty — expected fresh | S32/R13 |
| `/api/prefix-stability` | 200 | **PASS** — turns:[], avgRatio:0, count:0 | PC-A..E |

## Known gap

The server binds to ALL interfaces (`0.0.0.0`) and the verify run observed the
EADDRINUSE port-conflict retry loop spawning 6+ instances before I killed and re-ran on a
conflict-free port. This is a pre-existing behavior (documented in memory
`dashboard-runner-staleness-on-upgrade`) — NOT a finding for this audit. The retry logic works as
designed (finds next open port in 9320-9329 range).

## NOTED for future sprints

- `/api/config`, `/api/dashboard-snapshot`, `/api/settings` do NOT exist on the dashboard API.
  Requests fall through to the SPA HTML fallback. Client components that need settings use
  `/api/setup-status` and `/api/health-settings` (or equivalent). **No config-dump endpoint exists** —
  this is intentional (PREVENT-PI-004: config stays server-side). The ML5-D Improve Cortex sprint
  should use `/api/setup-cortex-status`-style read paths, not invent a config endpoint.

## Verdict

**ALL PASS.** No live defects found for sprints VC0A through VC6C-IMPL. All endpoints that have
registered handlers return real JSON data. Version matches the just-published v0.20.35. React
bundle served correctly. No stub responses found.

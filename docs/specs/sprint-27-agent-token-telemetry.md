# Sprint 27 — Agent & Sub-Agent Token Telemetry (Plan)

**Date:** 2026-07-17
**Focus:** Surface per-agent and per-sub-agent token usage + status in the mega-compact widget and dashboard.
**Priority:** P2
**Effort:** L (≈3 days, gated on P0 research)
**Status:** DRAFT (plan) — does NOT modify code.
**Depends on:** Sprint 26 (rich cost card), S24 (unified pressure), S25 (cross-repo + model snapshots), mega-runtime widget (S26 full-width panel).

---

## SAFETY PROTOCOLS

- Gate (full): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.
- PREVENT-PI-004: no network. All telemetry is local (in-process events + node:sqlite). No new fetch/HTTP.
- PREVENT-002: any new SQL is parameterized (read-only `DatabaseSync`). No string concat.
- Additive only: new table `agent_runs`; **no change** to `model_snapshots`, `context_chunks`, or the existing widget/dashboard schemas.
- Pi-agnostic: keep new logic in `src/` where possible; extension glue only in `extensions/`.

---

## PROBLEM STATEMENT

Sprint 26 restored the **agents view** to the widget as a *count + status* line (`🤖 N agents` / dimmed `🤖 idle`). That satisfies "see agents / status" at the coarse level — but it does **not** satisfy "see agents or sub agents token usage," because the runtime today only tracks:

- `activeAgents: number` — a live count, incremented on `agent_start`, decremented on `agent_end` (mega-runtime.ts:104, mega-events.ts:132/141).
- `currentTurn: number` — the turn index from `turn_start` (mega-events.ts:209).

There is **no per-agent or per-sub-agent token accounting anywhere** in the extension. `pi`'s `context` event exposes `usage?.tokens` only for the **parent session** (mega-events.ts:257), not per sub-agent. So real per-agent token usage is currently **unobservable** without new instrumentation.

### Current State (grounding for the P0 research)

- `agent_start` / `agent_end` fire with **no token payload** — only the active-count bump (mega-events.ts:132–145). The status line shows `▶ N agents` but no per-agent detail.
- Crew sub-agents are **separate child processes** (`PI_CREW_KIND=subagent`); their token usage is not surfaced to the parent extension.
- `mega-status` (mega-commands.ts:81) shows config/store/model/quality/cross-repo — **no agents section**.
- The S26 full-width widget panel (mega-runtime.ts `panelLine`/`panelBar`) is the right home for an agents block; it currently only renders the count.

---

## SCOPE BOUNDARY

**IN SCOPE (post-P0):**

- New read-only table `agent_runs(repo_root, agent_id, parent_id, role, model, started_at, ended_at, tokens_in, tokens_out, status)` — additive.
- Hook `agent_start` / `agent_end` (+ crew run events once found) to record per-agent token deltas.
- Widget: a compact "Agents" sub-block (under the S26 panel) listing active/recent agents with token usage + status.
- Dashboard: an "Agent Telemetry" card (additive to `dashboard-server.ts`), fed by a new `agentRuns` snapshot field.

**OUT OF SCOPE:**

- Changing `model_snapshots` / `context_chunks` schema.
- Real-time SSE for agent updates (snapshot poll is sufficient).
- Per-token attribution to specific tool calls (out of scope for v1).

---

## EXECUTION DIRECTIONS (gated)

```
P0  RESEARCH  Determine whether `pi` exposes per-agent / per-sub-agent token
              usage to extensions. Investigate (in order):
              (a) `agent_start` / `agent_end` event payloads — do they ever
                  carry token/usage data, or only fire as count signals?
              (b) `ContextEvent` — is there a per-agent variant, or only the
                  parent-session `usage`? (mega-events.ts:252)
              (c) `pi-crew` subagent telemetry — does the durable child-process
                  runtime (PI_CREW_KIND=subagent) emit usage that the parent
                  session aggregates, and is it reachable from an extension?
              (d) `ctx.sessionManager` / crew run APIs for per-agent accounting.
              OUTCOME: either (i) a viable event/API to hook, or
                       (ii) a blocking gap → escalate to a pi-core feature
                       request and descope S27 to "count + status only" (done
                       in S26). Do NOT proceed to P1/P2 until P0 resolves.

P1  SCHEMA    src/store/sqlite.ts: add `agent_runs` table (IF NOT EXISTS) +
              `recordAgentRun(stateDir, row)` + `listAgentRuns(stateDir)`.
              All parameterized; read-only connections where possible.

P2  CAPTURE   mega-events.ts: on the P0-identified signal, compute per-agent
              token delta (snapshot `usage` at agent_start/agent_end, or read
              the subagent usage) and call recordAgentRun(). Guard against
              missing payloads (no-op, not throw).

P3  WIDGET    mega-runtime.ts: add an "Agents" sub-block to the S26 panel
              (after the savings lines) listing active/recent agents:
              `🤖 <id/role> · <model> · ▲<in> ▼<out> tok · <status>`.
              Reuse panelLine() so it stays full-width.

P4  DASHBOARD mega-dashboard.ts + dashboard-server.ts: add `agentRuns` to
              DashboardSnapshot; render an "Agent Telemetry" card (additive).

P5  TEST      Handler-level tests: mock 2+ agent_runs rows, verify widget
              Agents block + dashboard card render; verify empty-state
              ("no agent activity recorded"); verify P0-gap no-op safety.
```

---

## ACCEPTANCE CRITERIA

- [ ] Full gate green: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.
- [ ] **P0 documented**: a short RESEARCH FINDINGS note records whether per-agent token usage is reachable, with the specific event/API (or the blocking gap + escalation).
- [ ] `agent_runs` table added additively; existing schemas unchanged; `guardrails-scan` clean.
- [ ] Widget Agents block renders per-agent token usage + status when data exists.
- [ ] Widget shows "no agent activity recorded" fallback when `agent_runs` is empty.
- [ ] Dashboard "Agent Telemetry" card renders additively (no regression to existing cards).
- [ ] Missing/empty token payloads are a safe no-op (no throw, no NaN).

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>   # removes agent_runs capture + UI
# No migration needed — agent_runs is additive; leave the (empty) table or
# DROP TABLE agent_runs in a follow-up if desired. Existing tables untouched.
```

---

## OPEN QUESTIONS (resolve in P0)

1. Does `pi` aggregate sub-agent usage into the parent `context` event, or is it only visible inside the subagent's own session?
2. Is there a stable `agent_id` / `parent_id` available at `agent_start` for tree rendering (sub-agent → parent)?
3. If per-agent tokens are **not** exposed, is a pi-core event (`agent_usage`) acceptable, or must S27 stay at count+status?

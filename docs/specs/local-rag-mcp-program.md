# Local RAG MCP Server — Future Program (LRMCP-0–LRMCP-8)

**Date:** 2026-08-11
**Owner:** pi-mega-compact
**Status:** FUTURE SPEC — planning only; implementation must not begin before LRMCP-0 closes both release blockers
**Depends on:** existing `sqlite.db`, canonical `turns.db`, repo registry, local embedder, and optional redundant PGlite indexes
**Reference reviewed:** [TheArchitectit/memory-mcp](https://github.com/TheArchitectit/memory-mcp)

## 1. Vision and definition of “full”

Ship an explicitly started, local MCP server that gives clients bounded, provenance-rich read access to every meaningful RAG corpus stored by pi-mega-compact: checkpoints, durable memories, turns and conversations, recall provenance, fork lineage, topics, wiki pages, RAPTOR hierarchy, and concrete CRAG/HyDE quality telemetry.

“Full RAG access” means complete supported **retrieval and provenance** coverage through stable contracts. It does not mean raw SQLite, embeddings, compressed originals, transcripts, filesystem access, or database administration. Those bypass scope, projection, and provenance and are not RAG consumption APIs.

Protocol v1 is read-only. A separately granted append-only durable-memory writer may receive a future security spec. Delete, replace, restore, prune, vacuum, checkpoint mutation, raw SQL, rewind, and fork creation are permanently excluded from the public MCP surface.

## 2. Locked decisions and non-goals

1. Canonical transport is MCP stdio via npm bin `pi-mega-compact-mcp`; no server starts automatically with pi.
2. Use the official `@modelcontextprotocol/sdk` and `zod` as direct runtime dependencies; never rely on their current transitive presence.
3. Runtime floor is Node `>=22.13`, matching `package.json` and `node:sqlite`, regardless of the SDK's lower floor.
4. HTTP, SSE, Streamable HTTP, WebSocket, listeners, CORS, and remote access are out of scope. Any later transport requires a separate security spec, explicit operator opt-in, and PREVENT-PI-004 audit.
5. The server adds no database. It reads existing authoritative stores using narrow reader capabilities and owns dedicated/cached lifecycle handles.
6. Startup establishes immutable repo/session grants. Tool arguments use only server-issued opaque aliases, never paths or raw database identifiers.
7. Same-repo and explicitly allowed sessions are the default. Cross-repo access is a separate startup grant with separately visible tools.
8. Tools are the primary query surface. Bounded read-only resources may follow proven authorization-before-enumeration. Prompts are deferred because no concrete need exists.
9. A single `McpRagReader` trust-boundary facade owns authorization, row validation, projection, redaction, caps, provenance, and lifecycle.
10. No network-backed embedder, Ollama generation, cost API, pricing lookup, agent, swarm, GitHub, web search, subprocess, or dynamic client code runs during MCP requests.
11. stdout is JSON-RPC only. Human diagnostics use stderr; privacy-safe structured events use a protected local log.
12. Package distribution remains npm-only; `scripts/deploy.sh` is the only release path. `npm pack --dry-run` may inspect contents, but no `.tgz` may be created or used.
13. An optional `/mega-mcp` pi command may print validated status and client configuration help only. It must not detach or launch a stdio server.

## 3. memory-mcp review: reuse and reject

| memory-mcp pattern | Decision for pi-mega-compact |
| --- | --- |
| Slim MCP gateway | Reuse as a thin `server.ts`; no data logic in protocol handlers. |
| Declarative public tool registry | Reuse with Zod schemas and immutable grant-driven visibility. |
| Separate dispatcher | Reuse for validation, deadlines, concurrency, errors, and handler routing. |
| PUBLIC/INTERNAL/ADMIN visibility | Adapt to `public`, `repo-read`, `session-read`, `cross-repo-read`, and `resource-read`; retain store capability gates beneath dispatch. |
| Typed tool schemas and protocol integration tests | Reuse with official TypeScript SDK initialize/list/call/resource tests. |
| Python/FastAPI/Postgres/pgvector/Redis/Ollama | Reject; this project is TypeScript, local `node:sqlite`, with redundant local PGlite only. |
| HTTP/SSE/CORS, `0.0.0.0`, optional authentication | Reject; stdio only and no listener in this program. |
| API keys/cloud credentials/GitHub/web/agent/swarm tools | Reject; no network or credential-bearing tool surface. |
| Checkpoint delete/archive and other destructive tools | Reject permanently from MCP public access. |
| Broad repository/file path inputs and partial validation | Reject; paths are startup-only operator inputs and clients receive opaque aliases. |
| Errors returned as successful text | Reject; use protocol errors and stable typed result errors. |

The reference implements tools but no resources or prompts; it supplies no precedent for weakening resource authorization or adding generic prompts.

## 4. Authority and source seams

| Corpus/capability | Authority and approved seam | MCP rule |
| --- | --- | --- |
| Checkpoints | per-repo `sqlite.db`; `src/store/sqlite/checkpoints.ts`, `src/vector-search.ts`, `src/store/sqlite/fts5-search.ts` | Filter removed rows; semantic search must remain pure; hydrate accelerator hits from authoritative rows. |
| Durable memories | per-repo `sqlite.db`; `src/store/sqlite/memories.ts`, `src/memoryRecall.ts` | Semantic recall always passes `markReferenced:false`; content is sensitive and projected/redacted. |
| Turns/conversations/recall/forks | canonical `turns.db`; `src/store/turns/types.ts` `TurnReader`, `src/store/turns/sqlite-store/read.ts` | Never import legacy `src/store/sqlite/turns.ts`; expose immutable lineage only. |
| Topics/wiki | canonical `turns.db`; `src/topics/store.ts`, `src/topics/types.ts`, `src/wiki.ts` | Read projections only; no rename/merge/split/curation mutations. |
| RAPTOR | per-repo `sqlite.db`; `src/store/sqlite/raptor.ts`, `src/dedup/raptor/multilevel.ts` | Hide vectors; preserve level, summary, hierarchy, freshness, and uncalibrated markers. |
| CRAG/HyDE quality | `src/recallMetrics.ts`, persisted turn telemetry in `src/store/turns/hydeStore.ts` | Expose concrete metrics only; never invent a unified self-RAG result contract or return hypothetical HyDE documents by default. |
| Repo discovery | global `index.sqlite`; `src/store/sqlite/global-index.ts` | Startup resolution and granted alias discovery only; never expose `stateDir`, raw roots, rates, or secrets. |
| Vector acceleration | `src/store/vectorIndex.ts`, `src/store/memoryIndex.ts` | PGlite is redundant and optional; failure falls back only within the same authoritative scope. |

`recallAndInline` and its async path are forbidden because they mutate injection state. `vectorSearch` is the pure checkpoint seam. Legacy gzipped JSON checkpoints are DR artifacts, not an MCP authority. No MCP request may call maintenance, injected-set mutation, index rebuild, or self-heal deletion.

## 5. Architecture and module budget

```text
MCP client → bounded stdio → server → declarative registry → dispatcher
    → McpRagReader(scope + projection + redaction + limits)
        → checkpoint/memory sqlite.db readers
        → canonical TurnReader + topic/wiki readers
        → RAPTOR/quality readers
        → optional PGlite accelerator, authoritative hydration/fallback
```

All production files remain below the 300-line `src/` soft limit; `types.ts` and `index.ts` remain below 100 lines.

| Proposed module | Responsibility |
| --- | --- |
| `src/mcp/types.ts`, `src/mcp/reader-types.ts` | Envelopes, grants, aliases, errors, limits, and narrow `McpRagReader` contract. |
| `src/mcp/config.ts`, `src/mcp/startup.ts` | CLI/env parsing, realpath containment, repo/session grant resolution, environment sanitization. |
| `src/mcp/aliases.ts`, `src/mcp/scope.ts` | Process-local opaque aliases, immutable scope checks, indistinguishable unknown/unauthorized handling. |
| `src/mcp/projection.ts`, `src/mcp/redaction.ts`, `src/mcp/limits.ts` | Single egress trust boundary, secret filtering, untrusted labels, row/byte/token/deadline accounting. |
| `src/mcp/reader.ts`, `src/mcp/readers/*.ts` | Capability-gated composition over existing stores; no raw/god handles escape. |
| `src/mcp/registry.ts`, `src/mcp/dispatcher.ts`, `src/mcp/errors.ts` | Zod schemas, grant-driven visibility, deadlines, cancellation, concurrency, stable errors. |
| `src/mcp/handlers/*.ts` | Thin domain handlers grouped by checkpoints, memories, turns, topics/wiki, RAPTOR, quality, and cross-repo. |
| `src/mcp/resources.ts` | Bounded opaque resource templates and reads, gated after authorization proof. |
| `src/mcp/audit.ts` | Privacy-safe JSON-line events. |
| `src/mcp/server.ts`, `src/mcp/stdio.ts`, `src/mcp/cli.ts` | SDK registration, bounded stdio, executable lifecycle, protocol-only stdout. |

The ledger rule holds: the MCP host pulls views; stores never call clients or emit subscriptions.

## 6. Startup, grants, aliases, and environment

Canonical use:

```bash
pi-mega-compact-mcp --repo-root /workspace/project --session session-1
```

With no `--repo-root`, startup resolves the real Git root of `cwd`, requires an unambiguous registered state mapping, and fails closed otherwise. `--session` is repeatable; omitting it succeeds only when the current session is uniquely discoverable. `--all-sessions` explicitly allows bounded discovery in the primary repo. `--allow-repo <path>` and `--allow-cross-repo` are separate operator grants and default off. Advanced `--state-dir` and `--log-file` are startup-only, realpath-validated operator inputs.

Namespaced env equivalents are `MEGACOMPACT_MCP_REPO_ROOT`, `_STATE_DIR`, `_SESSIONS`, `_ALL_SESSIONS`, `_ALLOWED_REPOS`, `_ALLOW_CROSS_REPO`, `_MAX_RESULTS`, `_DEADLINE_MS`, and `_MAX_CONCURRENCY`; CLI wins. Empty, duplicate, malformed, unregistered, ambiguous, permission-unsafe, or symlink-escaping grants fail before stores open.

A frozen `StartupGrant` contains the primary repo, allowed sessions, optional additional repos, cross-repo bit, and immutable limits. Clients receive process-local aliases (`repo_*`, `sess_*`, `conv_*`, `cp_*`, `mem_*`, `turn_*`, `topic_*`) bound to original scope. Aliases reveal no path/raw ID and cannot be replayed across processes or grants.

MCP bootstrap must ignore/clear network-affecting embedding, remote-embedder, Ollama, and cost-API variables. Request paths use the self-contained local embedder or lexical/precomputed-vector readers and never spawn subprocesses.

## 7. Result and error contract

Every successful tool/resource returns `McpResultEnvelope<T>` with:

- `schemaVersion: "1.0"`, `requestId`, and effective alias-only `scope`;
- typed `data` and `provenance` (`authoritativeStores`, retrieval tier, source aliases);
- `redaction` (applied fields/reason codes) and `truncation` (rows, bytes, estimated tokens, opaque continuation);
- optional `quality` with explicit `calibrated`/`uncalibrated` state and concrete CRAG/HyDE fields;
- `freshness`, `degraded`, stable `errors`, and `untrustedContent: true` for stored text.

Stable codes include `INVALID_INPUT`, `ACCESS_DENIED`, `UNKNOWN_ALIAS`, `SCOPE_MISMATCH`, `REDACTION_FAILED`, `LIMIT_EXCEEDED`, `DEADLINE_EXCEEDED`, `CANCELLED`, `STORE_BUSY`, `INDEX_UNAVAILABLE`, `SOURCE_UNAVAILABLE`, `IDENTITY_AMBIGUOUS`, and `INTERNAL_ERROR`.

Authorization, alias, scope, redaction, row-validation, and cap-accounting failures return no data. SQLite busy/index failures are non-fatal to the process and may return retryable or degraded output only when same-scope authoritative fallback succeeds. Missing telemetry is `unavailable`, never synthesized.

## 8. Exact protocol-v1 tool inventory

Defaults: query ≤8 KiB; any string ≤16 KiB; default 10/hard 50 rows; per-item text ≤4 KiB; response ≤1 MiB and estimated 8,000 tokens; default 5 s/hard 30 s deadline; default 2/hard 4 concurrent requests. Continuations are opaque and scope-bound.

| Tool | Required input; optional input | Visibility and bounded output |
| --- | --- | --- |
| `rag_capabilities` | none | Public: protocol/schema versions, granted capabilities, visible tools/resources, effective limits, non-mutating store health. |
| `rag_list_sessions` | none; limit, continuation | Repo-read/all-sessions grant: session aliases and bounded metadata only. |
| `rag_search_checkpoints` | session alias, query; mode `semantic|lexical|hybrid`, time range, limit | Session-read: projected hits, scores, retrieval provenance, resource URIs. |
| `rag_get_checkpoint` | checkpoint alias; projection level | Session-read: bounded summary/decisions/next steps after redaction; no original/vector/raw transcript. |
| `rag_search_memories` | session alias, query; category, time range, limit | Session-read: semantic/lexical memory projections using `markReferenced:false`. |
| `rag_list_conversations` | session alias; range, limit, continuation | Session-read: conversation aliases and computed stats. |
| `rag_get_conversation` | conversation alias; turn range, limit, continuation | Session-read: bounded turn projections and recall counts. |
| `rag_get_turn` | turn alias; include projected recall | Session-read: one turn projection and optional resource URI. |
| `rag_get_recall_provenance` | turn alias; source filter, limit | Session-read: checkpoint/memory/cluster provenance, scores, RAPTOR levels. |
| `rag_list_forks` | conversation alias; direction, limit | Session-read: immutable parent/child/fork-point lineage only. |
| `rag_list_topics` | session alias; limit, continuation | Session-read: topic aliases, labels, counts, confidence/method. |
| `rag_get_wiki_page` | topic alias; related-topic limit | Session-read: bounded extractive page, key/recent memory aliases, related topics, provenance. |
| `rag_search_raptor` | session alias, query; level range, limit | Session-read: hierarchy/search summaries and levels; no embeddings. |
| `rag_get_quality` | session alias; turn alias, time range, limit | Session-read: concrete CRAG metrics/calibration and HyDE ran/skipped/count/lift/latency telemetry. |
| `rag_list_granted_repos` | none | Cross-repo-read only: granted repo aliases and bounded aggregate metadata, never paths. |
| `rag_search_cross_repo` | query, one or more granted repo aliases; corpus `checkpoint|memory|all`, limit | Cross-repo-read only: per-repo quota, authoritative hydration, explicit source provenance. |

No omitted repo/session filter may mean “all.” Unknown or unauthorized aliases use indistinguishable denial semantics. Lexical/hybrid modes remain disabled for scopes affected by the FTS identity blocker until LRMCP-0 resolves it.

## 9. Resources and prompts

Candidate resource templates are `mega-rag://checkpoint/{alias}`, `mega-rag://memory/{alias}`, `mega-rag://turn/{alias}`, and `mega-rag://wiki/{alias}`. They return the same envelope, projection, redaction, and caps as corresponding tools; they are views, not files.

LRMCP-5 registers resource reads/templates/listing only if the SDK permits authorization before enumeration. Forged or cross-scope aliases disclose nothing. If that proof fails, item URIs may remain in tool results but resource registration is deferred without reducing tool completeness. Protocol-v1 prompts remain out of scope.

## 10. Security, privacy, and failure policy

| Threat | Required control |
| --- | --- |
| Client path traversal/symlink escape | No client paths; startup realpath containment, ownership/mode checks, regular-file validation, and no registry traversal outside grants. |
| Cross-repo/session leakage | Same-repo/session default, immutable grants, opaque aliases, separate cross-repo tools, per-repo quotas. |
| Secret-bearing or injected stored text | Central credential/private-key/token redaction, bounded projections, `untrustedContent`, no automatic execution. |
| SQL/FTS injection | Parameterized SQL and allowlisted filters/order; no raw SQL, PRAGMA, ATTACH, arbitrary columns, or client-built MATCH syntax. |
| Context flooding/DoS | Frame, depth, schema, query, rows, bytes, tokens, deadline, queue, and concurrency caps before and after store reads. |
| Mutation through reads | `McpRagReader` only; no writer/admin handle; no inline recall; `markReferenced:false`; mutation-free hash/timestamp tests. |
| Malformed/corrupt rows | Validate scalars, finite scores/timestamps, enums, string/array lengths, BLOB dimensions; fail closed when scope/provenance is invalid. |
| Network exfiltration | stdio only, sanitized env, local embedder, socket/DNS/fetch/spawn denial tests. |
| stdout corruption | SDK frames only on stdout; warnings/help/status to stderr; protocol parsing test under failures. |
| SQLite contention | Dedicated bounded readers, WAL-compatible lifecycle, semaphore, busy timeout below request deadline, typed `STORE_BUSY`; never delete WAL/SHM. |
| Accelerator poisoning | Authoritative SQLite hydration and same-scope fallback; PGlite never authority. |
| Audit becoming a privacy store | Log aliases, tool, duration bucket, counts, status/error only; never query/content/raw ID/path/env/SQL/secret. |

Fail closed for visibility, authorization, scope, path, alias, redaction, accounting, and mutation-audit failures. A malformed row with valid scope may be skipped with a count; malformed provenance fails that result/query. Read-only process health survives retryable busy/index/source failures.

Local same-user processes can still read files directly; MCP does not replace OS permissions or disk encryption. Heuristic redaction and downstream prompt-injection resistance remain residual risks and must be documented.

## 11. Stdio lifecycle and release blockers

The official SDK uses newline-delimited UTF-8 JSON-RPC, validates messages/tool schemas, and awaits stdout backpressure. The CLI validates startup before protocol output, connects one server/transport, handles client cancellation, and performs idempotent shutdown on EOF, SIGINT, SIGTERM, SIGHUP, transport close/error, and startup failure. Shutdown stops admission, cancels queued work, allows bounded active-work grace, closes each owned SQLite/PGlite handle exactly once, and sets an exit code without truncating output.

`DatabaseSync` cannot be interrupted mid-statement. Cancellation/deadlines are checked before and after every bounded indexed stage; expired results are suppressed. No recursive or unbounded query may ship.

Two **LRMCP-0 release blockers** are non-negotiable:

1. **Inbound frame bound:** the installed SDK buffers until newline without a visible cap. Prove a 1 MiB bounded-stream/transport seam, upgrade to an audited SDK seam, or implement a small spec-conformant bounded transport around SDK message types. Do not ship unbounded input.
2. **Checkpoint identity:** current unscoped FTS hydration can use checkpoint `id` without composite repo/session identity. Correct it or constrain the feature before unscoped, all-session, or cross-repo lexical/hybrid search ships.

## 12. Packaging, client configuration, and observability

Implementation adds a shebang CLI and manifest entry targeting the actual emitted path, expected as:

```json
{"bin":{"pi-mega-compact-mcp":"./dist/src/mcp/cli.js"}}
```

A client then configures `command: "pi-mega-compact-mcp"` with startup `args` for repo/session grants. `scripts/deploy.sh` must use `npm pack --dry-run --json` to assert the bin target and all MCP runtime modules are listed, while retaining dashboard assertions. No tarball is created. A production-install smoke test initializes, lists tools, calls a bounded tool, checks every stdout line as JSON-RPC, and exits cleanly on EOF/SIGTERM.

Audit events are append-only JSON lines with `ts`, `event`, request ID, tool, alias-only scope, duration bucket, row/byte counts, degraded/fallback flags, and stable outcome code. They never drive control flow.

## 13. Testing and mandatory gate

Tests cover contract/capability separation, grant visibility, alias forgery/replay, default isolation, cross-repo denial, schema/FTS injection, secret redaction, untrusted-content labeling, response flooding, mutation-free reads, malformed rows, busy/WAL concurrency, index fallback, cancellation/deadlines, oversized frames/deep JSON/floods, audit privacy, network denial, protocol stdout, EOF/signals, resources, npm-installed bin, and all 16 tool contracts.

Every LRMCP sprint ends with:

```bash
npm run build
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
```

No failing/partial sprint is marked complete. Planning branches do not version, publish, or run deploy.

## 14. Gated implementation sprints

### LRMCP-0 — Discovery and contracts

**Depends:** none. **Files:** `src/mcp/types.ts`, `reader-types.ts`, `config.ts`, contract/discovery tests, and this spec updates. **Tasks:** resolve composite FTS identity; prove bounded SDK transport, cancellation, EOF, and resource authorization seams; inventory persisted CRAG/HyDE fields; lock aliases, grants, limits, envelopes, all tool/resource schemas, and direct dependency versions. **Acceptance:** both release blockers closed by tests; contract independently approved; no implementation beyond proof seams. **Rollback:** remove additive contracts/proofs; existing runtime untouched. Run the mandatory gate.

### LRMCP-1 — Reader facade, scope, projection, and redaction

**Depends:** LRMCP-0. **Files:** `src/mcp/{aliases,scope,projection,redaction,limits,reader}.ts`, `readers/*.ts`, focused tests. **Tasks:** build process-local aliases, immutable grants, dedicated/cached handle lifecycle, row validation, projection/redaction, authoritative hydration, and mutation-free checkpoint/memory/turn/topic/RAPTOR/quality readers. **Acceptance:** facade types expose no writer/admin; scope/redaction/accounting failure returns no data; hashes/reference/injection timestamps remain unchanged. **Rollback:** delete additive facade; no protocol wiring exists. Run the mandatory gate.

### LRMCP-2 — Registry and dispatcher

**Depends:** LRMCP-1. **Files:** `src/mcp/{registry,dispatcher,errors}.ts`, status handler, tests. **Tasks:** declarative Zod schemas, grant-driven registration, duplicate/unknown request handling, semaphore, deadlines/cancellation, response caps, stable envelopes/errors. **Acceptance:** invisible tools cannot be listed/dispatched; invalid inputs never reach readers; caps and indistinguishable denials pass. **Rollback:** remove registry/dispatcher. Run the mandatory gate.

### LRMCP-3 — Core checkpoint and memory tools

**Depends:** LRMCP-2. **Files:** `src/mcp/handlers/{sessions,checkpoints,memories}.ts`, integration tests. **Tasks:** implement session listing, checkpoint semantic/lexical/hybrid search/detail, and memory search with `markReferenced:false`; add truthful unavailable/degraded states. **Acceptance:** no raw vectors/originals/transcripts/paths leak; FTS composite identity holds; busy/index behavior is typed and same-scope. **Rollback:** unregister domain handlers. Run the mandatory gate.

### LRMCP-4 — Turns, provenance, topics/wiki, RAPTOR, and quality

**Depends:** LRMCP-3. **Files:** handlers for conversations, turns, topics/wiki, RAPTOR, quality, cross-repo; tests. **Tasks:** complete remaining 16-tool inventory using canonical `TurnReader`; expose immutable forks, topic/wiki provenance, RAPTOR hierarchy, concrete CRAG/HyDE telemetry, and separately granted cross-repo search. **Acceptance:** legacy turns API is absent from module graph; uncalibrated/unavailable quality is explicit; accelerator hits hydrate authoritatively. **Rollback:** unregister each domain independently. Run the mandatory gate.

### LRMCP-5 — Read-only resources

**Depends:** LRMCP-4. **Files:** `src/mcp/resources.ts`, resource tests. **Tasks:** implement four opaque URI projections; register templates/listing only after authorization-before-enumeration proof. **Acceptance:** resources equal tool projections/caps; forged/cross-scope aliases disclose nothing; safe deferral path is tested. **Rollback:** disable resource registration; tools remain full. Run the mandatory gate.

### LRMCP-6 — Stdio CLI, lifecycle, and hardening

**Depends:** LRMCP-2–5. **Files:** `src/mcp/{server,stdio,cli,audit}.ts`, protocol/lifecycle tests. **Tasks:** official SDK wiring, proven 1 MiB frame bound, protocol-only stdout, env sanitization, privacy audit, EOF/signal/error cleanup, cancellation and backpressure. **Acceptance:** initialize/list/call/resource tests pass; oversized/deep/flood input stays bounded; no network/subprocess; every handle closes once. **Rollback:** remove bin registration/wiring; additive readers remain dormant. Run the mandatory gate.

### LRMCP-7 — Package, deploy gate, docs, and client examples

**Depends:** LRMCP-6. **Files:** `package.json`, dependency lock update through normal npm workflow, `scripts/deploy.sh`, README/install docs, map updates, optional informational command. **Tasks:** add direct SDK/Zod dependencies and bin; add dry-run package assertions and clean-install handshake; document grants, examples, troubleshooting, and no-auto-start behavior. **Acceptance:** npm install exposes executable; dry-run includes complete runtime/dashboard without creating `.tgz`; `/mega-mcp` cannot launch. **Rollback:** remove bin/dependencies/assertion/UX. Run the mandatory gate; do not publish during sprint development.

### LRMCP-8 — Security, parity, and release readiness

**Depends:** LRMCP-0–7. **Files:** security/conformance fixtures/tests and release evidence docs. **Tasks:** close the threat matrix; verify all tools/resources, malicious clients, redaction, cross-repo denial, concurrency/busy/cancellation, network denial, audit privacy, package install, and protocol handshake. **Acceptance:** all 16 tools accounted for; no public mutation/admin or network path; both blockers remain proven closed; full gate and dry-run manifest green. **Rollback:** do not publish; disable/remove bin. A released rollback, if ever needed, uses a new npm version through `./scripts/deploy.sh <version>` only. Run the mandatory gate.

## 15. Program acceptance and rollback

The program is complete only when the curated inventory covers every listed RAG corpus, all public types are read-only, grant/alias/redaction boundaries pass adversarial tests, stdout is protocol-clean, no request causes network or store mutation, both LRMCP-0 blockers are closed, package installation works, and the full release gate passes.

Before publication, rollback is removal of the additive bin/registry; existing extension behavior and stores remain unchanged because no server auto-starts and no schema/database is added. After publication, never force or republish a version: issue a new npm release through authoritative `scripts/deploy.sh` and instruct devices to `pi update --extensions`.

# S27 — DB Mirror: Byte-Stable Prompt Cache via a Raw Transcript Mirror

**Date:** 2026-07-17
**Parent plan:** feat/cache-stability (root-cause: per-turn prompt-cache miss on the live-trim path)
**Depends on:** S16 live context-trim (`extensions/mega-events.ts:257-356`), Sprint 8 SQLite backbone (`src/store/sqlite.ts`), S24 unified pressure
**Priority:** P0 (every cache hit is full-context re-bill on the provider — direct $ + latency win)
**Status:** Draft → implement-ready
**Target version:** v0.7.0

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001 (anchor floor):** The byte-stable reconstruction MUST still preserve the last N user messages. The cut index handed to pi is produced by the existing `src/boundary.ts` `computeDropRange` (already the authority at `mega-events.ts:320`); this spec never recomputes it. The reconstruction just replays the same `[summary, ...messages.slice(cut)]` as the legacy path — so the anchor floor + tool-pair guard are structurally inherited, not re-implemented.
- **PREVENT-PI-002 (tool-pair-safe cut):** Same as above — `cut` is the pre-sanitized `compactedFrom` from `computeDropRange`. The reconstruction MUST `slice(cut)` the original pi `AgentMessage[]` (the stored raw bytes, not a re-serialized copy), so the preserved run begins on a toolPair-safe index. The new code path MUST NOT introduce any re-slicing or re-ordering of the recent tail.
- **PREVENT-PI-003 (no `role:"system"`):** The summary is still injected as a synthesized **user-role** `AgentMessage` (unchanged at `mega-events.ts:344-348`). Recall-side injection continues to go through `before_agent_start` systemPrompt prepend (`src/recall.ts:10-14`). No new system messages are introduced anywhere.
- **PREVENT-PI-004 (zero network):** The raw_transcript mirror lives in the existing local `node:sqlite` store (`openStore`, in-process, FS-backed). No `fetch`/HTTP. The optional `/dashboard` localhost server exception (`PREVENT-PI-004` inline-annotated) is untouched. PGlite vector index stays async/redundant/additive (`MEGACOMPACT_PGLITE_DISABLED` kill-switch unchanged).
- **PREVENT-002:** All new SQLite access uses parameterized prepared statements (`@param` placeholders), mirroring the existing `sqlite.ts` style. Never string-concatenate.
- **PREVENT-011:** No `any` in new code. Type the new mirror rows explicitly (`RawTranscriptRow`, `CheckpointEpoch` interfaces).
- **Determinism invariant (NEW, supersedes `Date.now()` on the serve path):** The served `[summary, ...recent]` reconstruction MUST be byte-identical across every `context` event in the same **checkpoint epoch**. A checkpoint epoch is the closed interval between two committed `compactSession` runs. The epoch nonce is derived FROM the checkpoint id (content-addressed, monotonic), never `Date.now()`/`uuid`/`crypto.randomUUID()`. The only dynamic field on the served summary message — `timestamp` (currently `Date.now()` at `mega-events.ts:349`) — is replaced by the epoch nonce. Per-call `Date.now()`/`debounceUntil` are fine for *gating* (fast-gate, debounce) but MUST NOT appear in the returned message bytes.
- **Migration / orphaned consumers:** The legacy live-trim path (`mega-events.ts:291-296` `ctx.compact()` gate + the S16 `computeLiveTrimCut` path) stays fully intact and is the default. The new mirror path is additive, gated behind `MEGACOMPACT_DB_MIRROR` (default OFF). Compress/dedupe artifacts continue to land in the EXISTING `context_chunks` / `minhash_signatures` / `dedup_lsh_buckets` / `raptor_nodes` / vector tables — no schema migration of those tables, no forked artifact tables.
- **Guardrails gate:** every change must pass `npm run lint` + `python3 scripts/regression_check.py --all` + `scripts/guardrails-scan.mjs`. (PREVENT-PI-004 scan tolerates only annotated localhost dashboard fetches; new code adds none.)

---

## PROBLEM

**Root cause — per-turn prompt-cache miss on the live-trim path.**

Once `currentTokens >= config.thresholdTokens`, the `context` handler returns a trimmed window (`mega-events.ts:349-356`):

```ts
const summaryAgentMsg = {
  role: "user" as const,
  content: summaryMsg.text,
  timestamp: Date.now(),          // ← (A) NEW VALUE EVERY CALL
} as unknown as AgentMessage;
const recent = messages.slice(cut);  // ← (B) SHIFTING SLICE
return { messages: [summaryAgentMsg, ...recent] };
```

Two cache-busters:

1. **(A) `timestamp: Date.now()`** — a fresh epoch-ms per `context` event. pi's prompt cache keys on the leading message bytes; a changing timestamp on the second message (the synthesized summary) invalidates the cached prefix on EVERY context event within the same turn window. `showCacheMissNotices` (pi docs settings, lines 87–93) surfaces the resulting miss-per-turn.
2. **(B) shifting `slice(cut)`** — `cut` recomputes as `compactedFrom` advances on each compaction; the recent tail shifts, so even with a stable summary the served window byte-stream drifts between calls.

**Compounding design issue:** the SQLite `context_chunks` table stores *post-compression* summaries + token estimates, NOT the raw transcript bytes. So there is no byte-stable source to replay from — every serve recomputes from the live `messages[]` array, which by definition is mutable across events. The cache cannot stabilize while the source of truth is the live array.

**Goal:** make the served window byte-stable within a checkpoint epoch by inverting the data flow — a raw, append-only, content-addressed mirror becomes the cache-stable source, and compression/dedupe run on a *copy* of a landed snapshot, feeding recall only (never the live turn stream).

---

## SCOPE

### IN

1. New append-only `raw_transcript` table in `src/store/sqlite.ts` (schema bump `SCHEMA_VERSION` 1 → 2; additive, no migration of existing tables — `CREATE TABLE IF NOT EXISTS`). Columns: `content_hash` (PK, content-addressed, SHA-256 hex of canonicalized message bytes), `session_id`, `seq` (monotonic per session), `role`, `content_bytes` (verbatim serialized content: JSON of the pi message shape, stable key order), `tool_name`, `timestamp` (the ORIGINAL message timestamp captured at append time — NOT used as a served key), `checkpoint_epoch` (the epoch nonce this message belongs to).
2. New `checkpoint_epochs` table: `epoch_id` (PK, deterministic — derived from the triggering checkpoint id, e.g. `"epoch:" + checkpoint.id`), `session_id`, `started_seq`, `committed_seq`, `summary_message_text`, `cut_index`, `created_at` (informational only). One row per committed `compactSession`; written by the mirror path after the snapshot forks.
3. New helpers in `src/store/sqlite.ts`: `appendRawTranscript(row)`, `listRawTranscriptSince(sessionId, epochId)`, `writeCheckpointEpoch(epoch)`, `readCheckpointEpoch(epochId)`, `getActiveEpoch(sessionId)`. All parameterized. `appendRawTranscript` is idempotent on `content_hash` (INSERT OR IGNORE) so re-appends on retries are safe.
4. Config flag `MEGACOMPACT_DB_MIRROR` (default **OFF**) added to `extensions/mega-config.ts` via the existing `envBool(...)`, alongside `legacyDurableTrim`. Mirrors the S16 precedent of gating a new live-trim path behind a flag for one release.
5. `context` hook (`mega-events.ts:257-356`) rewrite behind the flag:
   - **Below threshold:** no behavior change — fast-gate returns `undefined` (`mega-events.ts:270`), cache-neutral. The mirror append is the ONLY new side-effect and it is append-only + content-addressed, so it cannot affect the served bytes. Append happens for EVERY context event (cheap) so the mirror is always complete.
   - **Above threshold + flag ON:** call `runCompact` exactly as today to produce `summary` + `compactedFrom`. Then (a) write/refresh the `checkpoint_epochs` row keyed by the deterministic epoch nonce derived from `ran.result.checkpointId`; (b) reconstruct the served window as `[summaryAgentMsg(epochNonce), ...messages.slice(cut)]` where `summaryAgentMsg.timestamp = epochNonce` (a stable number, NOT `Date.now()`). The reconstruction is byte-identical across every context event in the same epoch (same summary text, same cut, same nonce, same recent slice — the recent slice only shifts when the epoch commits a NEW checkpoint), so pi's prompt cache hits between calls within the epoch.
6. After the epoch row commits, fork a **copy** of the raw_transcript snapshot `[started_seq, committed_seq]` and hand it to the EXISTING async compress/dedupe pipeline (`compactSession` has already run synchronously to produce the summary; the L1 minhash/LSH + L2 cosine MMR + RAPTOR + PGlite vector index ingest the forked snapshot in the background). These artifacts write into the EXISTING `context_chunks` / vector tables. They NEVER feed back into the live turn message stream — the live stream is the verbatim mirror replay.
7. Compression output is demoted to a **recall-side asset only**: consumed by `src/recall.ts` `recallAndInline`, session resume, and `/recall-context`. No change to recall's injection path (still `before_agent_start` systemPrompt prepend — PREVENT-PI-003).

### OUT

- Removing or rewriting the legacy live-trim path. It stays as the default + fallback.
- Changing the compress/dedupe algorithms (Trident L1→L2→RAPTOR pipeline) — they ingest the same snapshot they always did, just from the forked copy.
- Schema migration of `context_chunks`, `minhash_signatures`, `dedup_lsh_buckets`, `raptor_nodes`, or the PGlite vector tables. Mirror is additive.
- Changing recall's injection point or the `before_agent_start` systemPrompt flow.
- Cross-repo behavior (PGlite global topology) — the mirror is per-repo (the per-repo `node:sqlite` store); cross-repo recall continues to read the async PGlite index as today.
- Replacing `node:sqlite` as the sync source of truth (CLAUDE.md §5 invariant — preserved).
- Removing the `timestamp` field from the summary message shape entirely (pi API contract — we only make it stable, not remove it).

---

## EXECUTION

### Task 1 — Schema (P0, `src/store/sqlite.ts`)

Bump `SCHEMA_VERSION` to 2. In `initSchema`, append (all `CREATE TABLE IF NOT EXISTS` — additive, no migration of v1 data):

```sql
CREATE TABLE IF NOT EXISTS raw_transcript (
  content_hash    TEXT NOT NULL,           -- SHA-256 of canonicalized bytes (PK)
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,        -- monotonic per session
  role            TEXT NOT NULL,
  content_bytes   TEXT NOT NULL,           -- canonical JSON, stable key order
  tool_name       TEXT,
  message_timestamp INTEGER,               -- ORIGINAL msg timestamp at append (NOT served)
  checkpoint_epoch TEXT NOT NULL,          -- epoch nonce this append belongs to
  PRIMARY KEY (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_rt_session_seq ON raw_transcript(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_rt_epoch ON raw_transcript(checkpoint_epoch);
```

```sql
CREATE TABLE IF NOT EXISTS checkpoint_epochs (
  epoch_id            TEXT PRIMARY KEY,    -- "epoch:" + checkpoint.id  (deterministic)
  session_id          TEXT NOT NULL,
  started_seq         INTEGER NOT NULL,
  committed_seq       INTEGER NOT NULL,
  summary_message_text TEXT NOT NULL,       -- the exact bytes served
  cut_index           INTEGER NOT NULL,      -- the safe cut (boundary.computeDropRange)
  checkpoint_id       TEXT NOT NULL,
  created_at          INTEGER NOT NULL       -- informational ONLY
);
CREATE INDEX IF NOT EXISTS idx_epoch_session ON checkpoint_epochs(session_id, created_at DESC);
```

`created_at` is the ONLY `Date.now()` in the new tables and it is NEVER served — it is informational for DR/dashboards, never part of the served message bytes. The cache stability contract is: served bytes = `{summary_message_text, cut_index, recent slice from raw_transcript[committed_seq..]}` — all content-addressed/deterministic.

### Task 2 — Store helpers (P0, `src/store/sqlite.ts`)

New exported functions (parameterized, `@param` placeholders):

- `appendRawTranscript(row: RawTranscriptRow): void` — `INSERT OR IGNORE` keyed on `content_hash`; assigns `seq` via `COALESCE(MAX(seq),0)+1` within the session. Idempotent on retry.
- `listRawTranscriptRange(sessionId, fromSeq, toSeq): RawTranscriptRow[]` — ordered by `seq`. Used by the fork snapshot.
- `writeCheckpointEpoch(epoch): void` — `INSERT ... ON CONFLICT(epoch_id) DO UPDATE` (refresh on retry; the summary text + cut are deterministic for a given checkpoint id so this is a no-op write).
- `readCheckpointEpoch(epochId): CheckpointEpoch | null` — the cache-hit serve path reads this.
- `getActiveEpochForSession(sessionId): CheckpointEpoch | null` — latest by `created_at`; used to stamp new appends before the next compaction.

`RawTranscriptRow` / `CheckpointEpoch` exported interfaces; **no `any`** (PREVENT-011).

### Task 3 — Deterministic epoch nonce (P0, new `src/mirror/epoch.ts`)

```ts
export function epochNonceFor(checkpointId: string): number {
  // Derive a STABLE integer nonce from the checkpoint id, NOT Date.now().
  // Same checkpoint id → same nonce, forever. Used as `summaryAgentMsg.timestamp`.
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (const ch of checkpointId) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193); }
  return h >>> 0; // unsigned 32-bit — stable, fits a timestamp-shaped number field
}
export function epochIdFor(checkpointId: string): string { return "epoch:" + checkpointId; }
```

The nonce is content-addressed to the checkpoint id; within one epoch (same checkpoint id) every serve returns the same `summaryAgentMsg.timestamp`, the same `summary_message_text`, and the same `cut_index` → byte-identical served window → pi prompt cache hit.

### Task 4 — Config flag (P0, `extensions/mega-config.ts`)

Add alongside `legacyDurableTrim` (mega-config.ts:138):

```ts
dbMirror: envBool("MEGACOMPACT_DB_MIRROR", false),
```

Default OFF. Enabling `legacyDurableTrim` takes precedence (legacy wins) so the two never compose.

### Task 5 — `context` hook rewrite behind flag (P0, `extensions/mega-events.ts:257-356`)

Structure (all within the existing handler; legacy path untouched above the flag check):

1. **Mirror append (every event, before fast-gate):** canonicalize each `messages[i]` to stable JSON (sorted keys, deterministic stringification — reuse the existing canonicalization in `src/store/compression.ts` if present, else a small `stableStringify`). Compute `content_hash = sha256(canonicalBytes)`. `appendRawTranscript(...)` with `checkpoint_epoch = getActiveEpochForSession(sid)?.epochId ?? "epoch:genesis"`. Append-only, content-addressed, O(1) per message on cache-hit (INSERT OR IGNORE), so the cheap-append invariant holds. This runs even below threshold — it is cache-neutral because it never touches the served bytes.
2. **Fast-gate unchanged:** `currentTokens < config.thresholdTokens` → `return;` (undefined — cache-neutral). `mega-events.ts:270`.
3. **Above threshold, flag ON path:**
   - `runCompact(...)` as today → `{ summary, compactedFrom, checkpointId }`.
   - `cut = computeDropRange(view, { compactedFrom: ran.result.compactedFrom, ... cut anchorUserMessages })` — SAME authority as legacy; PREVENT-PI-001/002 structurally preserved. If `cut === null` (unsafe), `return;` exactly as legacy (`mega-events.ts:321-323`).
   - `epochId = epochIdFor(ran.result.checkpointId)`; `nonce = epochNonceFor(ran.result.checkpointId)`.
   - `writeCheckpointEpoch({ epochId, sessionId, started_seq, committed_seq, summary_message_text: summaryMsg.text, cut_index: cut, checkpoint_id, created_at: Date.now() })` — `created_at` is informational only, never served.
   - **Serve path (cache-stable):** `summaryAgentMsg.timestamp = nonce` (NOT `Date.now()`). `recent = messages.slice(cut)` — the original pi `AgentMessage[]` bytes, unchanged. `return { messages: [summaryAgentMsg, ...recent] }`.
   - On a subsequent context event in the SAME epoch (no new checkpoint committed): `getActiveEpochForSession` returns the prior epoch; `runCompact` short-circuits to the same checkpoint id (debounce at `mega-events.ts:274` already prevents re-compact within 2s); the serve reads the prior epoch row → byte-identical bytes. Cache hit.
4. **Flag OFF path:** untouched S16 live-trim (the `mega-events.ts:349` `Date.now()` stays). Rollback = unset flag.

### Task 6 — Fork snapshot to compress/dedupe (P1, `extensions/mega-events.ts` post-serve)

After `writeCheckpointEpoch`, in a `setImmediate`/`queueMicrotask` (non-blocking — never on the prompt path):

```ts
const snapshot = listRawTranscriptRange(sid, epoch.started_seq, epoch.committed_seq);
void runPipelineOnFork(snapshot, sid, config).catch(e => runtime.logger.warn("mirror-fork-failed", { err: String(e) }));
```

`runPipelineOnFork` ingests the snapshot into the EXISTING Trident pipeline (L0 exact → L1 MinHash/LSH → L2 cosine+MMR → RAPTOR → PGlite vector index). All artifacts land in the EXISTING `context_chunks` / `minhash_signatures` / `dedup_lsh_buckets` / `raptor_nodes` / vector tables. NEVER feeds back into the live `messages[]` — the snapshot is a copy; mutation of derived tables is invisible to the serve path (which only reads `raw_transcript` + `checkpoint_epochs`).

### Task 7 — Recall demotion (P2, `src/recall.ts` — documentation/contract only, no structural change)

No code change needed in recall — it already reads `context_chunks` + the vector index. Add a doc comment + an assertion test that recall NEVER reads `raw_transcript` (the mirror is serve-only; the fork already populated the recall tables). This enforces the "compression output is recall-side only" contract.

### Task 8 — Tests (P0, new `src/mirror/mirror.test.ts` + extensions handler test)

- **Epoch determinism:** same `checkpointId` → same `epochNonceFor`/`epochIdFor` across calls.
- **Byte-stable serve:** two `context` events in the same epoch return `JSON.stringify(messages[0])` byte-identical (assert the `timestamp` field is the nonce, not `Date.now()`).
- **Below threshold:** returns `undefined`; `raw_transcript` still gained the appended rows.
- **Append idempotency:** append the same message twice → one row (INSERT OR IGNORE).
- **PREVENT-PI-002:** reconstruction with a tool-pair boundary fixture survives (`isBoundarySafe(messages, cut) === true`).
- **PREVENT-PI-001:** anchor floor preserved — last N user messages present in the served tail.
- **Fork isolation:** after fork, mutating `context_chunks` does NOT change the next served window (the serve path reads only the mirror).
- **Rollback:** `MEGACOMPACT_DB_MIRROR` unset → S16 `Date.now()` path active (assert `timestamp === Date.now()`-ish within slack, i.e. the legacy unstable path).
- **No `any`:** `grep -rn ': any' src/mirror/ extensions/mega-events.ts` → empty.
- **No network:** `grep -rn 'fetch\|http' src/mirror/` → empty.

### Task 9 — Maps + guardrails (P3)

Update `docs/INDEX_MAP.md` (Sprint Specs section) + `docs/HEADER_MAP.md`. Confirm `scripts/guardrails-scan.mjs` still clean (the append path is local SQLite — no new `fetch` annotations needed).

---

## ACCEPTANCE

Grep checks (run from repo root):

```bash
# 1. No Date.now()/uuid on the served message path (flag ON)
grep -nE 'Date\.now\(\)|crypto\.randomUUID|uuidv4' extensions/mega-events.ts \
  | grep -v 'debounceUntil\|created_at\|diagCtx\|runtime\.snapshot\|informational'
# Expect: the flagged-on serve path has no Date.now() on summaryAgentMsg.timestamp.

# 2. The epoch nonce is derived, not time-based
grep -n 'epochNonceFor\|epochIdFor' extensions/mega-events.ts src/mirror/epoch.ts
# Expect: both imported + used on the serve path.

# 3. raw_transcript + checkpoint_epochs tables exist
grep -nE 'CREATE TABLE IF NOT EXISTS (raw_transcript|checkpoint_epochs)' src/store/sqlite.ts
# Expect: two matches.

# 4. Flag default OFF
grep -n 'MEGACOMPACT_DB_MIRROR' extensions/mega-config.ts
# Expect: envBool("MEGACOMPACT_DB_MIRROR", false)

# 5. Legacy path intact (rollback)
grep -n 'legacyDurableTrim\|computeLiveTrimCut' extensions/mega-events.ts
# Expect: legacy gate + S16 path both present.

# 6. No any / no network in mirror code
grep -rnE ': any|fetch\(|http' src/mirror/ || echo OK
# Expect: OK

# 7. Parameterized queries (PREVENT-002) — no string concat into SQL
grep -nE "db\.exec\(.*\$\{|\`.*INSERT.*\+\`" src/store/sqlite.ts | grep -i transcript
# Expect: empty (all @param placeholders).
```

Behavioral acceptance:
- Within one checkpoint epoch, two consecutive `context` events return byte-identical `JSON.stringify(returned.messages)` (verified by unit test). With the flag OFF, the same two events return DIFFERENT bytes (the `Date.now()` drift) — proving the fix is what stabilizes the cache.
- `showCacheMissNotices` no longer surfaces a miss-per-turn within an epoch (manual verification per TESTER_GUIDE §1 Auto-Compaction).
- `npm run lint` + `python3 scripts/regression_check.py --all` + `scripts/guardrails-scan.mjs` all green.
- All existing 280 tests still pass (additive change; legacy path default).

---

## ROLLBACK

**One-step rollback:** unset `MEGACOMPACT_DB_MIRROR` (or set `false`). The `context` hook falls back to the S16 live-trim path (`Date.now()` timestamp, existing slice). No schema rollback required — `raw_transcript` + `checkpoint_epochs` are additive tables; leaving them populated is harmless (they are never read with the flag off, and their presence cannot affect the served bytes).

**Full revert (if needed):** drop the two new tables (`DROP TABLE raw_transcript; DROP TABLE checkpoint_epochs;`), revert `SCHEMA_VERSION` to 1, remove the `src/mirror/` module + the `dbMirror` config + the flag-on branch in `mega-events.ts`. Legacy path is untouched and remains the default throughout, so a revert never orphans a consumer.

**Compatibility with legacy rollback:** `MEGACOMPACT_LEGACY_DURABLE_TRIM=true` still wins (v0.4.28 `ctx.compact()` path) and takes precedence over `MEGACOMPACT_DB_MIRROR`. The two flags never compose: if both are set, legacy wins (documented in `extensions/mega-config.ts`).

---

## RISKS / EDGE CASES

- **Duplicate `content_hash` across sessions:** different sessions may produce identical message bytes (e.g. two fresh sessions with the same first user prompt). PK on `content_hash` alone would collide. **Mitigation:** PK is `(content_hash, session_id)` (adjust Task 1 PK; the index `idx_rt_session_seq` already scopes by session). Re-confirmed: the cache-stability contract is per-session.
- **Canonicalization drift:** if `stableStringify` and the actual served bytes use different key order, the cache key won't stabilize. **Mitigation:** the served `recent` slice is the ORIGINAL pi `AgentMessage[]` (never re-serialized), so the recent tail is byte-stable by construction; only the synthesized summary message bytes are under our control, and those are stored verbatim in `checkpoint_epochs.summary_message_text` and replayed.
- **Epoch lifetime vs. pi's compaction:** if pi's native compaction fires between two of our context events (unusual — we gate on our own threshold), the epoch could change mid-turn. **Mitigation:** the serve path always reads `getActiveEpochForSession` fresh per event; an epoch rollover just starts a new stable epoch (cache miss on the FIRST event of the new epoch, then hits again — the expected, bounded behavior).
- **Storage growth:** `raw_transcript` is append-only and unbounded. **Mitigation:** reuse the existing `RETENTION_POLICY.md` TTL (90d) + soft-delete; add a `raw_transcript.dedup_status` column reuse pattern OR a scheduled prune by `seq` older than the active epoch + N. Out of scope for S27 (default OFF rollout); tracked for S28.
- **Async fork lag:** the recall tables may lag the serve path by one fork. **Mitigation:** acceptable — recall is best-effort by design (CLAUDE.md §5); the serve path is the deterministic source.

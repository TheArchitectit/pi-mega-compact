# Universal Triad and Outage Contract

## Result, independence, and truth

All critical operations return `TriadResult<T>` and use `Breaker` from [CONTRACTS](CONTRACTS.md). A/B/C must not share the same model asset, index, cache, or algorithm: A is optimized/learned; B deterministic local and derives directly from authority; C uses only exact current transcript/ledger and legacy boundary validation. C is continuity, **not semantic completeness**: it may omit old context and must report that limitation.

Authority append A is SQLite transaction; B is an append-only disk spool on the same host; C leaves the host transcript unchanged and disables all derived frontier advancement. Disk loss can therefore defeat A and B together; chaos tests must model it and report manual halt rather than claim independence.

## Breaker state machine

States: `CLOSED_A`, `OPEN_B`, `OPEN_C`, `PROBE_B`, `PROBE_A`, `MANUAL_HALT`. Defaults: rolling window 60 s; minimum 20 attempts; performance trip at ≥5 failures or ≥10%; correctness trip on first failure; cooldown 30 s; probes N=3 consecutive; exponential retry `30s*2^attempt`, cap 15 min, deterministic ±10% jitter from subsystem digest; promotion hysteresis requires failure rate <2% and p95 within budget; minimum healthy residence 5 min before another promotion. These constants live in `src/config/vector-cortex.ts`, re-exported by `src/config.ts`, default ON, and SETTINGS-visible.

Use monotonic time for windows/cooldowns; wall time only for records. Backward/forward wall jumps do not alter eligibility. Restart reconstructs state from append-only breaker events; expired cooldown may probe, never directly promote. Probe output is never served. Manual halt requires reason and explicit admin reset.

Transitions: A correctness/performance trip → `OPEN_B`; B trip → `OPEN_C`; authority/digest/causal corruption → `MANUAL_HALT`; after cooldown `OPEN_C→PROBE_B`; three successes → `OPEN_B`; after healthy residence/cooldown `OPEN_B→PROBE_A`; three successes → `CLOSED_A`. Any probe failure returns to its open state and increments backoff. Promotion requires both functional validity and independent asset/store health.

## Spool protocol

Spool filename is per session; header has schema, session, first sequence, and prior durable high-water. Frames are length-prefix + seq + eventId + original bytes + SHA-256 + CRC32C. Writer fsyncs frame before acknowledging `spooled`; only durable ledger commit returns `committed`. Drain strictly sorts `(seq,eventId)`, rejects gaps/conflicts, inserts idempotently by eventId/digest, fsyncs ledger, appends an ack frame, then advances contiguous high-water. Duplicate same ID+digest is acknowledged; same ID/different digest is manual halt. Crash before ack safely replays. Compaction may delete only fully acknowledged segments after directory fsync.

No derived builder may read beyond durable contiguous authority high-water. During authority outage the high-water freezes even while spool accepts frames. After drain, derived rebuild catches up from the old high-water; it never jumps to spool tail.

## Chaos and dashboard

Required `src/vector-cortex/resilience/{breaker,spool}.test.ts` tests clock jumps/restart, oscillation/hysteresis, A/B common disk failure, torn frames, duplicate drain, gap, conflicting digest, ack crash, disk full, and frozen derived frontier. Exact command: `node --test dist/vector-cortex/resilience/breaker.test.js dist/vector-cortex/resilience/spool.test.js`.

Dashboard contract `extensions/dashboard-server/api-contracts/vector-cortex.ts` defines `GET /api/vector-cortex/health` and `POST /api/vector-cortex/breakers/reset`; registration is `routes.ts`, implementation `routes-vector-cortex.ts`, reader-only for GET and explicit admin capability for POST. Client owns `src/api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, and route/client/component tests. Cards expose mode/state/since/reason/window/probe/backoff/frontier/authority/spool lag; worst critical state determines aggregate.

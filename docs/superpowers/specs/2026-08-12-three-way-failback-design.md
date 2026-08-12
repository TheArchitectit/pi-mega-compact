# Three-Way Failback for the Context-Management Critical Path

**Date:** 2026-08-12
**Status:** SPEC — approved design, pending implementation plan
**Scope:** recall + compaction + replay/restore (the three functions that decide what context the agent sees)

## 1. The problem this solves

On 2026-08-12 a production incident left a pi agent with useless context for two consecutive replays. Root causes, confirmed from the production state dir:

- **Recall silently produced nothing.** `session_start` — the lifecycle event that stages recall on resume — never fired for the affected sessions (0 `session_start` events in `events.log`). The agent fell through to pi's native checkpoint restore, which replayed a checkpoint about an unrelated prior task. Nothing in the system noticed recall didn't run, and nothing verified the agent got relevant context.
- **Compaction thrashed.** 496 compactions ran against a single checkpoint (`chkpt_001`), 555 of 576 deduped, but the session freed **0.0%** of its tokens. The compactor ran, did dedup work, produced ~0 net reduction, and re-fired the next turn — indefinitely. No guard said "stop, this isn't reducing anything."
- **Replay delivered irrelevant context.** The agent received a raw checkpoint dump about the wrong topic and ignored it. The two replays "didn't even use any context" because the context wasn't relevant to the current task, and nothing caught that.

The common failure: a critical-path function can silently produce a no-op or irrelevant result, and nothing downstream verifies the result satisfied its contract. The user — who installs mega-compact via `pi update --extensions` and is not a developer of this extension — cannot diagnose or fix this. The system must self-remediate.

## 2. Core invariant

**The agent always receives a verified, useful context block. The backend is responsible for producing it; the user is not.**

Every failure path converges on automatic escalation — next source, next rung, safe-default floor — never on a user-facing warning, banner, or action item. Diagnostic breadcrumbs go to `events.log` and the dashboard for the developer, post-incident; they are never a prompt the user must answer or work the user must do.

## 3. The one pattern, applied to all three functions

Each critical-path function is built on the same structural pattern:

1. **Three independent sources** — genuinely independent retrieval/compaction/restore logics, all local (PREVENT-PI-004). A failure in one does not correlate with the others.
2. **Run all three** — in parallel where cheap, sequential where expensive-with-fallback. The LLM opt-in inserts an expensive rung into one source; it never becomes the foundation.
3. **Vote by an objective metric** — relevance for recall, reduction × signal for compaction, presence for replay. The vote keeps the result that best satisfies the metric.
4. **Validate the winner** — an independent validator on a *different code path* than the sources checks the result against the function's contract. This is the piece that does not exist today.
5. **Escalate on failure** — if validation fails, try the next rung; if all fail, the safe-default floor. Never empty.
6. **Guard the trigger + confirm the result** — `TriggerGuard` (run the function if its lifecycle trigger didn't fire) and `InjectionConfirm` / `ThrashGuard` (verify the result landed / stop re-fire).

## 4. Recall — three independent retrieval paths

### The three sources

| Source | What it does | Code path | Cost |
|---|---|---|---|
| A: Vector search | Semantic cosine over checkpoint embeddings | `src/engine.ts:246` `recall()` → `vectorSearch()` | Cheap (trigram, sub-ms) |
| B: FTS5 trigram | Keyword search over checkpoint text | `src/store/sqlite/fts5-search.ts:34` `fts5Search()` | Cheap |
| C: Structural | Turn-recall table + recent files + last task | `src/store/turns/` `TurnReader` | Cheap |
| (opt-in) HyDE | Generate hypothetical doc, embed, search | `src/hyde.js` via `recall/sync.ts:108` | Expensive (local LLM) — candidate only when `MEGACOMPACT_HYDE_ENABLED` + HttpEmbedder |

A, B, C run in parallel and vote. HyDE, when opt-in, is a candidate source that augments the vote; it is never the foundation, and when off the vote runs on the three local paths unchanged.

### Vote

Keep hits that appear in ≥2 of 3 sources (overlap vote), or top-scored across all when overlap is sparse. Flag any source that diverges sharply from the other two (a divergence breadcrumb goes to `events.log`).

### Validator (RecallValidator)

Independent code path — does **not** call any search function (that is what makes it independent of a search failure). Checks:
- ≥1 hit with cosine relevance above the floor
- the top hit is not already resident in the live window (windowDedupe)
- PASS → inject the voted hit-set
- FAIL → try next source alone; if all fail → provenance floor

### Safe-default floor (ProvenanceFloor)

Pure function, reads the store's read API only. Builds a minimal block: repo, last task, recent files, last checkpoint summary. Never fails — if the store is empty, returns "new session, no prior context." The agent always gets *something* useful and can request more via a tool.

## 5. Compaction — three competing engines (the 3-way compact engine)

Today the Trident layers (supersede → collapse → cluster) run as a *sequential pipeline*. This design runs them as **three competing engines** that each produce a candidate checkpoint, and the engine picks the best by vote. The failback *is* the three engines, not a separate layer.

### The three engines

| Engine | What it does | How it compacts | Cost | Independent failure mode |
|---|---|---|---|---|
| A: Supersede | Drops obsolete file reads + redundant messages, keeps the rest verbatim | Trims by removing redundancy — result is a shorter message list | Cheap, structural | Frees 0 when messages are all unique |
| B: Extractive collapse | Builds a structured summary: counts, tools, recent requests, timeline | Replaces messages with a text block | Cheap, deterministic | Degenerate when messages are all tool results with no user requests |
| C: Semantic cluster | Clusters by meaning, summarizes each cluster | Replaces messages with a semantic/hierarchical summary | Cheap (extractive) → expensive (Ollama, opt-in) | LLM timeout/garbage (opt-in only) |

A and B always run. C runs as extractive-cluster by default, or Ollama-cluster when `MEGACOMPACT_RAPTOR_MODEL` is set (the opt-in local LLM). The three are genuinely independent: A works on content redundancy, B on message structure, C on semantic meaning.

### Cost-awareness (the LLM opt-in)

The LLM opt-in is handled by a **`SummarySource` abstraction** — one interface, two implementations (Extractive / Ollama) — behind which engine C operates. When the LLM is off, all three engines are cheap and local. When on, engine C upgrades from extractive-cluster to Ollama; the vote logic is unchanged. The LLM is an insertion into the ladder, never its foundation.

### Vote

Each engine produces a candidate: `{ result, tokensSaved, signalPreserved }`. The engine ranks by **reduction × signal**: the candidate that saved the most tokens *while preserving the most signal* wins. A summary that drops the user's last request is rejected even if it's tiny. The losing candidates' `tokensSaved` is logged so we can see post-incident which engine served which turn.

### Validators

1. **ReductionValidator**: `savedTokens = tokensBefore − summaryTokens`. If `≤ 0` → ineffective. Identical for both configs — a bad LLM summary longer than the original is as ineffective as a bad extractive one.
2. **SummaryQualityValidator**: non-empty, not a verbatim repeat of input, contains the recent user requests. For the LLM path specifically, catches degenerate generation (Ollama returned "" or echoed the prompt) that the extractive path cannot produce.

Both validators run on the *output* regardless of which source produced it — that is what makes them independent of the source.

### ThrashGuard

After ReductionValidator marks a compaction ineffective (all three candidates saved ≤ floor), the guard marks compaction ineffective and **refuses to re-fire until N new tokens arrive**. The 496-iteration loop becomes impossible — the first all-three-fail turn stops it. The system accepts the current window size and moves on rather than looping.

## 6. Replay/restore — the convergence point

We do not control pi's native restore (it restores its own checkpoint). Our influence is what we inject via `before_agent_start`. Replay is where "each layer validates the prior" culminates.

### The three sources

- **A**: our staged recall block (produced by the recall triple-source vote)
- **B**: pi's native checkpoint restore (what the host gives the agent — the thing that delivered the irrelevant dump in the incident)
- **C**: the provenance floor (always available)

### Two guards (both new)

1. **TriggerGuard** — the incident's root fix. Today the system trusts `session_start` fired and staged recall. The guard checks at `before_agent_start`: *did recall actually run for this session?* If not, it runs the recall triple-source now. The agent is never left with only pi's native restore just because a lifecycle event didn't fire.

2. **InjectionConfirm** — runs after `before_agent_start` returns. Reads the agent's actual context and verifies the recall block is present. If recall said it staged X but the agent's context has no X (the exact incident shape), the guard re-injects via the fallback path. The user never sees the irrelevant dump; the backend self-corrects.

### Validator

The replay validator is `InjectionConfirm` itself: presence of a relevant block in the agent's actual context. If absent → re-inject the staged block; if the staged block is also absent → inject the provenance floor.

## 7. The unified picture

| | Recall | Compaction | Replay |
|---|---|---|---|
| **3 sources** | vector / FTS5 / structural (+ HyDE opt-in) | supersede / extractive / cluster (+ Ollama opt-in) | staged block / pi restore / provenance floor |
| **Vote metric** | relevance + overlap (≥2/3) | tokensSaved × signalPreserved | presence of relevant block |
| **Validator** | RecallValidator (cosine > floor, not in-window) | ReductionValidator + SummaryQualityValidator | InjectionConfirm (block in agent context) |
| **Safe floor** | provenance block | structural summary block | provenance block |
| **Guard** | TriggerGuard (run if session_start didn't fire) | ThrashGuard (stop re-fire if 0 saved) | InjectionConfirm (re-inject on mismatch) |

All three functions share the identical structural pattern. The LLM opt-in (HyDE for recall, Ollama for compaction) inserts an expensive rung into one source per function; it is never the foundation, and the vote + validators work identically whether it is on or off.

## 8. The incident, replayed against this design

`session_start` doesn't fire → `TriggerGuard` at `before_agent_start` detects recall didn't run → runs the triple-source now → vector/FTS5/structural vote → `RecallValidator` confirms relevance → block staged → `InjectionConfirm` verifies it landed in the agent's context → the agent gets relevant context, not pi's irrelevant checkpoint dump. If recall found nothing relevant → provenance floor (repo, last task, recent files). The user sees working context. We see the `session_start-didn't-fire` breadcrumb in `events.log` to fix the root cause later.

Compaction: engines A/B/C run → if all three save ≤ floor → `ThrashGuard` stops re-fire → the 496-iteration loop never starts. The system accepts the window and moves on.

## 9. New components

Each component has one purpose, a typed result interface (no shared mutable state), and is independently testable.

1. **`TriggerGuard`** — checks recall ran for the session; runs it if not. Depends on runtime recall-staging state. Does not depend on any search function.
2. **`TripleSourceRecall`** — runs vector / FTS5 / structural in parallel, votes. Depends on the three existing search functions. Independent of the validator and the trigger guard.
3. **`RecallValidator`** — checks the voted hit-set on a different code path than the search. Depends on the embedder (cosine) + live-window extractor. Does not call any search function.
4. **`ProvenanceFloor`** — pure function, builds the minimal block from the store's read API. Never fails.
5. **`ThreeWayCompactEngine`** — runs supersede / extractive / cluster as competing engines, votes by reduction × signal. Replaces the sequential Trident pipeline.
6. **`ReductionValidator`** + **`SummaryQualityValidator`** — check the compaction candidate's output regardless of source.
7. **`ThrashGuard`** — stops compaction re-fire after an ineffective compaction.
8. **`InjectionConfirm`** — verifies the agent's actual context contains the staged block; re-injects on mismatch.
9. **`SummarySource`** abstraction — one interface, Extractive / Ollama implementations, so engine C is cost-aware and config-adaptive.

## 10. Constraints respected

- **PREVENT-PI-004**: all sources are local. The only network paths are the existing opt-in, user-configured, loopback-only ones (Ollama for compaction cluster, HyDE LLM for recall) — already annotated `guardrails-allow`.
- **Feature flags default ON, env-overridable OFF**: the 3-way failback defaults ON; a flag (e.g. `MEGACOMPACT_THREE_WAY_FAILBACK`) can disable it to fall back to the current single-path behavior (byte-identical pre-sprint) for regression safety.
- **Non-fatal stores**: every new component is best-effort; a failure escalates to the next rung, never breaks the agent loop.
- **File limits**: each new component stays under the `src/` 300-soft / `extensions/` 400-soft limit. The `ThreeWayCompactEngine` and `TripleSourceRecall` are delegate-shells over impl files if they approach the limit.
- **Append-only provenance**: no new mutations to turns/recall/forks. The validators read; they do not write.

## 11. Out of scope

- Fixing the root cause of `session_start` not firing (a pi host behavior) — the `TriggerGuard` works around it; the root fix is a separate investigation.
- The S38 error-retry memory-loop driver (pre-existing, unrelated to this diff) — separate investigation.
- The PMA analytics.db leak (F1 from the review) — separate fix, may ship alongside.
- A recall-as-pi-tools architecture (agent pulls context on demand instead of auto-inline) — a larger future design; the existing `feat/local-rag-mcp-spec` branch covers the read-server groundwork. This 3-way design makes the auto-inline path robust; it does not replace it with pull-based recall.

## 12. v2 QA amendments (BINDING — these override §4–§9 where they conflict)

Adversarial QA against the real code (2026-08-12, three independent review passes over the recall / compaction / replay seams) found four load-bearing spec errors. The original sections remain for history; the text below is authoritative.

### A1. Recall Source C is not an independent retrieval path

`TurnReader`/`turn_recall` records which checkpoints were **already injected** (a downstream echo of Source A) and the turns.db readers carry no `filesModified`/last-task fields. The specced "structural" source is not independent.
**Binding change:** Source C = **query-independent recency** — most-recent checkpoints by timestamp plus session provenance (an orthogonal temporal axis, no correlation of failure with semantic or lexical retrieval).
Three further mechanical facts that the vote must respect:
- FTS5 search returns `{id, score}` without checkpoint objects — hits must be hydrated (pattern: `tieredRouter.ts:398 hydrateHits`) to join on `id → checkpointId`.
- The vote keys on vector's **raw `hits` list, never `newHits`** — `skipInjected` filtering + the injected-set interplay otherwise inflates apparent overlap.
- `recallAndInline` is **not idempotent** (`src/recall/sync.ts:159-174` mutates the injected-set via `vectorMarkInjected` and emits S43 telemetry inside the inject loop). All validators and guard re-runs must use a **read-only recall variant** (search + rank only; no marks, no telemetry).
- **No same-repo relevance floor exists today** — `vectorSearch` returns top-k unconditionally (the only floor is `crossRepoCosine` for cross-repo). A new same-repo floor config is net-new (default **0.12**).

### A2. Compaction: the "three competing engines" model breaks

supersede returns a trimmed `EngineMessage[]` (a message list to keep verbatim), not a summary text; it is hard-wired as a non-optional precondition in `compactSession` (engine.ts:143→165). The cluster summarizer is not in the `compactSession` pipeline at all. The engine outputs are not drop-in substitutes on one vote axis.
**Binding change:** compaction is a **three-rung ladder**, not three competing engines:
1. **supersede precondition** (always runs first, exactly as today; its savings measured via the existing `supersedeTokenSavings` math)
2. **two competing summary candidates** — extractive `summarizeMessages` vs `extractiveClusterSummary` (Ollama opt-in insertion via `summarizer.ts:54`) — voted by reduction × signal, where signal = the summary contains `collectRecentUserRequests`
3. **structural/provenance floor** — always available
**Thrash mechanism confirmed:** `saved` (mega-pipeline/compact.ts:117-119) counts **stored-checkpoint** tokens, not live-window reduction — the 555/576 deduped fires each registered a win while the live window never shrank. The **ReductionValidator measures live-window turn-over-turn delta**, never `saved`. Re-fire gating (every `context` event past firePoint, only 2s debounce, re-fire at `recompactPctDelta`) stays; the **ThrashGuard** adds a persisted refusal (SQLite `meta`, patterned on `meta.ts:31 addTokensSaved`) until N new live-window tokens arrive (default N ≈ 10% of `effectiveThreshold`).

### A3. Replay guards live in the context handler, not before_agent_start

`recallTailInject` defaults ON (mega-config.ts:207): staged blocks are injected as a user-role tail message by the context handler (`context-handler/tailResult.ts` — `buildTailResult`, wired at context-handler.ts:60, :84-97), and `before_agent_start` early-returns in that mode. **There is no readback API** for the final composed prompt; the only verifiable proxy is `ContextEvent.messages` (the pre-LLM message list), and in tail mode the block is present as a visible user-role message.
**Binding change:** **TriggerGuard** (absent staged block → run read-only recall now, then stage) and **InjectionConfirm** (assert tail-block text present in `event.messages` before consumption; re-compose on mismatch) both live in the **context handler at the `tailResult.ts` seam**. In legacy prepend mode (`recallTailInject` OFF) the guards degrade to "verify the returned string contains the block."

### A4. When the LLM is off, all rungs are cheap and local (unchanged); the opt-in LLM stays an insertion

HyDE (recall) and Ollama cluster summarization (compaction) remain opt-in candidate insertions behind one interface each (`SummarySource`). Vote + validators are identical either way. Confirmed: `OLLAMA`-path summarize is the *only* LLM call in the compaction path and already falls back to extractive on failure (summarizer.ts:86-89).

### A5. Flag surface

`MEGACOMPACT_THREE_WAY_FAILBACK` (default ON, env-OFF, flag-OFF byte-identical) **and** `MEGACOMPACT_RECALL_TAIL_INJECT` both require dashboard settings toggles in `routes-rag-settings-helpers.ts` SETTINGS (neither may sit in `EXCLUDED_SETTINGS`); the latter currently lacks a toggle, which the all-flags-toggleable rule requires us to add.

### A6. Base branch

Implementation is based on **master v0.20.83** (the rolled-back production state) on branch `feat/three-way-failback`. The `pma-remerge-review` branch (re-applied PRs #15/#16) is **parked, unmerged** — the failback line does not carry the PMA analytics.db leak (spec §11 F1) aboard.

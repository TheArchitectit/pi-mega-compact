# Deep Research — pi-mega-compact

Findings that constrain the design, gathered from the local pi runtime type
definitions (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`), the
reviewed reference implementations (memory-mcp, claw-code, neuralwatt-mcr), and
the guardrails template.

---

## 1. pi ExtensionAPI — what's actually possible

### Message model (the hard constraint)
`AgentMessage = Message | CustomAgentMessages[...]` where:
- `Message = UserMessage | AssistantMessage | ToolResultMessage` — **there is NO
  `system` role in the message stream.** (`pi-ai/dist/types.d.ts:299`)
- `UserMessage { role:"user"; content: string | (Text|Image)[]; timestamp }`
- `AssistantMessage { role:"assistant"; content:(Text|Thinking|ToolCall)[] }`
- `ToolResultMessage { role:"tool"; content:(Text|Image)[] }`
- Extra custom roles exist: `custom`, `branchSummary`, **`compactionSummary`**,
  `bashExecution` (`pi-coding-agent/dist/core/messages.d.ts`).

**`CustomMessage { role:"custom"; customType; content; display; details }` and
`CustomEntry` do NOT participate in LLM context** — they are UI/log only.

### Implication for injection (decides the whole recall layer)
To put compacted context **where the model can see it**, the options are:
1. **`before_agent_start` → return `{ systemPrompt }`** — prepend our recall
   block to the system prompt. Chained if multiple extensions return it. This is
   the cleanest "inline compacted context" path. (types.d.ts:786
   `BeforeAgentStartEventResult.systemPrompt`)
2. **Prepend a `UserMessage`** via the `context` hook's `{ messages }` return —
   model sees it, but it reads as user text.
3. **`compactionSummary` role message** — pi's own native compaction uses this;
   we can emit the same shape via `createCompactionSummaryMessage()` so our
   summaries render like native ones.

**The compact-marker sentinel uses `customType` (role:"custom")** precisely
because it is NOT in LLM context — it's a pure dedup/bookkeeping signal, exactly
matching the "dedup sentinel for the vector store" decision.

### Drop / modify context
- `on("context", h)` where `h` returns `ContextEventResult { messages?:
  AgentMessage[] }` — return a filtered array to **drop** old messages before the
  LLM call. (types.d.ts:489, 762) This is the neuralwatt-mcr mechanism.
- Anchor-floor guard (preserve last N user messages) is mandatory — proven bug
  in neuralwatt-mcr where mixed index spaces nuked recent prompts.

### Cancel / customize native compaction
- `on("session_before_compact", h)` → `{ cancel?: boolean; compaction?:
  CompactionResult }`. `reason: "manual"|"threshold"|"overflow"`, `willRetry`.
  We return `{ cancel:true }` once we've persisted our own checkpoint, OR return
  a `compaction` result to fully own compaction. (types.d.ts:431, 799)
- `on("session_compact")` fires after (observe only).

### Triggers & context usage
- `ctx.getContextUsage(): { tokens:number|null; contextWindow:number;
  percent:number|null }` — drives the fast `%` gate. `tokens` is null right after
  compaction. (types.d.ts:192, 236)
- `on("turn_end", {turnIndex, message, toolResults})`, `on("context")`,
  `on("agent_settled")` — candidate trigger points. `ctx.isIdle()` guards
  mid-stream firing.

### Commands / tools / UI / persistence
- `pi.registerCommand(name, { handler(args, ctx), description,
  getArgumentCompletions? })` — for `/megacompact`, `/recall-context`,
  `/megacompact-status`. Handler gets `ExtensionCommandContext` (adds
  `newSession`, `fork`, `waitForIdle`, `getSystemPromptOptions`). (types.d.ts:876)
- `pi.registerTool(...)` — LLM-callable tool (optional: let the model request a
  recall).
- `ctx.ui.setStatus(key, text)` — status-bar chip (compaction %, last chkpt).
- `pi.sendMessage({customType, content, display, details})` — inject custom
  message (our marker). `pi.appendEntry(customType, data)` — non-LLM session-log
  entry (good for checkpoint bookkeeping).
- `ctx.sessionManager` (read-only) — `getSessionId()`, `getBranch()` to read
  entries for summarization and to replay markers on branch switch.
- `ctx.compact(options?)` — trigger native compaction (fallback).

### Session lifecycle (state reset points)
- `session_start`, `session_tree` (branch nav — invalidates region indexes),
  `session_shutdown` (teardown). Mirror neuralwatt-mcr's reset discipline.

---

## 2. Local vector store + embedding (all-local, no network)

Decision: **pluggable embedder with a zero-dependency default**, so the
extension works offline with no native build, and can be upgraded later.

| Option | Deps | Quality | Verdict |
|---|---|---|---|
| **Hashed char/word n-gram bag + cosine** | none (pure TS) | heuristic | **Default.** Zero deps, instant, good enough for "inline the right checkpoint." |
| `@xenova/transformers` (transformers.js) local ONNX (e.g. all-MiniLM-L6-v2) | ~large model dl once | strong | Optional upgrade behind the same `Embedder` interface. Requires model cache on disk (still offline after first fetch). |
| `hnswlib-node` for ANN index | native build | fast at scale | Only needed at >10k vectors; our checkpoint counts are small — linear cosine is fine. |

**Design:** `interface Embedder { embed(text:string):Promise<number[]> }` +
`interface VectorStore { add(id, vec, meta); search(query, k):Hit[];
dedupe(regionHash):boolean }`. Default embedder = deterministic hashed trigram
bag (fixed dim, L2-normalized). Storage = on-disk JSON + `zlib` gzip in
`~/.pi/agent/extensions/mega-compact/`. Cosine similarity in-memory (small N).

Dedup: (a) `regionHash` exact match (already-compacted region), (b)
`checkpointId` already injected this session (from `state.json`), (c) cosine
near-duplicate collapse at `DEDUP_SIM=0.95`.

---

## 3. Reference algorithms to port (TS reimplementation)

- **Trident 3-stage** (memory-mcp `compact.py`, claw-code `trident.rs`):
  SUPERSEDE (drop obsolete file reads) → COLLAPSE (summarize chatty runs) →
  CLUSTER (vectorize to store).
- **`summarize_messages`** heuristic (claw-code `compact.rs`): role counts, tool
  names, recent user requests, `infer_pending_work` keyword scan, `collect_key_files`
  path+ext extraction, timeline. Cheap, no LLM.
- **`merge_compact_summaries`**: accumulate "Previously compacted" + "Newly
  compacted" so repeated compactions don't overwrite.
- **Tool-pair boundary guard**: never split an assistant(ToolUse)/tool(ToolResult)
  pair at the drop boundary (OpenAI-compat 400). Applies to our `context` drop.
- **`auto_compact_check`** (session_context.py): `should_compact = tokens >=
  threshold`; return utilization %. Local reimplementation.
- **checkpoint IDs**: `chkpt_001` sequential; **session id normalize** to
  `sess_xxx`.

---

## 4. Guardrails template (agent-guardrails-template)

Cloned to `guardrails-template/`. It is a **polyglot, config-first governance
layer**, not tied to one language. Adaptation surface:

- **`.claude/hooks/`** — `pre-execution.sh`, `post-execution.sh`,
  `pre-commit.sh` (checks AI attribution `Co-Authored-By:`, secrets, `.env`
  staging, scope). Directly reusable.
- **`.claude/skills/*.json`** — guardrails-enforcer, commit-validator,
  scope-validator, clean-architecture, production-first, error-recovery,
  three-strikes, env-separator. Drop-in behavioral rules.
- **`.guardrails/`** — `pre-work-check.md`, `failure-registry.jsonl`,
  `prevention-rules/{pattern,semantic,extracted}-rules.json` (regex rules like
  PREVENT-001 JSON.parse null-check; severity-tagged; `file_glob` scoped to
  ts/js already).
- **`.github/workflows/`** — `guardrails-lint.yml` (scope/size), 
  `regression-guard.yml`, `secret-validation.yml`, `documentation-check.yml`
  (500-line doc max), `team-validation.yml`. Reusable CI, TS-friendly.
- **`scripts/`** — `regression_check.py`, `log_failure.py`, `setup_agents.py`
  (`--install-skill`, `--clone`, `--platform`). Python-based, standalone.
- **Docs**: `docs/AGENT_GUARDRAILS.md` (Four Laws: Read-before-edit, Stay-in-scope,
  Verify-before-commit, Halt-when-uncertain), INDEX_MAP/HEADER_MAP/TOC token
  discipline.

**Adaptation approach:** vendor the config-only pieces (`.claude/`,
`.guardrails/`, `.github/workflows/`, `scripts/regression_check.py`,
`scripts/log_failure.py`, the Four-Laws doc), strip the Godot/3D/game-design and
Sentinel/MCP-server material (irrelevant to a TS pi extension), retarget
`file_glob`s to `extensions/**` + `src/**`, and wire the hooks into
`package.json` + a pre-commit. Keep the 500-line doc rule (our docs already obey
it — this file included).

---

## 5. Net design deltas from this research

1. **Recall injection = `before_agent_start` systemPrompt prepend** (not a
   system message — that role doesn't exist). Marker stays `role:"custom"`.
2. **Own compaction via `session_before_compact` `{ compaction }`** is available
   if we want full control instead of just `{ cancel:true }`.
3. **Mirror native `compactionSummary`** message shape for our summaries.
4. **Zero-dep hashed-embedding default**, transformers.js optional upgrade.
5. **Tool-pair boundary guard** must be applied to our `context`-hook drop, not
   just to persistence.

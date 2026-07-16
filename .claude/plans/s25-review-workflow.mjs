// Workflow: review S24 subsystems (RAPTOR / memory loop / cross-repo) against REAL
// source and expand the s25-* plan stubs into full specs.
//
// Phase 1 (Scout): 3 parallel research agents, each reads the actual source for
//   one subsystem and returns ground-truth findings + a detailed spec draft.
// Phase 2 (Synthesize): one agent merges the drafts + existing stubs and WRITES
//   the three full specs to docs/specs/s25-*.md and updates the tracking plan.

export const meta = {
  name: "s25-spec-review",
  description: "Review S24 RAPTOR/memory/cross-repo code and expand plan stubs into full specs",
  phases: [
    { title: "Scout", detail: "3 parallel agents read real source per subsystem" },
    { title: "Synthesize", detail: "write the three full specs + update tracking plan" },
  ],
};

const RAPTOR_PROMPT = `You are reviewing the RAPTOR subsystem of pi-mega-compact (a local pi coding-agent extension) to expand a plan stub into a FULL, implement-from-directly spec. The repo cwd is the pi-mega-compact root.

READ THESE REAL FILES with the Read tool (not grep alone):
- src/dedup/raptor/index.ts (runRaptor, isShadowMode, saveRaptorTree)
- src/dedup/raptor/retrieval.ts (stagedExpansion, recallRaptor)
- src/dedup/raptor/tree.ts (buildRaptorTree, node shape)
- src/dedup/raptor/promote.test.ts and src/dedup/raptor/raptor.test.ts
- extensions/mega-pipeline.ts (where runRaptor is called, ~lines 229-258)
- src/recall.ts (recallAndInline — the promotion target)
- src/config/dedup.ts (RAPTOR_* flags + defaults) and extensions/mega-config.ts (raptorEnabled)
- src/store/sqlite.ts (saveRaptorTree / listRaptorNodes schema)
- docs/specs/s25-raptor-promote.md (the current stub to expand)

REPORT the ground truth with file:line citations:
1. Is RAPTOR served in ANY recall path today? Quote the lines that gate shadow mode.
2. What recallRaptor returns; how leaf ids map to checkpoint summaries for injection.
3. Every RAPTOR config flag + default (quote them).
4. What the existing tests prove vs leave unproven.
5. Concrete promotion steps: exact merge point in src/recall.ts, dedup key vs vectorStore.search hits, budget guard.
6. Risks: latency, stale/missing tree, fallback.

Then OUTPUT a FULL spec (the entire file content, ready to save) as a single fenced \`\`\`markdown block, in this repo's sprint-spec format: header (Date/Parent plan/Depends on/Priority/Status/Target version) / ## SAFETY PROTOCOLS / ## PROBLEM / ## SCOPE (in+out) / ## EXECUTION (numbered, file:line precise) / ## ACCEPTANCE (testable) / ## ROLLBACK. It must be detailed enough to implement without re-reading the code.`;

const MEMORY_PROMPT = `You are reviewing the durable-memory subsystem of pi-mega-compact to expand a plan stub into a FULL spec. Repo cwd is the pi-mega-compact root.

READ with the Read tool:
- src/memory.ts (reviewConversation)
- src/memoryOps.ts (applyMemoryOps, indexMemoryWrite mirror)
- src/memoryRecall.ts (recallMemories, recallMemoriesCrossRepo)
- src/recall.ts (recallMemoriesAndInline + crossRepo augmentation)
- src/store/sqlite.ts (addMemory/listMemories/searchMemories, MEMORY_MAX_ROWS/MEMORY_MAX_CHARS, LRU eviction)
- extensions/mega-events.ts (turn_end auto-review ~174-186; session_start/session_tree resume recall ~44-102; before_agent_start inline ~103-112; pendingMemoryRecallBlock)
- extensions/mega-pipeline.ts (runMemoryReview)
- src/memoryRecall.test.ts and src/memoryOps.test.ts
- TESTER_GUIDE.md memory section
- docs/specs/s25-memory-db-roundtrip.md (the stub to expand)

REPORT with file:line:
1. The full write->persist->recall->inline chain, each hop cited.
2. When auto-review fires; what reviewConversation emits; hallucination risk.
3. The resume-and-inline path (pendingMemoryRecallBlock set on session_start -> prepended in before_agent_start). Tested E2E?
4. Store bounds (MEMORY_MAX_ROWS/CHARS/LRU) — real + tested?
5. What unit tests prove vs leave unproven (no full round-trip, no resume-inline, no bloat assertion).
6. Cross-repo memory mirror + strict floor.

Then OUTPUT the FULL spec as one fenced \`\`\`markdown block, sprint-spec format, with EXECUTION covering: the headless E2E driver steps (jiti + mock pi, loading the compiled extension), the manual real-pi checklist, and the exact TESTER_GUIDE additions. Detailed enough to implement directly.`;

const CROSSREPO_PROMPT = `You are reviewing the cross-repo recall + memory subsystem of pi-mega-compact to expand a plan stub into a FULL spec. Repo cwd is the pi-mega-compact root.

READ with the Read tool:
- src/store/vectorIndex.ts (PGlite checkpoint HNSW: init/upsert/searchAsync/kill-switch)
- src/store/memoryIndex.ts (PGlite memory HNSW: initMemoryIndex/upsertMemoryEmbedding/searchMemoriesAsync/kill-switch)
- src/recall.ts (recallAndInline cross-repo augmentation + the Slice-2 async cross-repo recall below it)
- src/memoryRecall.ts (recallMemoriesCrossRepo)
- extensions/mega-events.ts (session_start resume crossRepo; doRecallAsync)
- extensions/mega-pipeline.ts (doRecallAsync same-repo->PGlite merge, crossRepoCosine)
- src/config/dedup.ts + extensions/mega-config.ts (CROSSREPO_ENABLED, CROSSREPO_COSINE, INDEX_DIR defaults)
- src/store/sqlite.ts (machine-wide injected-set for dedup, ~/.mega-compact-index)
- src/store/memoryIndex.test.ts, src/memoryRecall.test.ts (~line 103), src/recall.test.ts
- docs/specs/s25-cross-repo.md (the stub to expand)

REPORT with file:line:
1. The two PGlite indexes: init/upsert(write)/query(read) points + their dirs.
2. Checkpoint cross-repo read path vs memory cross-repo read path; dedup + floors.
3. Write/mirror paths for both indexes.
4. Kill-switch + degradation (MEGACOMPACT_PGLITE_DISABLED -> sync scan). Non-fatal on init/search failure?
5. Unit tests prove vs leave unproven (no two-repo E2E through real handlers).
6. Risks: corruption, inline content, repo_id scoping, double-inject.

Then OUTPUT the FULL spec as one fenced \`\`\`markdown block, sprint-spec format, EXECUTION covering the two-repo headless driver (A: checkpoint recall on resume, B: memory augmentation, C: disabled/corrupt fallback) + optional manual two-repo check + TESTER_GUIDE additions. Detailed enough to implement directly.`;

phase("Scout");
const [raptor, memory, crossrepo] = await parallel([
  () => agent(RAPTOR_PROMPT, { label: "scout:raptor", phase: "Scout" }),
  () => agent(MEMORY_PROMPT, { label: "scout:memory", phase: "Scout" }),
  () => agent(CROSSREPO_PROMPT, { label: "scout:crossrepo", phase: "Scout" }),
]);

phase("Synthesize");
const SYNTH_PROMPT = `You are finalizing three full specs for pi-mega-compact (repo cwd = repo root). Three research agents reviewed the real code and produced full spec drafts. Your job: extract each draft's fenced \`\`\`markdown block and WRITE it to disk with the Write tool, replacing the stub files. Preserve the sprint-spec format; fix any obvious inconsistency but do NOT invent facts the drafts didn't establish.

Write these files (overwrite):
1. docs/specs/s25-raptor-promote.md  <- from the RAPTOR draft below
2. docs/specs/s25-memory-db-roundtrip.md  <- from the MEMORY draft below
3. docs/specs/s25-cross-repo.md  <- from the CROSS-REPO draft below

Then update .claude/plans/verify-s24.md: replace its "Current state (grounded in code...)" section with a tighter, citation-backed summary distilled from the three drafts (2-4 bullets per subsystem, with file:line where the drafts gave them), and keep the rest (scope decision, execution order, verify gate, branch hygiene) intact.

After writing, REPORT a one-paragraph summary of what changed in each file and any contradictions you had to resolve.

=== RAPTOR DRAFT ===
${raptor}

=== MEMORY DRAFT ===
${memory}

=== CROSS-REPO DRAFT ===
${crossrepo}`;

const result = await agent(SYNTH_PROMPT, { label: "synthesize:write-specs", phase: "Synthesize" });

log("S25 spec review complete — three full specs written + tracking plan updated.");
return { synthesis: result };

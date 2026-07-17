# Backlog — pi-mega-compact

Lightweight backlog of confirmed findings + planned work that is NOT yet
scheduled into a sprint. Each item links to its findings doc in `docs/specs/`.

---

## CONFIRMED FINDINGS (investigation done, fix pending)

### [BUG] Pressure band oscillates 30%↔70s% from a dual-basis switch (not tiering)
- **Status:** Root cause confirmed (code-path analysis). Fix not written.
- **Severity:** Low–Medium (observability; misleads testers, not data loss).
- **Branch:** feat/verify-s24
- **Finding:** `extensions/mega-runtime.ts` `pressure` getter switches between
  Basis A (`lastCtxTokens / thresholdTokens`) and Basis B
  (`pressureFromPct(lastCtxPercent)`) depending on whether the last context event
  carried a token count. Basis B disagrees with Basis A, so alternating events
  make the band jump instantly with no compaction. The **compression tier is NOT
  the cause** — `thresholdTokens` is fixed at `loadConfig()` and never changes
  mid-session (`mega-config.ts:93-122`).
- **Symptom:** band jumps 30% → high-70s% → instant drop-back; no 30s+ compaction
  pause; snaps back. Matches the dual-basis flip.
- **Recommendation:** prefer/cache last-known tokens in the `pressure` getter so
  Basis B can't flicker the band; optional reconcile of Basis B to same scale;
  add debug trace of `(tokens, percent, basis)` per event to confirm trigger.
- **Doc:** `docs/specs/find-pressure-basis-oscillation.md`
- **Acceptance:** session that flickered now holds a monotonic-ish band; drops
  only on real compaction events (visible in compaction graph / SSE).

---

## OPEN QUESTIONS
- How often does pi send percent-only (no token count) context events? Determines
  whether the dual-basis flip is the sole trigger. Answered by the debug trace in
  the finding above.

---

## DONE
- **v0.6.3** — lazy-load PGlite (`loadPgLite`) so a missing package degrades to the
  sync scan instead of crashing extension load. `docs/specs/fix-pglite-lazy-import.md`.

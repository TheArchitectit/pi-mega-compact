# Finding: pressure band oscillates from a dual-basis switch, not compression tiering

**Date:** 2026-07-16
**Type:** Investigation / bug-finding (no code change in this doc)
**Severity:** Low–Medium (cosmetic/observability; misleads testers, not data loss)
**Status:** Confirmed root cause (code-path analysis); fix not yet written
**Branch:** feat/verify-s24

---

## OBSERVATION (from the field)

During a live session the dashboard pressure band jumped **30% → high-70s% →
instant drop-back** with no compaction pause (a real compaction takes 30s+, emits
a compaction event). The drop-back was effectively instant. Initial hypothesis
was "the compression tiering is causing this." This doc records the investigation
and conclusion.

## CONCLUSION

**The compression tiering is NOT the cause.** The band oscillation comes from the
`pressure` getter switching between **two different measurement bases** frame to
frame, because `thresholdTokens` (the denominator) is a fixed boot constant while
`currentTokens` (the numerator) is a per-event live value that pi may report
either as an exact token count or as only a usage percentage.

The compression tier (`MEGACOMPACT_TIER` → `config.tier`) only selects
`thresholdTokens` once, at `loadConfig()` — it never changes mid-session, so it
cannot produce a live jump. See Evidence below.

## EVIDENCE

### 1. `thresholdTokens` is fixed at boot — tier cannot move it live

`extensions/mega-config.ts:93-102` (`resolveThreshold`):

```ts
function resolveThreshold(): { tier: CompactTier | "custom"; thresholdTokens: number } {
  const explicit = process.env.MEGACOMPACT_THRESHOLD_TOKENS;
  if (explicit != null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n)) return { tier: "custom", thresholdTokens: n };
  }
  const raw = (process.env.MEGACOMPACT_TIER ?? "low").toLowerCase();
  const tier = (raw in COMPACT_TIERS ? raw : "low") as CompactTier;
  return { tier, thresholdTokens: COMPACT_TIERS[tier] };
}
```

Called once at `loadConfig()` (`mega-config.ts:122`). `thresholdTokens` is then
stored on the immutable `MegaConfig`. No code path re-resolves it per event.

### 2. The tier is a read-out of pressure, not a cause

`src/config.ts:70-84`:

```ts
export function pressureRatio(currentTokens, thresholdTokens) {
  return clamp01(thresholdTokens > 0 ? currentTokens / thresholdTokens : 0);
}
export function pressureBand(pressure) {
  if (p >= 1.0) return "mega";
  if (p >= 0.9) return "ultra";
  if (p >= 0.75) return "high";
  if (p >= 0.5) return "medium";
  return "low";
}
```

`pressureBand` is a pure function of `pressure`. It is *derived*, never fed back
into the token count. Tier/compression cannot produce a jump.

### 3. The real cause: dual-basis `pressure` getter

`extensions/mega-runtime.ts:175-180`:

```ts
get pressure(): number {
  if (this.lastCtxTokens != null && this.lastCtxTokens > 0 && this.config.thresholdTokens > 0) {
    return pressureRatio(this.lastCtxTokens, this.config.thresholdTokens);  // BASIS A: token / threshold
  }
  return pressureFromPct(this.lastCtxPercent);                             // BASIS B: pi's reported usage %
}
```

`pressure` is computed two **disagreeing** ways depending on which signal the
last context event carried:
- **Basis A** (`token / threshold`) when the event includes a token count.
- **Basis B** (`pressureFromPct(lastCtxPercent)`) when the event carries only a
  usage percentage (no token count).

If context events alternate between "has tokens" and "percent-only", the band
flips between the two bases. They are not on the same scale, so the band can jump
30% → 70s% → snap back **instantly**, with no compaction. This matches the
observed symptom precisely.

`lastCtxTokens` / `lastCtxPercent` are updated by the live context handler
(`mega-runtime.ts:282` exposes `lastCtxTokens` in the trigger snapshot), so the
basis depends on what pi sent most recently — not on anything the extension
decides.

## WHY THIS READS LIKE TIERING

The dashboard tier label (`pressureBand` over `pressure`) is the most visible
output of `pressure`. Because the *label* is what jumps, it's natural to suspect
the *compression tier*. But the compression tier is the fixed denominator; the
*jumping numerator basis* is what's visible. The confusion is understandable —
they share the word "tier."

## RECOMMENDATION (fix not yet written)

Make the pressure basis stable within a session so the band stops oscillating
between two disagreeing measures:

1. **Prefer/cache last-known tokens.** In the `pressure` getter, once a real
   `lastCtxTokens > 0` has been seen, keep using Basis A and ignore Basis B flicker
   (pi's percent can lag/diverge). Only fall back to Basis B before any token count
   has ever arrived. This alone kills the frame-to-frame flip.
2. **(Optional) Reconcile Basis B to the same scale.** If percent-only events must
   be honored, convert via the session's known window size rather than treating the
   percent as an independent 0–100 scale, so the two bases agree.
3. **Add a diag trace** (temporary) logging `(lastCtxTokens, lastCtxPercent, basis)`
   per context event to confirm in the field that events alternate between
   token-bearing and percent-only — this validates the trigger before/while shipping
   the fix. Gate it behind `config.debug`.

**Risk:** Low. Change is confined to the `pressure` getter (one function) plus an
optional debug log. No schema, no recall/compaction behavior change. The fix can
be canary-sequenced but needs no tier rollout (it's read-only to the signal).

**Acceptance:** With the fix, a session that previously showed 30%↔70s% instant
flicker should hold a monotonic-ish band that only drops on a real compaction
event (visible in the compaction graph / SSE stream). Tester guide note in
`TESTER_GUIDE.md` (Dashboard "Reading the pressure band") already tells testers
how to distinguish a real compaction from a recompute.

## OPEN QUESTION

Unverified: *how often* does pi actually send percent-only (no token count)
context events? This determines whether the dual-basis flip is the sole trigger
or merely a possible one. A live trace (recommendation #3) answers it. Until then,
the fix in #1 is correct regardless — it removes the flip either way.

## RELATED

- `TESTER_GUIDE.md` Dashboard "Reading the pressure band" note + Known Issues entry
  ("Pressure band can show wild jumps / instant drop-backs").
- `src/config.ts` `pressureRatio` / `pressureBand` / `pressureFromPct`.
- `extensions/mega-runtime.ts` `pressure` getter, `lastCtxTokens`, `lastCtxPercent`.

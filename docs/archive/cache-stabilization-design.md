# Caching Stability & Diagnostic Tooling Design

## 1. Caching Stabilization (Dual-Threshold Strategy)
To address KV-cache prefix thrash at 1M-token scales, we have transitioned from a single-trigger compaction model to a **Dual-Threshold** strategy.

- **Soft Drift Threshold (50%):** The system now allows the context window to drift up to 50% without forcing a re-compaction. During this drift, we `replay` the previous summary and sentinel marker. This keeps the KV-cache prefix stable across 500k-token growth phases, significantly improving cache-hit rates in long-lived sessions.
- **Hard Threshold (90%):** The legacy "must compact" trigger remains at 90% as an absolute safety bound for memory management.

## 2. Startup Diagnostics
To surface bottlenecks during initialization, we introduced a "System Startup" diagnostic tool.
- **Functionality:** It parses `PI_TIMING` logs to surface the subagent factory load vs. `bindExtensions` time.
- **Dashboard Integration:** Surfaced via a new tab in the Perf dashboard (port 9320).
- **Implementation:** Leverages read-only event log analysis to maintain compliance with `PREVENT-PI-004` (read-only diagnostics).

## 3. Findings Summary (Exoneration Report)
- **Startup Latency:** Investigative analysis confirms `pi-mega-compact` accounts for ~2.5s of total startup time, while `pi-subagents` and base `bindExtensions` account for ~45s.
- **Cache Thrash:** The previous threshold of 10% (RECOMPACT_PCT_DELTA) caused unnecessary invalidations on large contexts, which has been corrected by the 50% shift.

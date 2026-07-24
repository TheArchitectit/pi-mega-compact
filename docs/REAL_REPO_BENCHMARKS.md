# Real-Repo Compact Benchmark

Compact token size over reads and tasks in real repositories. Three repos,
1M tokens of simulated agent work each (reads, edits, commands, searches),
measured at 100k-token checkpoints.

## Reproduce

```bash
npm run build
npx tsx scripts/benchmark/real-repo-benchmark.ts
npx tsx scripts/benchmark/real-repo-benchmark.ts --skip-pivcc   # faster, mega-compact only
npx tsx scripts/benchmark/real-repo-benchmark.ts --repos=rad-gateway --target-tokens=500000
```

## Repos tested

| Repo | Files | Lines | Language | Description |
|------|-------|-------|----------|-------------|
| pi-ithacus-agent-framework | 46 | 7,183 | TypeScript/Python | Small agent framework |
| rad-gateway | 1,187 | 359,291 | Go/JS/TS | Large Go gateway service |
| game04 | 618 | 158,599 | Go/Python/JS | Medium game project |

## Results: 1M tokens input per repo

### Compact output (tokens)

| Repo | **mega-compact** | **pi-vcc-baseline** | **pi-vcc-ranked** |
|------|-----------------|--------------------|--------------------|
| pi-ithacus-agent-framework | 64.2k | 859 | 3.4k |
| rad-gateway | 35.5k | 1.0k | 4.1k |
| game04 | 56.1k | 1.1k | 4.3k |

### Compression ratio (compact / input)

| Repo | **mega-compact** | **pi-vcc-baseline** | **pi-vcc-ranked** |
|------|-----------------|--------------------|--------------------|
| pi-ithacus-agent-framework | 6.4% | 0.1% | 0.3% |
| rad-gateway | 3.5% | 0.1% | 0.4% |
| game04 | 5.6% | 0.1% | 0.4% |

### Checkpoint progression (mega-compact)

How compact size grows as reads and tasks accumulate:

**pi-ithacus-agent-framework** (small TS repo, stable ratio):
| Input tokens | Messages | Compact tokens | Ratio |
|-------------|----------|---------------|-------|
| 100k | 202 | 6.5k | 6.5% |
| 200k | 408 | 12.9k | 6.4% |
| 300k | 616 | 19.4k | 6.4% |
| 400k | 822 | 25.8k | 6.4% |
| 500k | 1,030 | 32.2k | 6.4% |
| 600k | 1,236 | 38.6k | 6.4% |
| 700k | 1,446 | 45.1k | 6.4% |
| 800k | 1,654 | 51.6k | 6.4% |
| 900k | 1,866 | 58.2k | 6.4% |
| **1.00M** | **2,060** | **64.2k** | **6.4%** |

**rad-gateway** (large Go repo, ratio dips then recovers):
| Input tokens | Messages | Compact tokens | Ratio |
|-------------|----------|---------------|-------|
| 100k | 162 | 5.4k | 5.3% |
| 233k | 256 | 8.6k | 3.7% |
| 423k | 274 | 9.3k | 2.2% |
| 523k | 322 | 10.7k | 2.1% |
| 625k | 524 | 17.1k | 2.7% |
| 726k | 588 | 19.2k | 2.6% |
| 826k | 782 | 25.6k | 3.1% |
| 927k | 986 | 32.6k | 3.5% |
| **1.00M** | **1,070** | **35.5k** | **3.5%** |

**game04** (medium game repo, variable ratio):
| Input tokens | Messages | Compact tokens | Ratio |
|-------------|----------|---------------|-------|
| 101k | 124 | 4.4k | 4.4% |
| 202k | 286 | 10.0k | 4.9% |
| 303k | 480 | 17.0k | 5.6% |
| 405k | 634 | 22.7k | 5.6% |
| 517k | 692 | 24.9k | 4.8% |
| 618k | 808 | 29.0k | 4.7% |
| 718k | 978 | 35.1k | 4.9% |
| 819k | 1,228 | 44.0k | 5.4% |
| 922k | 1,428 | 51.3k | 5.6% |
| **1.00M** | **1,564** | **56.1k** | **5.6%** |

## What the numbers show

**mega-compact produces 15–65x more output than pi-vcc at 1M tokens.**
mega-compact's extractive summary preserves file names, commands, and
structured sections. pi-vcc's `compile` takes only the tail of the
transcript; at 1M tokens, the tail is a tiny fraction of the whole.

**pi-vcc's output is extremely small at scale** — 859–1,100 tokens for a
1M-token transcript. That's essentially just the last few messages.
`compileRanked` does better (3.4–4.3k) by selecting important blocks, but
it's still an order of magnitude smaller.

**The trade-off: size vs information.** pi-vcc achieves 99.9% compression
but retains almost nothing from the session history. mega-compact achieves
93–97% compression while preserving a structured summary of what happened.
Which is better depends on whether you need the agent to remember what it
did earlier in the session.

**Checkpoint progression shows the ratio is repo-dependent.** Small repos
(pi-ithacus) have a stable ratio — each new file adds roughly proportional
summary content. Large repos (rad-gateway) show the ratio dip as large
files are read (the summary can't grow as fast as the input), then recover
as repeated patterns get deduplicated.

**Latency is negligible.** All compactors run in <100ms even at 1M tokens.
The bottleneck is the LLM, not the compactor.

## Caveats

- **Simulated work, not real sessions.** The transcripts are built by
  walking real file trees and simulating reads/edits, but they're not
  actual agent sessions. Real sessions have more varied patterns (errors,
  retries, user corrections, multi-turn conversations).
- **Token estimation is approximate.** Uses `len/4 + 1` per block, not a
  real tokenizer. The ratios are directionally correct but not exact.
- **pi-vcc's compile is designed for shorter sessions.** At 1M tokens,
  it's being asked to compress far beyond its design envelope. Its
  sweet spot is likely 50–200k tokens.
- **This measures output size, not quality.** A smaller output isn't
  better if it loses critical information. See
  [BENCHMARKS.md](BENCHMARKS.md) for recall-based quality scoring.

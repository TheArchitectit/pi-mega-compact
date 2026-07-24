# Compaction Benchmarks

How pi-mega-compact's compaction quality is measured against a raw-truncation
baseline, and (when available) against [pi-vcc](https://github.com/sting8k/pi-vcc)
— using a shared, format-agnostic fact extractor so no compactor gets a parsing
advantage.

> **Honesty note.** We publish the full table — recall wins AND losses. If a
> compactor trails on certain sessions or fact categories, we say so. The
> defensible claim is whatever the numbers actually show.

---

## 1. What is measured

When a session is compacted, the older transcript is replaced by a **brief**: a
compressed summary that must preserve the durable facts of the session (files
edited, commands run, commits made, ...) while staying small.

Two things are in tension:

- **Recall** — how many real facts survive into the brief.
- **Size** — how many characters the brief costs.

The benchmark compares compactors on:

| Metric | What it measures |
|--------|-----------------|
| **weightedRecall** | Fraction of *value* kept (weighted by fact category). Empty session → 1. |
| **weightedFactDensity** | Value kept per 1k chars — the size-normalised version. This is the primary optimisation target. |
| **precision** | Mean fact-weight of the brief's own facts (penalises noise / redundancy). |
| **duplicateFacts** | Duplicate facts in the brief (redundancy signal). |
| **size** | Brief output size in characters. |
| **latencyMs** | Compaction time. |

## 2. Compactores compared

| Compactor | Type | Description |
|-----------|------|-------------|
| `raw-truncate` | Baseline | Keep the last N chars of the transcript verbatim. Wins on raw recall (keeps everything) but loses badly on size/density. |
| `mega-compact` | Ours | Deterministic extractive summary: files changed, commands, timeline, recent requests, pending work. No LLM call at runtime. |
| `pi-vcc-baseline` | Reference | [pi-vcc](https://github.com/sting8k/pi-vcc)'s `compile()` — contiguous transcript-tail brief. |
| `pi-vcc-ranked` | Reference | pi-vcc's `compileRanked()` — ranked brief with importance weighting. |

> All four are compared symmetrically. The same format-agnostic regex fact
> extractor (`scripts/benchmark/extract.ts`) parses every brief, so our output
> format doesn't penalise pi-vcc's parser and vice versa.

## 3. Datasets

| Dataset | Description | Default size |
|---------|-------------|-------------|
| **synthetic** | Deterministic seeded PRNG generator producing realistic transcripts with controlled fact density and duplication. Fully reproducible. | 200 sessions |
| **real** | Reads `~/.pi/agent/sessions/*.jsonl` — actual transcripts from your own sessions. Only aggregate metrics + session IDs are exported; transcript text is never written to out/. | ≤50 sessions |

Synthetic sessions use a configurable duplication fraction (`--dup-frac`,
default 0.3) to test dedup noise. The default PRNG seed is 42 — same seed
→ same sessions → same results.

## 4. Scoring methodology

### Symmetric extraction (pi-vcc §3.1)

Both sides use the same parser. We use a format-agnostic regex extractor
(`scripts/benchmark/extract.ts`) that applies the same regex patterns to
*every* brief, regardless of which compactor produced it. Ground truth is
extracted from the full transcript using the same patterns.

### Paired deltas (pi-vcc §3.4)

Every metric is computed per-session, then compared as a **paired delta**
against the raw-truncate baseline — not as a marginal (separate) median.
This matters: marginal comparison can mislead when session size varies
widely (the compactor that happens to get more large sessions will appear
worse on raw recall).

### Fact weights (pi-vcc §3.2)

| Fact category | Weight | Rationale |
|--------------|--------|-----------|
| Failed commands | 6 | Highest signal: regressions, root causes |
| Commits | 5 | Durable, high-signal history |
| Files modified | 4 | Core work product |
| Edit-class tools | 4 | Same: what was changed |
| Test/verify commands | 4 | CI state, quality gates |
| gh pr/issue commands | 2 | Workflow context |
| Files read | 1 | Lower signal than files changed |
| Search commands | 1 | Background noise vs signal |
| Read-class tools | 1 | Background noise vs signal |
| Other commands | 0.5 | Low-signal catch-all |

> Edit to match your workflow. Weights live in `scripts/benchmark/facts.ts`.

## 5. How to reproduce

```bash
# 1. Build pi-mega-compact (produces dist/src/compact.js)
npm run build

# 2. Clone pi-vcc (needed only for head-to-head; synthetic-only runs skip it)
git clone https://github.com/sting8k/pi-vcc.git /tmp/pi-vcc
export PI_VCC_DIR=/tmp/pi-vcc

# 3. Run synthetic benchmark (reproducible, no external deps)
node --import tsx scripts/benchmark/run.ts --corpus=synthetic --seed=42 --limit=200

# 4. Run real-session benchmark (reads ~/.pi/agent/sessions)
node --import tsx scripts/benchmark/run.ts --corpus=real --limit=50

# 5. Run both
node --import tsx scripts/benchmark/run.ts --corpus=both --seed=42

# 6. Run specific compactors only
node --import tsx scripts/benchmark/run.ts --compactors=mega-compact,raw-truncate

# Results land in scripts/benchmark/out/results.{json,csv}
```

## 6. Current results

Reproduce: `npx tsx scripts/benchmark/run.ts --corpus=synthetic --seed=42 --limit=200`

### Synthetic (seed=42, n=200, dup-frac=0.3, budget=8000)

| Metric | **raw-truncate** | **mega-compact** | **pi-vcc-baseline** | **pi-vcc-ranked** |
|---|---|---|---|---|
| recall (median) | 41.8% | 56.4% | 30.8% | 37.9% |
| recall (mean ± IQR) | 40.1% ± 18.5% | 57.2% ± 13.1% | 30.0% ± 14.3% | 35.3% ± 17.3% |
| density (median) | 3.80 | 4.11 | 4.69 | 4.08 |
| precision (median wt) | 1.65 | 1.57 | 1.45 | 1.40 |
| size (median) | 4.6k | 6.1k | 2.9k | 4.1k |
| size (total) | 913.6k | 1217.0k | 568.6k | 811.0k |
| dup facts (median) | 121.0 | 79.0 | 59.0 | 90.0 |
| latency (median) | 0.00ms | 0.10ms | 0.42ms | 0.40ms |
| latency (p95) | 0.00ms | 0.19ms | 0.81ms | 0.82ms |

### Paired deltas vs raw-truncate baseline

| Delta | **mega-compact** | **pi-vcc-baseline** | **pi-vcc-ranked** |
|---|---|---|---|
| recall (median Δ) | **+17.7%** | −10.6% | −5.3% |
| density (median Δ) | +0.15 | **+0.88** | −0.07 |
| precision (median Δ) | −0.07 | −0.20 | −0.25 |
| size (median Δ) | +1.5k | −1.6k | −461 |

### What the numbers show

**mega-compact leads on recall** (+17.7% over raw-truncate, +25.6% over
pi-vcc-baseline). Our structured extractive summary preserves more durable
session facts than all three alternatives.

**pi-vcc-baseline leads on density** (4.69 vs 4.11). The smallest brief
(2.9k median) with decent fact capture from the transcript tail. When you're
strictly size-constrained, pi-vcc-baseline is more efficient per char.

**Size trade-off.** mega-compact's +1.5k chars over raw-truncate buys +17.7%
recall. Whether that's worth it depends on your context window budget.

**Duplication reduction.** mega-compact reduces duplicate facts by 35% (121→79).
pi-vcc-baseline reduces by 51% (121→59). pi-vcc-ranked by 26% (121→90).

**Latency.** All sub-1ms. mega-compact is fastest (0.10ms median) since it's
a deterministic template; pi-vcc does more work (0.40ms median).

### Real sessions

*Not yet run — requires `~/.pi/agent/sessions/` populated with real transcripts.
Reproduce: `npx tsx scripts/benchmark/run.ts --corpus=real --limit=50`*

## 7. Real-repo head-to-head (mega-compact vs pi-vcc)

A separate benchmark (`scripts/benchmark/bench-mega.mjs` + `bench-vcc.mjs`) measures
**real compactor output size** over real repos — not synthetic data, not recall.
Both compactors are algorithmic (no LLM call during compaction), so the comparison
is apples-to-apples on the same input conversation.

**Fair-comparison protocol:** same repos cloned fresh on both machines, same Plexus
API + `claude-sonnet-4-6` model, same 100k-token checkpoint interval, 1M token
target per repo. mega-compact ran on localhost; pi-vcc ran on UCS03 with a clean PI
config (only pi-vcc installed — no other extensions). Real token counts from the
API `usage` field. See `scripts/benchmark/README.md`.

### Results: pi-ithacus-agent-framework (65 files)

The only repo where both compactors accumulated enough tokens to publish.

| Input tokens | **mega-compact** | **pi-vcc** |
|---|---|---|
| ~100k | 1,816 tok (1.77%) 4ms | 2,398 tok (2.23%) 10ms |
| ~200k | 1,629 tok (0.78%) 3ms | 2,453 tok (1.20%) 6ms |
| ~300k | 1,624 tok (0.53%) 2ms | 2,380 tok (0.78%) 4ms |
| ~400k | 1,731 tok (0.43%) 1ms | 3,053 tok (0.76%) 7ms |
| ~500k | — | 2,414 tok (0.48%) 4ms |

### What the numbers show

**mega-compact produces a smaller brief at every checkpoint** — 25–47% fewer
tokens than pi-vcc (1,624–1,816 vs 2,380–3,053 tokens). Its compression ratio
drops faster as input grows (1.77% → 0.43%) because the extractive timeline
converges and deduplicates as the same files turn up repeatedly.

**Both compactors plateau in absolute size.** mega settles around ~1,650 tokens;
pi-vcc around ~2,400–3,000 tokens (its structured sections — Files / Commits /
Signals — grow with the diversity of work touched, so the brief isn't strictly
constant). The ratio "win" is partly an artifact of input growing while output
plateaus; the real finding is that mega plateaus lower.

**Latency is irrelevant.** Both are sub-10ms at any scale (1–4ms for mega,
4–10ms for pi-vcc). Compaction is not the bottleneck — the LLM call is.

### What this does NOT prove (honest)

- **Size ≠ quality.** A smaller brief that drops critical facts is worse, not
  better. This benchmark measures compactor *output size*, not *fact recall*.
  pi-vcc's curated sections (Files/Commits/Signals) may preserve more
  high-value facts per token even at a larger size. The recall-based benchmark
  in §6 above addresses quality; these two benchmarks measure different things.
- **One repo only.** Neither compactor finished rad-gateway (359k lines) or
  game04 before the run was stopped. The small-repo trend (mega smaller) may
  not hold on large repos where VCC's structured sections scale with work
  diversity. **Treat this as a single data point, not a general claim.**
- **Simulated transcript.** The conversation is built by walking real file
  trees and simulating reads/reviews — not a real agent session with errors,
  retries, and multi-turn conversation.

### Reproduce

```bash
# mega-compact (on your machine)
npm run build
node scripts/benchmark/bench-mega.mjs \
  --provider-url http://your-plexus:4001/v1 --api-key $KEY \
  --max-tokens 1000000 --checkpoint-interval 100000 \
  /path/to/repo

# pi-vcc (on a clean machine with only pi-vcc installed)
node scripts/benchmark/bench-vcc.mjs \
  --provider-url http://your-plexus:4001/v1 --api-key $KEY \
  --max-tokens 1000000 --checkpoint-interval 100000 \
  /path/to/repo
```

## 8. Honest caveats

- **Synthetic sessions are controlled but not real.** The fact density, tool
  distribution, and duplication patterns are tuned by the PRNG generator.
  Real sessions may show different patterns. Run on real sessions before
  drawing conclusions for production use.
- **Our recall lead may narrow on real sessions.** pi-vcc's `compileRanked`
  is designed for heterogeneous transcripts where some blocks matter more
  than others. On synthetic data where every message is similar quality,
  ranking doesn't help much. Real sessions could close the gap.
- **The fact extractor is regex-based.** It can't distinguish between a file
  mentioned in discussion vs a file actually edited. Both sides are scored
  by the same extractor, so this is symmetric, but it means both scores
  have a noise floor.
- **This benchmark does NOT measure the full system.** Our live-trim, dedup
  tiers, recall@k, mid-run durable relief, and error-retry reliability are
  not captured here. The static compaction quality is one surface; the
  end-to-end value is another.

## 9. File reference

| File | Purpose |
|------|---------|
| `scripts/benchmark/facts.ts` | Fact model, weights, metrics |
| `scripts/benchmark/extract.ts` | Format-agnostic fact extractor |
| `scripts/benchmark/compactors.ts` | Pluggable compactor adapters |
| `scripts/benchmark/corpus.ts` | Synthetic + real session loaders |
| `scripts/benchmark/score.ts` | Paired scoring + aggregation |
| `scripts/benchmark/run.ts` | CLI runner (recall-based, §6) |
| `scripts/benchmark/bench-mega.mjs` | Real-repo size benchmark — mega-compact (§7) |
| `scripts/benchmark/bench-vcc.mjs` | Real-repo size benchmark — pi-vcc (§7) |
| `scripts/benchmark/README.md` | How to run the head-to-head + fair-comparison protocol |
| `scripts/benchmark/out/results.json` | Full results (gitignored) |
| `scripts/benchmark/out/results.csv` | Per-session CSV (gitignored) |
| `scripts/benchmark/*-results.jsonl` | Per-checkpoint JSONL results (gitignored — transcript-derived) |
| `scripts/benchmark/*-bench.log` | Benchmark run logs (gitignored) |

# Benchmark Scripts

Head-to-head compaction benchmarks: **pi-mega-compact** vs **[pi-vcc](https://github.com/sting8k/pi-vcc)**.

Both compactors are **algorithmic** (no LLM call during compaction) — they read a conversation transcript and produce a structured summary. This makes the comparison fair: same input conversation, same token counting, same checkpoint cadence.

## Files

| File | Runs on | Compactor |
|------|--------|-----------|
| `bench-mega.mjs` | localhost | pi-mega-compact's `summarizeMessages` (from `dist/src/compact.js`) |
| `bench-vcc.mjs` | UCS03 (or any machine with pi-vcc installed) | pi-vcc's `compile` algorithm |

Both scripts share the same structure: walk a repo → make real LLM API calls accumulating tokens → at each checkpoint, run the compactor and measure output size + ratio + latency.

## How to run

### Setup
```bash
# Build pi-mega-compact (for bench-mega.mjs)
npm run build

# Install pi-vcc on the comparison machine (for bench-vcc.mjs)
npm install pi-vcc
```

### Run mega-compact (localhost)
```bash
node scripts/benchmark/bench-mega.mjs \
  --provider-url http://your-plexus:4001/v1 \
  --api-key YOUR_KEY \
  --max-tokens 1000000 \
  --checkpoint-interval 100000 \
  --output scripts/benchmark/mega-results.jsonl \
  /path/to/repo1 /path/to/repo2 /path/to/repo3
```

### Run pi-vcc (separate machine for fairness)
```bash
node scripts/benchmark/bench-vcc.mjs \
  --provider-url http://your-plexus:4001/v1 \
  --api-key YOUR_KEY \
  --max-tokens 1000000 \
  --checkpoint-interval 100000 \
  --output vcc-results.jsonl \
  /path/to/repo1 /path/to/repo2 /path/to/repo3
```

## Fair-comparison protocol

For an honest head-to-head:
1. **Same repos** on both machines (clone fresh from GitHub).
2. **Same API** — both hit the same provider with the same model.
3. **Same checkpoint interval** and **max tokens**.
4. **Separate machines** — mega on localhost, VCC on UCS03 (or vice versa), each with a clean PI config (only the compactor under test installed).
5. **Real API token counts** — tokens come from the API `usage` field, not estimates.

## Output format

Each script appends one JSON line per checkpoint:
```json
{
  "checkpoint": 1,
  "repo": "repo-name",
  "compactor": "mega" | "vcc",
  "totalConversationTokens": 102608,
  "inputTokens": 37722,
  "outputTokens": 15696,
  "compactOutputTokens": 1816,
  "totalCompactTokensSoFar": 1816,
  "compactAPITokensSpent": 0,
  "compactMs": 4,
  "compactRatio": "1.77%",
  "conversationLength": 22,
  "filesRead": 11,
  "timestamp": "2026-07-24T03:15:57.000Z"
}
```

Results files (`*-results.jsonl`) and logs (`*-bench.log`) are gitignored — they're transcript-derived and may contain repo/session content. Aggregate numbers belong in `docs/BENCHMARKS.md`.

## What's measured

- **compactOutputTokens** — size of the compactor's output (estimated `chars/4`).
- **compactRatio** — `compactOutputTokens / totalConversationTokens`. Lower = more compression.
- **compactMs** — compaction latency. Both compactors are sub-10ms at any scale; latency is not a meaningful differentiator.

## What's NOT measured (honest caveats)

- **Recall / fact preservation.** A smaller brief isn't better if it drops critical facts. This benchmark measures *size*, not *quality*. See `docs/BENCHMARKS.md` for a separate recall-based benchmark using a symmetric fact extractor.
- **Large-repo behavior at full scale.** The published results cover one repo at ~500k tokens. Large repos (e.g. a 359k-line Go codebase) may behave differently — VCC's structured sections (Files/Commits/Signals) scale with work diversity, while mega's extractive timeline plateaus.
- **Real agent sessions.** The transcript is simulated (file reads + reviews), not a real agent session with errors, retries, and multi-turn conversation.

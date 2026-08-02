/**
 * bench-summary.test.ts — Ratio benchmark summary table reporter.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it } from "node:test";

describe("Ratio Benchmark Summary", () => {
  it("produces a summary table", () => {
    console.log("");
    console.log("    ============================================================");
    console.log("    |           Compression & Dedup Ratio Benchmarks           |");
    console.log("    ============================================================");
    console.log("    | Metric                              | Expected  | Measured |");
    console.log("    |-------------------------------------|-----------|----------|");
    console.log("    | Compression tier: tiny (<512B)      | raw pass  | see above|");
    console.log("    | Compression tier: small (512B-4KB)  | gzip l1   | see above|");
    console.log("    | Compression tier: med (4KB-32KB)    | gzip l6   | see above|");
    console.log("    | Compression tier: large (>32KB)     | brotli l4 | see above|");
    console.log("    | Extractive summary ratio            | ~35:1     | see above|");
    console.log("    | L0 exact hash dedup                 | detected  | see above|");
    console.log("    | L1 near-duplicate (one-word edit)   | detected  | see above|");
    console.log("    | L1 negative (major change)          | preserved | see above|");
    console.log("    | L2 semantic cosine                  | detected  | see above|");
    console.log("    | Pipeline: 50-turn conversation      | >=1:1     | see above|");
    console.log("    | Pipeline: 200-turn conversation     | >=1:1     | see above|");
    console.log("    | Token estimation: char/4 heuristic  | +/- 50%   | see above|");
    console.log("    | Dedup sentinel: skip injected        | 100% skip | see above|");
    console.log("    ============================================================");
    console.log("");
  });
});

/**
 * compression-tiers.test.ts — Compression tier ratio benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compressSmart, decompressSmart } from "../store/compression.js";
import { generateMessages } from "./_helpers.js";

describe("Compression Tier Ratios", () => {
  const sizes = [
    { name: "tiny (< 512 B)", bytes: 200 },
    { name: "small (512 B - 4 KB)", bytes: 2000 },
    { name: "medium (4 KB - 32 KB)", bytes: 15000 },
    { name: "large (> 32 KB)", bytes: 80000 },
  ];

  for (const { name, bytes } of sizes) {
    it(`compressSmart round-trip on ${name} payload`, () => {
      const content = generateMessages(Math.ceil(bytes / 200), {
        pattern: "mixed",
      })
        .map((m) => m.text)
        .join("\n---\n");
      const buf = Buffer.from(content, "utf-8");

      const compressed = compressSmart(buf);
      const decompressed = decompressSmart(compressed);

      assert.deepEqual(decompressed, buf, "Round-trip must produce identical bytes");

      const ratio = compressed.length / buf.length;
      const savings = ((1 - ratio) * 100).toFixed(1);

      if (buf.length > 512) {
        assert.ok(
          ratio < 1.0,
          `Compressed (${compressed.length}) should be smaller than original (${buf.length})`,
        );
      }

      console.log(
        `    ${name}: ${buf.length}B -> ${compressed.length}B (${savings}% saved, ratio ${ratio.toFixed(3)})`,
      );
    });
  }

  it("compression ratio improves with larger, more repetitive content", () => {
    const small = Buffer.from("hello world", "utf-8");
    const smallCompressed = compressSmart(small);

    const largeContent =
      "The compression module handles gzip and brotli. ".repeat(500);
    const large = Buffer.from(largeContent, "utf-8");
    const largeCompressed = compressSmart(large);

    const smallRatio = smallCompressed.length / small.length;
    const largeRatio = largeCompressed.length / large.length;

    assert.ok(
      largeRatio < smallRatio,
      `Large repetitive ratio (${largeRatio.toFixed(3)}) should be better than small unique ratio (${smallRatio.toFixed(3)})`,
    );

    console.log(`    Small unique: ${smallRatio.toFixed(3)} ratio`);
    console.log(`    Large repetitive: ${largeRatio.toFixed(3)} ratio`);
  });

  it("different content types compress differently", () => {
    const make = (text: string): Buffer => Buffer.from(text, "utf-8");

    const code = make(
      Array.from(
        { length: 100 },
        (_: unknown, i: number) =>
          `function handler${i}(input: string): Result {\n  const data = transform(input);\n  return { ok: true, data };\n}`,
      ).join("\n\n"),
    );

    const prose = make(
      Array.from(
        { length: 100 },
        (_: unknown, i: number) =>
          `In message ${i}, we discussed the implementation details of the compression module. The key insight was that structured data compresses better than random bytes.`,
      ).join("\n"),
    );

    const json = make(
      JSON.stringify(
        Array.from(
          { length: 100 },
          (_: unknown, i: number) => ({
            id: i,
            role: i % 2 === 0 ? "user" : "assistant",
            text: `Message ${i} about compression`,
            timestamp: Date.now() + i * 1000,
            metadata: { sessionId: "sess_abc", turnIndex: i },
          }),
        ),
      ),
    );

    const codeCompressed = compressSmart(code);
    const proseCompressed = compressSmart(prose);
    const jsonCompressed = compressSmart(json);

    const codeRatio = codeCompressed.length / code.length;
    const proseRatio = proseCompressed.length / prose.length;
    const jsonRatio = jsonCompressed.length / json.length;

    console.log(
      `    Code:  ${code.length}B -> ${codeCompressed.length}B (${codeRatio.toFixed(3)} ratio)`,
    );
    console.log(
      `    Prose: ${prose.length}B -> ${proseCompressed.length}B (${proseRatio.toFixed(3)} ratio)`,
    );
    console.log(
      `    JSON:  ${json.length}B -> ${jsonCompressed.length}B (${jsonRatio.toFixed(3)} ratio)`,
    );

    assert.ok(codeRatio < 1.0, "Code should compress");
    assert.ok(proseRatio < 1.0, "Prose should compress");
    assert.ok(jsonRatio < 1.0, "JSON should compress");
  });
});

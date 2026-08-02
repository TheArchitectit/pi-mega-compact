/**
 * Shared helpers for the ratio benchmark split test files.
 *
 * Extracted from ratio.bench.test.ts: message builders, tmp-dir lifecycle,
 * and the generateMessages / generateRealisticConversation / generateNearDuplicates
 * fixtures used across all benchmark describe blocks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { EngineMessage } from "../types.js";

export function makeMsg(role: EngineMessage["role"], text: string): EngineMessage {
  return { role, text };
}

export function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratio-bench-"));
}

/** Generate N messages with controlled repetition. */
export function generateMessages(
  n: number,
  opts: {
    pattern: "unique" | "repetitive" | "mixed" | "code-review" | "debug-session";
  },
): EngineMessage[] {
  const msgs: EngineMessage[] = [];
  const templates = [
    "I'm looking at the {file} module. The {component} needs refactoring because {reason}.",
    "Found a bug in {file}: the {component} doesn't handle {case} correctly. Here's the fix: {fix}",
    "Let me check the {file} implementation. The {component} uses {pattern} pattern which is fine for now.",
    "Updated {file} to fix the {component} issue. The {reason} was causing {case}.",
    "Running tests on {file}. The {component} test covers {case} and {fix}. Looks good.",
    "The {component} in {file} needs to handle {case}. Currently it just {fix}.",
    "Reviewed the {file} changes. The {component} refactor looks solid. {reason}.",
    "Deployed the {component} fix to staging. {file} is now handling {case} correctly.",
  ];

  const files = [
    "src/engine.ts",
    "src/store.ts",
    "src/vectorStore.ts",
    "src/compact.ts",
    "src/recall.ts",
  ];
  const components = [
    "compression",
    "dedup",
    "embedding",
    "search",
    "checkpoint",
    "supersede",
    "recall",
  ];
  const reasons = [
    "performance",
    "correctness",
    "maintainability",
    "edge case handling",
    "type safety",
  ];
  const cases = [
    "empty input",
    "large payloads",
    "concurrent access",
    "unicode content",
    "timeout",
  ];
  const fixes = [
    "added bounds checking",
    "refactored the loop",
    "added error handling",
    "simplified the logic",
    "added unit tests",
  ];
  const patterns = ["singleton", "observer", "strategy", "factory", "builder"];

  for (let i = 0; i < n; i++) {
    const template = templates[i % templates.length];
    const fill = (s: string): string =>
      s
        .replace("{file}", files[i % files.length])
        .replace("{component}", components[i % components.length])
        .replace("{reason}", reasons[i % reasons.length])
        .replace("{case}", cases[i % cases.length])
        .replace("{fix}", fixes[i % fixes.length])
        .replace("{pattern}", patterns[i % patterns.length]);

    let text: string;

    switch (opts.pattern) {
      case "unique":
        text = fill(template) + ` [turn ${i}]`;
        break;

      case "repetitive":
        text = fill(templates[i % 5]);
        break;

      case "mixed":
        text =
          i % 5 < 3
            ? fill(template) + ` [turn ${i}]`
            : fill(templates[i % 3]);
        break;

      case "code-review":
        if (i % 4 === 0) {
          text = `Reviewing PR #${i}: ${fill(template)}`;
        } else if (i % 4 === 1) {
          text = "```typescript\nfunction handle" + components[i % components.length] + "() {\n  // " + fill(template) + "\n  return result;\n}\n```";
        } else if (i % 4 === 2) {
          text = `LGTM. ${fill(template)} The test coverage looks good.`;
        } else {
          text = `@user requested changes: ${fill(template)}`;
        }
        break;

      case "debug-session":
        if (i % 6 === 0) {
          text = `Error in ${files[i % files.length]}: TypeError: Cannot read property '${components[i % components.length]}' of undefined`;
        } else if (i % 6 === 1) {
          text = `Stack trace:\n  at ${components[i % components.length]} (${files[i % files.length]}:${100 + i}:15)\n  at process (${files[(i + 1) % files.length]}:${50 + i}:3)`;
        } else if (i % 6 === 2) {
          text = `The issue is that ${cases[i % cases.length]} isn't being handled. ${fixes[i % fixes.length]}.`;
        } else if (i % 6 === 3) {
          text = `Applied fix: ${fill(template)}`;
        } else if (i % 6 === 4) {
          text = `Tests passing now. ${reasons[i % reasons.length]}.`;
        } else {
          text = `Committed fix for ${components[i % components.length]}. ${fill(template)}`;
        }
        break;

      default:
        text = fill(template);
    }

    const role: EngineMessage["role"] = i % 2 === 0 ? "user" : "assistant";
    msgs.push(makeMsg(role, text));
  }

  return msgs;
}

/** Generate a large realistic conversation with tool reads, code blocks, discussion. */
export function generateRealisticConversation(turns: number): EngineMessage[] {
  const msgs: EngineMessage[] = [];
  for (let i = 0; i < turns; i++) {
    const phase = i % 8;
    const mods = ["compression", "dedup", "embedding", "search"];
    const fns = ["vectorStore.ts", "engine.ts", "compact.ts", "recall.ts"];
    const issues = ["error handling", "type safety", "performance", "logging"];
    const bugs = ["null pointer", "type mismatch", "race condition", "memory leak"];

    switch (phase) {
      case 0:
        msgs.push(
          makeMsg(
            "user",
            `I need help with the ${mods[i % 4]} module. It's not working correctly.`,
          ),
        );
        break;
      case 1:
        msgs.push(
          makeMsg(
            "assistant",
            `Let me look at the code. I'll check the ${fns[i % 4]} file.`,
          ),
        );
        break;
      case 2:
        msgs.push(
          makeMsg(
            "tool",
            `File content of src/${["vectorStore", "engine", "compact", "recall"][i % 4]}.ts:\n${"x".repeat(800 + (i % 5) * 200)}\n// Line ${i * 10}: function ${["search", "compact", "embed", "dedup"][i % 4]}() { ... }`,
          ),
        );
        break;
      case 3:
        msgs.push(
          makeMsg(
            "assistant",
            `I found the issue. The ${mods[i % 4]} function doesn't handle edge cases properly. Here's what I suggest:\n\n\`\`\`typescript\nfunction fixed${["Search", "Compact", "Embed", "Dedup"][i % 4]}() {\n  if (!input) return null;\n  return process(input);\n}\n\`\`\``,
          ),
        );
        break;
      case 4:
        msgs.push(
          makeMsg(
            "user",
            `That looks good. Can you also fix the ${issues[i % 4]} while you're at it?`,
          ),
        );
        break;
      case 5:
        msgs.push(
          makeMsg(
            "assistant",
            `Sure. I've updated the ${issues[i % 4]} as well. The changes affect:\n- src/engine.ts\n- src/store.ts`,
          ),
        );
        break;
      case 6:
        msgs.push(makeMsg("user", "Run the tests to make sure nothing is broken."));
        break;
      case 7:
        msgs.push(
          makeMsg(
            "assistant",
            `All ${150 + i * 3} tests pass. The fix resolved the ${bugs[i % 4]} issue.`,
          ),
        );
        break;
    }
  }
  return msgs;
}

/** Generate near-duplicate messages with controlled edit distance. */
export function generateNearDuplicates(
  base: string,
  count: number,
  editLevel: "none" | "one-word" | "minor-rephrase" | "major-change",
): string[] {
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    switch (editLevel) {
      case "none":
        results.push(base);
        break;
      case "one-word":
        results.push(
          base.replace(
            "bug",
            ["issue", "defect", "error", "problem"][i % 4],
          ),
        );
        break;
      case "minor-rephrase":
        results.push(
          base
            .replace(
              "Found a bug",
              [
                "Discovered an issue",
                "Spotted a defect",
                "Located an error",
                "Identified a problem",
              ][i % 4],
            )
            .replace(
              "in the",
              ["in the", "within the", "inside the", "in our"][i % 4],
            ),
        );
        break;
      case "major-change":
        results.push(
          `Turn ${i}: ${base.split(" ").reverse().join(" ")}. Additional context: ${"y".repeat(200)}`,
        );
        break;
    }
  }
  return results;
}

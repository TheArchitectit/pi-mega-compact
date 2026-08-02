/**
 * cleanup.test.ts — remove the temp e2e base dir.
 * Split from src/e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import { rmSync } from "node:fs";
import { baseTmp } from "./_helpers.js";

test("E2E cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});


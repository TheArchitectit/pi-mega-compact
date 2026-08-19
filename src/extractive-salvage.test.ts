/**
 * extractive-salvage.test.ts — A1/A2 universal-file-detection + salvage tests.
 *
 * Regression suite for the 2026-08-19 incident: a 58,328-token GLM-4.7 session
 * on a **Go** project compacted to a 34-token skeleton summary
 * ("Conversation: 64 messages …" + three "• resume" bullets), because
 * extractive.ts only recognised rs/ts/tsx/js/json/md files and took the last N
 * user turns verbatim. The model lost all memory and looped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractiveSummarize } from "./extractive.js";
import type { EngineMessage } from "./types.js";

function msg(role: EngineMessage["role"], text: string, toolName?: string): EngineMessage {
  return toolName ? { role, text, toolName, input: text, output: text } : { role, text };
}

/** The exact shape of the skeleton we must never emit again. */
function isSkeleton(topicSummary: string): boolean {
  const lines = topicSummary.split("\n").filter((l) => l.trim().length > 0);
  const informative = lines.filter(
    (l) => !l.startsWith("Conversation:") && !/^\s*•\s*(resume|continue)\W*$/i.test(l) && l !== "User requests:",
  );
  return informative.length === 0;
}

// ---- 1. Go-project reproduction (the incident) -----------------------------

test("A1: Go project session surfaces .go key files (incident reproduction)", () => {
  const messages: EngineMessage[] = [
    msg("user", "Fix the shader so the mesh normals render correctly"),
    msg("assistant", "I'll read engine/shader.go to see the uniform bindings."),
    msg("tool", '{"file_path":"engine/shader.go"}', "read"),
    msg("assistant", "The bug is in engine/shader.go — normals are never bound."),
    msg("tool", '{"file_path":"engine/shader.go","content":"package engine"}', "write"),
    msg("assistant", "Now updating engine/mesh.go to pass the normal buffer."),
    msg("tool", '{"file_path":"engine/mesh.go","content":"package engine"}', "edit"),
    msg("user", "resume"),
    msg("assistant", "Continuing on engine/mesh.go normal buffer wiring."),
    msg("user", "resume"),
    msg("assistant", "engine/mesh.go now uploads normals; verifying engine/shader.go."),
    msg("user", "resume"),
  ];

  const s = extractiveSummarize(messages);

  assert.ok(
    /shader\.go|mesh\.go/.test(s.topicSummary),
    `topicSummary must mention a .go file, got:\n${s.topicSummary}`,
  );
  assert.ok(!isSkeleton(s.topicSummary), `summary is a skeleton:\n${s.topicSummary}`);
  assert.ok(
    /^Key files:/m.test(s.topicSummary) || /^Current work:/m.test(s.topicSummary),
    `expected a Key files or Current work line, got:\n${s.topicSummary}`,
  );
  // Meaningfully larger than the 34-token skeleton from the incident.
  assert.ok(s.tokenEstimate > 40, `summary is only ${s.tokenEstimate} tokens`);
});

// ---- 2. Other languages ----------------------------------------------------

test("A1: Python-only project surfaces .py key files", () => {
  const messages: EngineMessage[] = [
    msg("user", "the ETL job crashes"),
    msg("assistant", "Looking at etl/pipeline.py and etl/loader.py."),
    msg("tool", '{"file_path":"etl/pipeline.py"}', "read"),
    msg("assistant", "Fixed the schema cast in etl/pipeline.py."),
  ];
  const s = extractiveSummarize(messages);
  assert.ok(/pipeline\.py/.test(s.topicSummary), s.topicSummary);
});

test("A1: C/C++/Java/Kotlin/Swift/Ruby paths are recognised", () => {
  for (const file of [
    "src/main.c",
    "src/render.cpp",
    "src/App.java",
    "app/Main.kt",
    "Sources/View.swift",
    "lib/parser.rb",
    "src/util.lua",
    "web/index.php",
    "cmd/root.go",
  ]) {
    const s = extractiveSummarize([
      msg("user", "work on it"),
      msg("assistant", `I'll update ${file} for the fix.`),
    ]);
    const base = file.split("/").pop() as string;
    assert.ok(s.topicSummary.includes(base), `${file} not surfaced in:\n${s.topicSummary}`);
  }
});

// ---- 3. Noise exclusion ----------------------------------------------------

test("A1: noise files (assets/logs/locks/minified) are excluded from key files", () => {
  const messages: EngineMessage[] = [
    msg("user", "check the build"),
    msg("assistant", "Saw assets/logo.png, build/out.log, yarn.lock, dist/app.min.js and vendor.wasm."),
    msg("assistant", "The real change is in src/render.go."),
  ];
  const s = extractiveSummarize(messages);
  for (const noise of ["logo.png", "out.log", "yarn.lock", "app.min.js", "vendor.wasm"]) {
    assert.ok(!s.topicSummary.includes(noise), `noise ${noise} leaked into:\n${s.topicSummary}`);
  }
  assert.ok(s.topicSummary.includes("render.go"), s.topicSummary);
});

test("A1: markdown and json stay interesting (not noise)", () => {
  const s = extractiveSummarize([
    msg("user", "update docs"),
    msg("assistant", "Editing docs/README.md and tsconfig.json."),
  ]);
  assert.ok(s.topicSummary.includes("README.md"), s.topicSummary);
  assert.ok(s.topicSummary.includes("tsconfig.json"), s.topicSummary);
});

// ---- 4. Placeholder user-turn filtering ------------------------------------

test("A2b: placeholder user turns do not crowd out real requests", () => {
  const messages: EngineMessage[] = [
    msg("user", "real request one: add retry logic to the fetch helper"),
    msg("assistant", "Working on it."),
    msg("user", "resume"),
    msg("assistant", "Continuing."),
    msg("user", "continue"),
  ];
  const s = extractiveSummarize(messages);
  assert.ok(
    s.topicSummary.includes("real request one"),
    `substantive request missing:\n${s.topicSummary}`,
  );
  const resumeBullets = s.topicSummary
    .split("\n")
    .filter((l) => /^\s*•\s*(resume|continue)\W*$/i.test(l));
  assert.equal(resumeBullets.length, 0, `placeholder bullets present:\n${s.topicSummary}`);
});

test("A2b: all-placeholder session still reports the placeholders (honest fallback)", () => {
  const messages: EngineMessage[] = [
    msg("user", "resume"),
    msg("assistant", "ok"),
    msg("user", "resume"),
  ];
  const s = extractiveSummarize(messages);
  assert.ok(/resume/i.test(s.topicSummary), s.topicSummary);
});

// ---- 5. Skeleton salvage ---------------------------------------------------

test("A2c: skeleton sessions get a Recent activity digest", () => {
  const messages: EngineMessage[] = [
    msg("user", "resume"),
    msg("assistant", "Ran the container health probe and it responded green."),
    msg("tool", "HTTP 200 OK from the health endpoint", "bash"),
    msg("assistant", "Restarted the worker pool after the probe came back."),
    msg("tool", "worker pool restarted, 4 workers online", "bash"),
    msg("user", "resume"),
  ];
  const s = extractiveSummarize(messages);
  assert.ok(
    s.topicSummary.includes("Recent activity:"),
    `expected salvage digest, got:\n${s.topicSummary}`,
  );
  const lines = s.topicSummary.split("\n").filter((l) => l.trim());
  assert.ok(lines.length > 2, `salvage produced too little:\n${s.topicSummary}`);
  assert.ok(s.tokenEstimate > 40, `salvaged summary only ${s.tokenEstimate} tokens`);
});

test("A2c: rich sessions do NOT get a Recent activity digest", () => {
  const messages: EngineMessage[] = [
    msg("user", "add caching to the resolver"),
    msg("assistant", "I'll add an LRU cache in src/resolver.go for the hot path."),
    msg("tool", '{"file_path":"src/resolver.go","content":"package main"}', "write"),
    msg("assistant", "Done. TODO: add a benchmark for the cache."),
  ];
  const s = extractiveSummarize(messages);
  assert.ok(!s.topicSummary.includes("Recent activity:"), s.topicSummary);
});

// ---- A2a. filesModified folded into the topic summary ----------------------

test("A2a: files from write/edit tool inputs appear in the Key files line", () => {
  // The write happens EARLY so the freshness window (last 10) misses the path,
  // but filesModified extraction (extension-agnostic) still captures it.
  const messages: EngineMessage[] = [
    msg("tool", '{"file_path":"/repo/internal/queue.go","content":"package internal"}', "write"),
  ];
  for (let i = 0; i < 12; i++) messages.push(msg("assistant", `step ${i} complete`));
  const s = extractiveSummarize(messages);
  assert.ok(
    s.filesModified.some((f) => f.includes("queue.go")),
    `filesModified: ${JSON.stringify(s.filesModified)}`,
  );
  assert.ok(
    s.topicSummary.includes("queue.go"),
    `filesModified not folded into topicSummary:\n${s.topicSummary}`,
  );
});

// ---- QA lens 1 findings (2026-08-19) ----------------------------------------

test("QA-1: prose abbreviations and bare domains never reach Key files", () => {
  const prose = "we saw this e.g. at https://example.com i.e. github.com"; // guardrails-allow PREVENT-PI-004: inert fixture string (never fetched); asserts the extractor filters URL-shaped tokens from Key files
  const messages: EngineMessage[] = [];
  for (let i = 0; i < 10; i++) messages.push(msg("assistant", prose));
  messages.push(msg("assistant", "The real fixes are in cmd/main.go and pkg/util.go."));
  const s = extractiveSummarize(messages);
  const keyLine = s.topicSummary.split("\n").find((l) => l.startsWith("Key files:")) ?? "";
  assert.ok(keyLine.includes("cmd/main.go") && keyLine.includes("pkg/util.go"), keyLine);
  for (const noise of ["e.g", "i.e", "example.com", "github.com"]) {
    assert.ok(!keyLine.includes(noise), `${noise} leaked into Key files:\n${keyLine}`);
  }
});

test("QA-2: the same file mentioned relatively and written absolutely is listed once", () => {
  const messages: EngineMessage[] = [
    msg("assistant", "Now wiring the buffers in engine/mesh.go."),
    msg("tool", '{"file_path":"/proj/engine/mesh.go","content":"package engine"}', "write"),
  ];
  const s = extractiveSummarize(messages);
  const keyLine = s.topicSummary.split("\n").find((l) => l.startsWith("Key files:")) ?? "";
  assert.ok(keyLine.includes("engine/mesh.go"), keyLine);
  assert.ok(
    !keyLine.includes("/proj/engine/mesh.go"),
    `same file double-listed:\n${keyLine}`,
  );
});

test("QA-2: a fold never loses a file — same-basename different-directory case", () => {
  // Without a CWD the suffix heuristic cannot always distinguish these two
  // files; the invariant under test is that NO file disappears entirely — the
  // reader may see one form, but the union of file names is preserved.
  const messages: EngineMessage[] = [
    msg("assistant", "Comparing x/mesh.go with the upstream /proj/other/x/mesh.go."),
    msg("tool", '{"file_path":"/proj/other/x/mesh.go","content":"package x"}', "write"),
  ];
  const s = extractiveSummarize(messages);
  const keyLine = s.topicSummary.split("\n").find((l) => l.startsWith("Key files:")) ?? "";
  assert.ok(
    keyLine.includes("x/mesh.go") || keyLine.includes("/proj/other/x/mesh.go"),
    `a file vanished from Key files:\n${keyLine}`,
  );
});

// ---- Controller review fixes ------------------------------------------------

test("A1: version strings and model names are NOT extracted as files", () => {
  const s = extractiveSummarize([
    msg("user", "the GLM-4.7 model on v0.21.9 with Node 18.2 keeps failing"),
    msg("assistant", "Checking engine/render.go after the Node 18.2 bump."),
  ]);
  // Version strings may legitimately appear inside quoted user requests; the
  // regression was them being counted as FILE mentions on the Key files line.
  const keyLine = s.topicSummary.split("\n").find((l) => l.startsWith("Key files:")) ?? "";
  assert.ok(keyLine.includes("render.go"), keyLine);
  for (const junk of ["GLM-4.7", "v0.21.9", "18.2"]) {
    assert.ok(!keyLine.includes(junk), `version string ${junk} leaked into Key files:\n${keyLine}`);
  }
});

test("A2a: relative and absolute forms of the same file appear only once", () => {
  const messages: EngineMessage[] = [
    msg("assistant", "Now wiring the buffers in engine/mesh.go."),
    msg("tool", '{"file_path":"/proj/engine/mesh.go","content":"package engine"}', "write"),
  ];
  const s = extractiveSummarize(messages);
  const keyLine = s.topicSummary.split("\n").find((l) => l.startsWith("Key files:")) ?? "";
  assert.ok(keyLine.includes("engine/mesh.go"), keyLine);
  assert.ok(!keyLine.includes("/proj/engine/mesh.go"), `absolute duplicate kept:\n${keyLine}`);
});

// ---- Determinism of the new paths -----------------------------------------

test("A1/A2: new paths stay deterministic", () => {
  const messages: EngineMessage[] = [
    msg("user", "resume"),
    msg("assistant", "poking at engine/shader.go and assets/logo.png"),
    msg("tool", "ok", "bash"),
    msg("user", "continue"),
  ];
  const runs = Array.from({ length: 5 }, () => extractiveSummarize(messages));
  for (let i = 1; i < runs.length; i++) assert.deepStrictEqual(runs[i], runs[0]);
});

#!/usr/bin/env node
/**
 * vector-cortex-publish-acceptance.mjs — make the sprint-mandated command
 * `node --test dist/vector-cortex/<sprint>-acceptance.test.js` work as written,
 * WITHOUT moving the tsc build layout (rootDir="." -> dist/src/... stays canonical
 * for the app and for extensions imports).
 *
 * Why the rest of the vector-cortex compiled tree must ride along: publishing
 * ONLY the acceptance .test.js would put it at dist/vector-cortex/ where its
 * relative imports `./eval/...` and `../config/vector-cortex.js` break — the
 * modules they name live under dist/src/. The smallest truthful publish that
 * keeps file-relative ESM resolution working is to mirror the compiled
 * vector-cortex subtree (eval/) and the compiled config/vector-cortex.js it
 * links against, at their doc-mandated relative offsets:
 *
 *   dist/src/vector-cortex/<sprint>-acceptance.test.js
 *     -> dist/vector-cortex/<sprint>-acceptance.test.js
 *   dist/src/vector-cortex/eval/**            (*.js, EXCLUDING *.test.js —
 *     -> dist/vector-cortex/eval/**             run-tests already globs the raw
 *                                              dist/src copies; mirroring eval
 *                                              tests would double-run them)
 *   dist/src/config/vector-cortex.js
 *     -> dist/config/vector-cortex.js
 *
 * Nothing else is copied. dist/ IS shipped (package.json `files` includes
 * "dist"), so these additive slices are part of the published package. The
 * destination is deleted and recreated every build — the published copy is
 * never allowed to be an unpinned stale artifact of a previous build.
 */

import {
  mkdirSync,
  readdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_VECTOR = join(REPO_ROOT, "dist", "src", "vector-cortex");
const DEST_VECTOR = join(REPO_ROOT, "dist", "vector-cortex");
const SRC_CONFIG = join(REPO_ROOT, "dist", "src", "config");
const DEST_CONFIG = join(REPO_ROOT, "dist", "config");

const ACCEPTANCE_RE = /^[a-z0-9]+-acceptance\.test\.js$/;

function copyTree(src, dest, filter) {
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      n += copyTree(s, d, filter);
    } else if (filter(entry)) {
      copyFileSync(s, d);
      n += 1;
    }
  }
  return n;
}

function main() {
  rmSync(DEST_VECTOR, { recursive: true, force: true });
  rmSync(join(DEST_CONFIG, "vector-cortex.js"), { force: true });
  if (!existsSync(SRC_VECTOR)) {
    console.log("vector-cortex-publish-acceptance: no dist/src/vector-cortex; skip");
    return;
  }
  const nAccept = copyTree(SRC_VECTOR, DEST_VECTOR, (name) =>
    ACCEPTANCE_RE.test(name),
  );
  const nEval = existsSync(join(SRC_VECTOR, "eval"))
    ? copyTree(join(SRC_VECTOR, "eval"), join(DEST_VECTOR, "eval"), (name) =>
        // .js only, and exclude eval *.test.js — run-tests globs dist/** and
        // copying eval tests would double-run them (once from dist/src/...,
        // once from the published mirror).
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC0B added the replay + migrations subtrees; mirror their runtime .js too so
  // the vc0b-acceptance aggregator's `./replay/...` / `./migrations/...`
  // imports resolve at the published dist/vector-cortex/ offset.
  const nReplay = existsSync(join(SRC_VECTOR, "replay"))
    ? copyTree(join(SRC_VECTOR, "replay"), join(DEST_VECTOR, "replay"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  const nMigrations = existsSync(join(SRC_VECTOR, "migrations"))
    ? copyTree(join(SRC_VECTOR, "migrations"), join(DEST_VECTOR, "migrations"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  if (existsSync(join(SRC_CONFIG, "vector-cortex.js"))) {
    mkdirSync(DEST_CONFIG, { recursive: true });
    copyFileSync(
      join(SRC_CONFIG, "vector-cortex.js"),
      join(DEST_CONFIG, "vector-cortex.js"),
    );
  }
  console.log(
    `vector-cortex-publish-acceptance: published ${nAccept} acceptance + ${nEval} eval + ${nReplay} replay + ${nMigrations} migrations files`,
  );
}

main();

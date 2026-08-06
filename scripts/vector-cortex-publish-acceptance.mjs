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
const SRC_DEDUP = join(REPO_ROOT, "dist", "src", "dedup");
const DEST_DEDUP = join(REPO_ROOT, "dist", "dedup");

// Dash-segment id (e.g. `vc6c-impl`) is allowed so VC6C-IMPL's acceptance
// aggregator mirrors like its siblings (vc6c-acceptance, pca-acceptance, ...).
const ACCEPTANCE_RE = /^[a-z0-9-]+-acceptance\.test\.js$/;

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
  const nLedger = existsSync(join(SRC_VECTOR, "ledger"))
    ? copyTree(join(SRC_VECTOR, "ledger"), join(DEST_VECTOR, "ledger"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC0C added the resilience subtree (types/breaker/breaker-core/emit/spool/
  // spool-core); mirror its runtime .js so the vc0c-acceptance aggregator's
  // `./resilience/...` imports resolve at the published dist/vector-cortex/
  // offset (tests excluded like the ledger subtree to avoid double-runs).
  const nResilience = existsSync(join(SRC_VECTOR, "resilience"))
    ? copyTree(join(SRC_VECTOR, "resilience"), join(DEST_VECTOR, "resilience"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC1C added the conformance subtree (manifest/runner/emit). Mirror its runtime
  // .js so the vc1c-acceptance aggregator's `./conformance/...` imports resolve
  // at the published dist/vector-cortex/ offset (tests excluded).
  const nConformance = existsSync(join(SRC_VECTOR, "conformance"))
    ? copyTree(join(SRC_VECTOR, "conformance"), join(DEST_VECTOR, "conformance"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC2A added the encoder subtree (types/asset/runtime/emit). Mirror its runtime
  // .js so the vc2a-acceptance aggregator's `./encoder/...` imports resolve at
  // the published dist/vector-cortex/ offset (tests excluded).
  const nEncoder = existsSync(join(SRC_VECTOR, "encoder"))
    ? copyTree(join(SRC_VECTOR, "encoder"), join(DEST_VECTOR, "encoder"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC3A added the cortex subtree (types/store/sqlite). Mirror its runtime .js
  // so the vc3a-acceptance aggregator's `./cortex/...` imports resolve at the
  // published dist/vector-cortex/ offset (tests excluded).
  const nCortex = existsSync(join(SRC_VECTOR, "cortex"))
    ? copyTree(join(SRC_VECTOR, "cortex"), join(DEST_VECTOR, "cortex"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC3B added the topology subtree (types/build/index). Mirror its runtime .js
  // so the vc3b-acceptance aggregator's `./topology/...` imports resolve at the
  // published dist/vector-cortex/ offset (tests excluded).
  const nTopology = existsSync(join(SRC_VECTOR, "topology"))
    ? copyTree(join(SRC_VECTOR, "topology"), join(DEST_VECTOR, "topology"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC4A added the shards subtree (types/semantic/exact/manifest). Mirror its
  // runtime .js so the vc4a-acceptance aggregator's `./shards/...` imports
  // resolve at the published dist/vector-cortex/ offset (tests excluded).
  const nShards = existsSync(join(SRC_VECTOR, "shards"))
    ? copyTree(join(SRC_VECTOR, "shards"), join(DEST_VECTOR, "shards"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC4B added the residual subtree (types/dct/quantize/gf256/parity/stream/
  // codec/fixture-payload). Mirror its runtime .js so the vc4b-acceptance
  // aggregator's `./residual/...` imports resolve at the published
  // dist/vector-cortex/ offset (tests excluded like the other subtrees).
  const nResidual = existsSync(join(SRC_VECTOR, "residual"))
    ? copyTree(join(SRC_VECTOR, "residual"), join(DEST_VECTOR, "residual"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC4C added the reconstruct subtree (types/closure/assemble/validate). Mirror
  // its runtime .js so the vc4c-acceptance aggregator's `./reconstruct/...`
  // imports resolve at the published dist/vector-cortex/ offset (tests excluded).
  const nReconstruct = existsSync(join(SRC_VECTOR, "reconstruct"))
    ? copyTree(join(SRC_VECTOR, "reconstruct"), join(DEST_VECTOR, "reconstruct"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC5A added the prompt-dag + planner subtrees (builder/validator/types +
  // portfolio/manifest/types). Mirror their runtime .js so the vc5a-acceptance
  // aggregator's `./prompt-dag/...` and `./planner/...` imports resolve at the
  // published dist/vector-cortex/ offset (tests excluded like the other subtrees).
  const nPromptDag = existsSync(join(SRC_VECTOR, "prompt-dag"))
    ? copyTree(join(SRC_VECTOR, "prompt-dag"), join(DEST_VECTOR, "prompt-dag"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  const nPlanner = existsSync(join(SRC_VECTOR, "planner"))
    ? copyTree(join(SRC_VECTOR, "planner"), join(DEST_VECTOR, "planner"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC5B added the render + provider subtrees (renderer/validator/types +
  // registry/types). Mirror their runtime .js so the vc5b-acceptance aggregator's
  // `./render/...` and `./provider/...` imports resolve at the published
  // dist/vector-cortex/ offset (tests excluded like the other subtrees).
  const nRender = existsSync(join(SRC_VECTOR, "render"))
    ? copyTree(join(SRC_VECTOR, "render"), join(DEST_VECTOR, "render"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  const nProvider = existsSync(join(SRC_VECTOR, "provider"))
    ? copyTree(join(SRC_VECTOR, "provider"), join(DEST_VECTOR, "provider"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC5C added the rollout subtree (types/assign/gate/emit). Mirror its runtime
  // .js so the vc5c-acceptance aggregator's `./rollout/...` imports resolve at the
  // published dist/vector-cortex/ offset (tests excluded like the other subtrees).
  const nRollout = existsSync(join(SRC_VECTOR, "rollout"))
    ? copyTree(join(SRC_VECTOR, "rollout"), join(DEST_VECTOR, "rollout"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC5C's live integration seam lives under dist/extensions/mega-runtime/ (tsc
  // compiles extensions/ at rootDir="."). The vc5c-acceptance aggregator imports
  // it via `../extensions/mega-runtime/vector-cortex-live.js` from the published
  // dist/vector-cortex/ offset, which resolves to dist/extensions/mega-runtime/
  // (the tsc build output). Copy it into the published dist/extensions/ mirror so
  // the aggregator's relative import resolves without a full extensions build in
  // the publish step. Its own `../../src/...` imports resolve to dist/src/... (the
  // already-mirrored subtrees + config), so the mirror is self-contained.
  const SRC_MEGA_RUNTIME = join(REPO_ROOT, "dist", "extensions", "mega-runtime");
  const DEST_MEGA_RUNTIME = join(REPO_ROOT, "dist", "extensions", "mega-runtime");
  const nLive = existsSync(join(SRC_MEGA_RUNTIME, "vector-cortex-live.js"))
    ? (mkdirSync(DEST_MEGA_RUNTIME, { recursive: true }),
      copyFileSync(
        join(SRC_MEGA_RUNTIME, "vector-cortex-live.js"),
        join(DEST_MEGA_RUNTIME, "vector-cortex-live.js"),
      ),
      1)
    : 0;
  // VC6A added the heal subtree (types/closure-opt/proof/emit). Mirror its
  // runtime .js so the vc6a-acceptance aggregator's `./heal/...` imports resolve
  // at the published dist/vector-cortex/ offset (tests excluded like the others).
  const nHeal = existsSync(join(SRC_VECTOR, "heal"))
    ? copyTree(join(SRC_VECTOR, "heal"), join(DEST_VECTOR, "heal"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC7A added the cache subtree (types/crystal/store/crystal-emit). Mirror its
  // runtime .js so the vc7a-acceptance aggregator's `./cache/...` imports resolve
  // at the published dist/vector-cortex/ offset (tests excluded like the others).
  const nCache = existsSync(join(SRC_VECTOR, "cache"))
    ? copyTree(join(SRC_VECTOR, "cache"), join(DEST_VECTOR, "cache"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC8A added the outcomes subtree (types/ledger/consent/dataset/emit). Mirror
  // its runtime .js so the vc8a-acceptance aggregator's `./outcomes/...` imports
  // resolve at the published dist/vector-cortex/ offset (tests excluded like
  // the other subtrees).
  const nOutcomes = existsSync(join(SRC_VECTOR, "outcomes"))
    ? copyTree(join(SRC_VECTOR, "outcomes"), join(DEST_VECTOR, "outcomes"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC8B added the controller subtree (types/policy/shadow/policy-emit). Mirror
  // its runtime .js so the vc8b-acceptance aggregator's `./controller/...` imports
  // resolve at the published dist/vector-cortex/ offset (tests excluded like the
  // other subtrees).
  const nController = existsSync(join(SRC_VECTOR, "controller"))
    ? copyTree(join(SRC_VECTOR, "controller"), join(DEST_VECTOR, "controller"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC8C added the platform subtree (types/select/emit/cross-read). Mirror its
  // runtime .js so the vc8c-acceptance aggregator's `./platform/...` imports
  // resolve at the published dist/vector-cortex/ offset (tests excluded like
  // the other subtrees).
  const nPlatform = existsSync(join(SRC_VECTOR, "platform"))
    ? copyTree(join(SRC_VECTOR, "platform"), join(DEST_VECTOR, "platform"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC3B support file (mode-B linear reference scan + helper producers) lives at
  // src/vector-cortex/vc3b-support.ts. Mirror its runtime .js so the
  // vc3b-acceptance aggregator's `./vc3b-support.js` import resolves at the
  // published dist/vector-cortex/ offset (test-support, not itself a test).
  const nSupport = copyTree(SRC_VECTOR, DEST_VECTOR, (name) =>
    name === "vc3b-support.js" || name === "improve.js",
  );
  // DEDUP-ATTR added the dedup-attr subtree (rollup.ts). Mirror its runtime
  // .js so the dedup-attr-acceptance aggregator's `./dedup-attr/rollup.js`
  // import resolves at the published dist/vector-cortex/ offset (tests excluded
  // like the other subtrees).
  const nDedupAttr = existsSync(join(SRC_VECTOR, "dedup-attr"))
    ? copyTree(join(SRC_VECTOR, "dedup-attr"), join(DEST_VECTOR, "dedup-attr"), (name) =>
        name.endsWith(".js") && !name.endsWith(".test.js"),
      )
    : 0;
  // VC1C MinHashV2 lives in src/dedup/. Mirror the runtime .js to dist/dedup/ so
  // the acceptance aggregator's `../dedup/l1-minhash-v2.js` import (from the
  // published dist/vector-cortex/ offset) resolves at dist/dedup/.
  if (existsSync(SRC_DEDUP)) {
    copyTree(SRC_DEDUP, DEST_DEDUP, (name) =>
      name.endsWith(".js") && !name.endsWith(".test.js"),
    );
  }
  if (existsSync(join(SRC_CONFIG, "vector-cortex.js"))) {
    mkdirSync(DEST_CONFIG, { recursive: true });
    // Mirror every vector-cortex*.js sibling so re-exports resolve at the
    // published dist/config/ offset. The config file has been split across
    // vector-cortex.ts / vector-cortex-breakers.ts / vector-cortex-flag.ts /
    // vector-cortex-early.ts; mirroring by glob is robust against further
    // splits without needing a per-file block each time.
    for (const name of readdirSync(SRC_CONFIG)) {
      if (
        name.startsWith("vector-cortex") &&
        name.endsWith(".js") &&
        !name.endsWith(".test.js")
      ) {
        copyFileSync(join(SRC_CONFIG, name), join(DEST_CONFIG, name));
      }
    }
  }
  // VC2B's encoder observers default-emit through src/log.ts (emit-vc2b.ts imports
  // `../../log.js`). The published dist/vector-cortex/ mirror runs the encoder
  // subtree at the src-stripped offset, so the loose top-level log module (and
  // its sole src dependency, config.js, which pulls only already-mirrored
  // config/vector-cortex.js + node builtins) must be mirrored to dist/log.js and
  // dist/config.js just like config/vector-cortex.js, or the default (no
  // injected emitter) reporter would fail to resolve `../../log.js` in the
  // published tree (code-review Q01).
  for (const loose of ["log.js", "config.js"]) {
    const s = join(REPO_ROOT, "dist", "src", loose);
    if (existsSync(s)) {
      copyFileSync(s, join(REPO_ROOT, "dist", loose));
    }
  }
  // ML5-B added logBenchEvent (the four `vector_cortex_encoder_bench_*` events)
  // to monitoring.ts. The ml5b-acceptance aggregator imports `../monitoring.js`
  // from the published dist/vector-cortex/ offset, so monitoring.js must be
  // mirrored to dist/monitoring.js like log.js/config.js above. Its sole runtime
  // deps are ./config.js (already mirrored) and the re-exported
  // ./vectorStore/dedup-audit.js (which imports ../monitoring.js — satisfied by
  // the same mirror), so a 2-file mirror makes the published offset self-contained.
  for (const [rel, destRel] of [
    ["monitoring.js", "monitoring.js"],
    ["vectorStore/dedup-audit.js", "vectorStore/dedup-audit.js"],
  ]) {
    const s = join(REPO_ROOT, "dist", "src", rel);
    const d = join(REPO_ROOT, "dist", destRel);
    if (existsSync(s)) {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
  // ML5-C added the runtime-select dispatch + emitRuntimeSelected seller event
  // to runtime.ts, which reads STATE_DIR_DEFAULT (config.js) for the events.log
  // state dir. No new loose-module mirror is required: config.js is already
  // mirrored above and the runtime-select.ts / runtime-emit.ts siblings land
  // under dist/vector-cortex/encoder/ by the same nEncoder copyTree pass.
  console.log(
    `vector-cortex-publish-acceptance: published ${nAccept} acceptance + ${nEval} eval + ${nReplay} replay + ${nMigrations} migrations + ${nLedger} ledger + ${nResilience} resilience + ${nConformance} conformance + ${nEncoder} encoder + ${nCortex} cortex + ${nTopology} topology + ${nShards} shards + ${nResidual} residual + ${nReconstruct} reconstruct + ${nPromptDag} prompt-dag + ${nPlanner} planner + ${nRender} render + ${nProvider} provider + ${nRollout} rollout + ${nHeal} heal + ${nCache} cache + ${nOutcomes} outcomes + ${nController} controller + ${nPlatform} platform + ${nLive} live-seam + ${nSupport} support + ${nDedupAttr} dedup-attr files`,
  );
}

main();

#!/usr/bin/env node
/**
 * ml5/promotion-gate.mjs — ML5-E / ENC-0d promotion gate.
 *
 * Evaluates the five trained heads against per-head calibration thresholds AND
 * the new asset against the committed asset on a fixed held-out dev set (never
 * training data). When `MEGACOMPACT_ENC_0D` is ON and a `{color:"green"}` real
 * candidate manifest is staged (the ENC-0c head-candidate-v1 tree under
 * `~/.pi/mega-compact-encoder/candidates/<version>/`, per-head LE float32 .bin
 * plus a digest-pinned manifest.json with `trunkDigest` pinning the ENC-0b
 * bge-small trunk), every staged byte is sha256-verified BEFORE any swap, and a
 * green candidate atomically swaps the shipped
 * `assets/vector-cortex/encoder-v1/manifest.json` to the candidate.
 *
 * - Green + digest-verified + thresholds/holdout pass → ATOMIC swap
 *   (write temp sibling in the same dir → fsync → rename over the target;
 *   never an in-place partial), append a PromotionV1 ledger row carrying
 *   {color, assetDigestStack} (stack gains the prior shipped digest first),
 *   and emit `vector_cortex_asset_promoted`.
 * - Red / threshold miss / holdout miss / any verification failure → keep the
 *   prior asset live, NO swap, NO ledger row, emit `vector_cortex_asset_demoted`
 *   with the failure code.
 * - `--rollback` (week-N+1 helper): given a previously-promoted asset that has
 *   since regressed, restore the PRIOR shipped asset from the candidate
 *   manifest's `assetDigestStack` entry by sha256 (O(1) lookup over recorded
 *   prior digests), same atomic temp-then-rename, emit
 *   `vector_cortex_asset_rollback_back`.
 *
 * `MEGACOMPACT_ENC_0D=0` (or `0`/`false`) → exit 0, no swap, no events — the
 * byte-identical ENC-0c predecessor (never even touches the shipped asset).
 * `MEGACOMPACT_ML5_E` continues to gate invocation (ML5-E seam).
 *
 * Every emitted event is one JSON line `{ts, event, code, color, digestPrefix,
 * ...}` appended to the monitoring events.log — never user bytes/message
 * content (EVAL-REDACT-002). The gate reads/writes local files only, zero
 * network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/ml5/promotion-gate.mjs [--candidate-dir <path>]
 *   node scripts/ml5/promotion-gate.mjs --rollback [--restore-digest <sha256>] [--candidate-dir <path>]
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  readdirSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");

const ENCODER_DIR = join(homedir(), ".pi", "mega-compact-encoder");
const CANDIDATES_DIR = join(ENCODER_DIR, "candidates");
const LEDGER_PATH = join(ENCODER_DIR, "promotion-ledger.json");
const CALIBRATION_PATH = join(ENCODER_DIR, "calibration.json");

// Shipped asset this gate atomically swaps (ENC-0d).
const SHIPPED_ASSET_DIR = join(ROOT, "assets", "vector-cortex", "encoder-v1");
const SHIPPED_MANIFEST = join(SHIPPED_ASSET_DIR, "manifest.json");

// Monitoring events.log — mirrors src/monitoring.ts defaultEventsPath so the
// dashboard live-stream tail and evidence tooling parse promote/demote/rollback
// events identically. State dir overridable for tests (never the extension).
const STATE_DIR = process.env.MEGACOMPACT_STATE_DIR
  || join(homedir(), ".pi", "agent", "extensions", "pi-mega-compact");
const EVENTS_LOG = join(STATE_DIR, "events.log");

// ── Flag gates ──────────────────────────────────────────────────────────────

const enc0dOff = ["0", "false"].includes(process.env.MEGACOMPACT_ENC_0D || "");
const ml5eOff = ["0", "false"].includes(process.env.MEGACOMPACT_ML5_E || "")
  || ["true", "1"].includes(process.env.MEGACOMPACT_ML5_E_DISABLED || "");
// Byte-identical predecessor: accept nothing, swap nothing, emit nothing.
if (enc0dOff || ml5eOff) {
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function digestPrefix(digest) {
  return typeof digest === "string" && digest.length > 0 ? digest.slice(0, 12) : null;
}

/** Append one structured event line to events.log (non-fatal, append-only). */
function appendEvent(fields) {
  const line = JSON.stringify({ ts: Date.now(), ...fields }) + "\n";
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(EVENTS_LOG, line, "utf8");
  } catch {
    /* never break the agent loop on a log failure */
  }
}

function readLedger() {
  if (!existsSync(LEDGER_PATH)) return { entries: [], committed: null, lastCorpusDigest: null };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return { entries: [], committed: null, lastCorpusDigest: null };
  }
}

function writeLedger(ledger) {
  mkdirSync(ENCODER_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

function readCalibration() {
  if (!existsSync(CALIBRATION_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CALIBRATION_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomic file replace: write `content` to a temp sibling in the SAME directory
 * as `target`, fsync it to disk, then rename over `target`. rename is atomic on
 * POSIX (never an in-place partial). The temp is removed on any failure so no
 * partial state ever lands at `target`.
 */
function atomicWrite(target, content) {
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  let fd = null;
  try {
    fd = openSync(tmp, "w");
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    // Never let a partial temp survive: unlink it so the target is untouched.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ── Per-head threshold check ────────────────────────────────────────────────

// Normative per-head thresholds (mirrored from src/vector-cortex/encoder/types.ts
// EVALUATION_THRESHOLDS). The gate reads calibration.json which carries the
// measured per-head scores from the latest bench run.
const HEAD_THRESHOLDS = {
  semantic: { spearman: 0.75, recallAt10: 0.9 },
  dependency: { precision: 0.97, recall: 0.95 },
  contradiction: { precision: 0.98, recall: 0.9, ece: 0.05 },
  cacheStability: { precision: 0.999, recall: 0.9 },
  payloadRouting: { macroF1: 0.97, exactAnchorRecall: 1.0 },
};

function checkHeadVerdicts(calibration) {
  if (!calibration || !calibration.heldOut) {
    // No calibration data — cannot verify; treat as all-fail (honest degradation).
    return Object.keys(HEAD_THRESHOLDS).map((h) => ({ head: h, pass: false }));
  }
  const ho = calibration.heldOut;
  const verdicts = [];
  verdicts.push({
    head: "semantic",
    pass: (ho.semantic?.spearman ?? 0) >= HEAD_THRESHOLDS.semantic.spearman
      && (ho.semantic?.recallAt10 ?? 0) >= HEAD_THRESHOLDS.semantic.recallAt10,
  });
  verdicts.push({
    head: "dependency",
    pass: (ho.dependency?.precision ?? 0) >= HEAD_THRESHOLDS.dependency.precision
      && (ho.dependency?.recall ?? 0) >= HEAD_THRESHOLDS.dependency.recall,
  });
  verdicts.push({
    head: "contradiction",
    pass: (ho.contradiction?.precision ?? 0) >= HEAD_THRESHOLDS.contradiction.precision
      && (ho.contradiction?.recall ?? 0) >= HEAD_THRESHOLDS.contradiction.recall
      && (ho.contradiction?.ece ?? 1) <= HEAD_THRESHOLDS.contradiction.ece,
  });
  verdicts.push({
    head: "cacheStability",
    pass: (ho.cacheStability?.precision ?? 0) >= HEAD_THRESHOLDS.cacheStability.precision
      && (ho.cacheStability?.recall ?? 0) >= HEAD_THRESHOLDS.cacheStability.recall,
  });
  verdicts.push({
    head: "payloadRouting",
    pass: (ho.payloadRouting?.macroF1 ?? 0) >= HEAD_THRESHOLDS.payloadRouting.macroF1
      && (ho.payloadRouting?.exactAnchorRecall ?? 0) >= HEAD_THRESHOLDS.payloadRouting.exactAnchorRecall,
  });
  return verdicts;
}

// ── Held-out dev set beat ────────────────────────────────────────────────────

function heldOutBeat(calibration, ledger) {
  // The held-out dev set comparison: does the new asset's aggregate score beat
  // the currently committed asset's score? Uses the calibration record's
  // aggregateScore field (computed from the fixed dev set, never training data).
  if (!calibration || typeof calibration.aggregateScore !== "number") return false;
  if (!ledger.committed) return true; // No incumbent → always beats.
  // Find the incumbent's score from the ledger.
  const incumbent = ledger.entries.find((e) => e.assetDigest === ledger.committed);
  if (!incumbent || typeof incumbent.aggregateScore !== "number") return true;
  return calibration.aggregateScore > incumbent.aggregateScore;
}

// ── ENC-0d: candidate resolution + digest verification ──────────────────────

const DEMOTE_CODES = {
  RED_QUALIFICATION: "ENC0D_RED_QUALIFICATION",
  HEAD_THRESHOLD: "ENC0D_HEAD_THRESHOLD",
  HELDOUT_BEAT: "ENC0D_HELDOUT_BEAT",
  DIGEST_FAIL: "ENC0D_DIGEST_FAIL",
  CANDIDATE_INVALID: "ENC0D_CANDIDATE_INVALID",
  TRUNK_MISMATCH: "ENC0D_TRUNK_MISMATCH",
  NO_CANDIDATE: "ENC0D_NO_CANDIDATE",
};

/**
 * Resolve the candidate directory. Precedence: explicit `--candidate-dir`,
 * else the newest `<version>` subdir under candidates/ with a manifest.json,
 * else the legacy flat candidates/manifest.json (ML5-E tree). Null if none.
 */
function resolveCandidateDir(argDir) {
  if (argDir) return argDir;
  if (!existsSync(CANDIDATES_DIR)) return null;
  const buildable = (sub) => existsSync(join(CANDIDATES_DIR, sub, "manifest.json"));
  const subs = readdirSync(CANDIDATES_DIR)
    .filter((s) => statSync(join(CANDIDATES_DIR, s)).isDirectory() && buildable(s))
    .sort();
  if (subs.length > 0) return join(CANDIDATES_DIR, subs[subs.length - 1]);
  if (existsSync(join(CANDIDATES_DIR, "manifest.json"))) return CANDIDATES_DIR;
  return null;
}

/**
 * A PromotionV1 row + rollback source: the stack is the LIFO of prior shipped
 * asset digests. Each entry keeps the exact manifest bytes (base64) so a
 * regressed asset is restorable byte-for-byte in O(1) by sha256. Stack entries
 * are model-artifact config, never user message content (EVAL-REDACT-002).
 */
function base64Encode(str) { return Buffer.from(str, "utf8").toString("base64"); }
function base64Decode(b64) { return Buffer.from(b64, "base64").toString("utf8"); }

/**
 * Verify EVERY staged byte before any swap:
 *  (a) the five head-weight .bin files against the candidate manifest's
 *      heads[].sha256 (and byte-count dim*4),
 *  (b) the trunk reference — the shipped model.onnx (against trunkDigest /
 *      the candidate's recorded onnx sha256) and the shipped tokenizer.json
 *      (against the candidate's recorded tokenizer sha256).
 * Any mismatch → { ok:false, code } (a demotion; NO swap).
 */
function verifyCandidate(candidateDir, manifest) {
  const trunks = {};
  if (Array.isArray(manifest?.heads)) {
    for (const h of manifest.heads) {
      const file = join(candidateDir, `${h.name}.bin`);
      if (!existsSync(file)) return { ok: false, code: DEMOTE_CODES.DIGEST_FAIL, detail: `missing head ${h.name}` };
      const bytes = readFileSync(file);
      const wantBytes = Number(h.bytes ?? 0);
      const dimBytes = Number(h.dim ?? 0) * 4;
      if (dimBytes > 0 && bytes.length !== dimBytes) {
        return { ok: false, code: DEMOTE_CODES.DIGEST_FAIL, detail: `head ${h.name} byte-count` };
      }
      if (wantBytes > 0 && bytes.length !== wantBytes) {
        return { ok: false, code: DEMOTE_CODES.DIGEST_FAIL, detail: `head ${h.name} bytes field` };
      }
      if (sha256Hex(bytes) !== h.sha256) {
        return { ok: false, code: DEMOTE_CODES.DIGEST_FAIL, detail: `head ${h.name} sha256` };
      }
    }
  } else if (!manifest?.heads) {
    return { ok: false, code: DEMOTE_CODES.CANDIDATE_INVALID, detail: "no heads list" };
  }

  // Trunk pin: the candidate pins the frozen ENC-0b bge-small trunk. Verify the
  // candidate's reference two ways: the STAGED trunk file inside the candidate
  // dir (if present — this is what ENC-PROMO-003's one-byte model.onnx mutation
  // exercises), AND consistency with the SHIPPED trunk that promotion does not
  // binary-swap (model.onnx/tokenizer.json stay put; only manifest.json swaps).
  // Any mismatch → TRUNK_MISMATCH (a demotion, NO swap).
  const onnxSha = manifest?.onnx?.sha256 || manifest?.trunkDigest;
  const tokenizerSha = manifest?.tokenizer?.sha256 || null;
  const stagedOnnx = join(candidateDir, manifest?.onnx?.path || "model.onnx");
  const stagedTok = join(candidateDir, manifest?.tokenizer?.path || "tokenizer.json");
  const shippedOnnx = join(SHIPPED_ASSET_DIR, manifest?.onnx?.path || "model.onnx");
  const shippedTok = join(SHIPPED_ASSET_DIR, manifest?.tokenizer?.path || "tokenizer.json");
  if (onnxSha) {
    if (existsSync(stagedOnnx) && sha256Hex(readFileSync(stagedOnnx)) !== onnxSha) {
      return { ok: false, code: DEMOTE_CODES.TRUNK_MISMATCH, detail: "staged onnx sha256" };
    }
    if (existsSync(shippedOnnx) && sha256Hex(readFileSync(shippedOnnx)) !== onnxSha) {
      return { ok: false, code: DEMOTE_CODES.TRUNK_MISMATCH, detail: "shipped onnx sha256" };
    }
    trunks.onnx = onnxSha;
  }
  if (tokenizerSha) {
    if (existsSync(stagedTok) && sha256Hex(readFileSync(stagedTok)) !== tokenizerSha) {
      return { ok: false, code: DEMOTE_CODES.TRUNK_MISMATCH, detail: "staged tokenizer sha256" };
    }
    if (existsSync(shippedTok) && sha256Hex(readFileSync(shippedTok)) !== tokenizerSha) {
      return { ok: false, code: DEMOTE_CODES.TRUNK_MISMATCH, detail: "shipped tokenizer sha256" };
    }
    trunks.tokenizer = tokenizerSha;
  }
  return { ok: true, trunks };
}

/**
 * O(1)-by-sha256 rollback source lookup over the candidate's assetDigestStack.
 * `restoreDigest` (opaque, never user content) selects the target; when
 * omitted, the top of the stack (the most recent prior asset) is restored.
 * Returns { ok:true, bytes } or { ok:false }.
 */
function stackLookup(manifest, restoreDigest) {
  const stack = Array.isArray(manifest?.assetDigestStack) ? manifest.assetDigestStack : [];
  if (stack.length === 0) return { ok: false };
  if (restoreDigest) {
    const entry = stack.find((e) => e?.digest === restoreDigest);
    if (!entry || typeof entry.bytes !== "string") return { ok: false };
    return { ok: true, digest: entry.digest, bytes: base64Decode(entry.bytes) };
  }
  const top = stack[stack.length - 1];
  if (!top || typeof top.bytes !== "string") return { ok: false };
  return { ok: true, digest: top.digest, bytes: base64Decode(top.bytes) };
}

// ── ENC-0d: promote / demote / rollback ─────────────────────────────────────

/** Green promote: atomic swap of the shipped manifest to the candidate. */
function doPromote(candidateDir, manifest, calibration, ledger) {
  const priorManifestBytes = existsSync(SHIPPED_MANIFEST)
    ? readFileSync(SHIPPED_MANIFEST, "utf8")
    : null;
  const priorDigest = priorManifestBytes != null ? sha256Hex(Buffer.from(priorManifestBytes, "utf8")) : null;

  // Stack gains the prior shipped digest BEFORE the swap (LIFO; entry carries the
  // exact prior bytes for byte-exact O(1) rollback).
  const stack = Array.isArray(manifest.assetDigestStack) ? [...manifest.assetDigestStack] : [];
  if (priorManifestBytes != null && priorDigest != null) {
    stack.push({ digest: priorDigest, bytes: base64Encode(priorManifestBytes) });
  }

  // Persist the updated stack onto the candidate manifest: the candidate manifest
  // is the canonical rollback source (`assetDigestStack` entry), so the SAME
  // payload that becomes the shipped manifest also carries the stack for the
  // week-N+1 rollback helper. Parse+restringify to a stable canonical JSON so
  // the swapped asset digest matches what the ledger records.
  const candObj = JSON.parse(readFileSync(join(candidateDir, "manifest.json"), "utf8"));
  candObj.assetDigestStack = stack;
  const stable = JSON.stringify(candObj);
  writeFileSync(join(candidateDir, "manifest.json"), stable, "utf8");
  const promotedDigest = sha256Hex(Buffer.from(stable, "utf8"));
  const color = manifest.color === "red" ? "red" : "green";

  // Atomic swap: temp sibling in the SAME dir, fsync, rename over the target.
  atomicWrite(SHIPPED_MANIFEST, stable);

  // Append-only ledger row (never rewrite history): PromotionV1 gains
  // {color, assetDigestStack}. Reuse the existing append-only ledger path.
  const row = {
    schema: "promotion-v1",
    ts: nowIso(),
    color,
    corpusDigest: ledger.lastCorpusDigest,
    assetDigest: promotedDigest,
    priorAssetDigest: priorDigest,
    assetDigestStack: stack,
    headVerdicts: checkHeadVerdicts(calibration),
    fiveHeadsOk: true,
    heldOutBeat: true,
    verdict: "promoted",
    demotedEvent: null,
  };
  ledger.entries.push(row);
  ledger.committed = promotedDigest;
  writeLedger(ledger);

  appendEvent({
    event: "vector_cortex_asset_promoted",
    code: "ENC0D_PROMOTE_OK",
    color,
    digestPrefix: digestPrefix(promotedDigest),
    priorDigestPrefix: digestPrefix(priorDigest),
    atomicSwap: true,
  });
  return 0;
}

/** Red / miss / verification-failure: keep prior live, no swap, no row. */
function doDemote(code, detail, color, candidateDigest) {
  appendEvent({
    event: "vector_cortex_asset_demoted",
    code,
    ...(detail ? { detail } : {}),
    color: color || null,
    digestPrefix: digestPrefix(candidateDigest),
  });
  return 0;
}

/** Week-N+1 helper: restore the prior shipped manifest O(1) by sha256. */
function doRollback(candidateDir, restoreDigest) {
  const mpath = join(candidateDir, "manifest.json");
  if (!existsSync(mpath)) {
    appendEvent({ event: "vector_cortex_asset_rollback_back", code: "ENC0D_ROLLBACK_SKIPPED", detail: "no candidate manifest", restored: false });
    return 1;
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(mpath, "utf8")); } catch {
    appendEvent({ event: "vector_cortex_asset_rollback_back", code: "ENC0D_ROLLBACK_SKIPPED", detail: "candidate manifest unparsable", restored: false });
    return 1;
  }
  const hit = stackLookup(manifest, restoreDigest);
  if (!hit.ok) {
    appendEvent({ event: "vector_cortex_asset_rollback_back", code: "ENC0D_ROLLBACK_SKIPPED", detail: "no prior stack entry", restored: false });
    return 1;
  }
  // Verify the recorded prior digest matches the bytes we are about to restore
  // (byte-for-byte evidence fidelity), then atomic temp-then-rename.
  const recorded = hit.digest;
  const actual = sha256Hex(Buffer.from(hit.bytes, "utf8"));
  if (recorded && recorded !== actual) {
    appendEvent({ event: "vector_cortex_asset_rollback_back", code: "ENC0D_ROLLBACK_SKIPPED", detail: "stack digest/bytes mismatch", restored: false });
    return 1;
  }
  atomicWrite(SHIPPED_MANIFEST, hit.bytes);
  appendEvent({
    event: "vector_cortex_asset_rollback_back",
    code: "ENC0D_ROLLBACK_OK",
    color: null,
    digestPrefix: digestPrefix(recorded),
    restored: true,
    o1Lookup: true,
  });
  return 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = { candidateDir: null, isRollback: false, restoreDigest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--candidate-dir") args.candidateDir = argv[++i] || null;
    else if (argv[i] === "--rollback") args.isRollback = true;
    else if (argv[i] === "--restore-digest") args.restoreDigest = argv[++i] || null;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = readLedger();

  if (args.isRollback) {
    const candidateDir = resolveCandidateDir(args.candidateDir);
    if (!candidateDir) {
      appendEvent({ event: "vector_cortex_asset_rollback_back", code: "ENC0D_ROLLBACK_SKIPPED", detail: "no candidate dir", restored: false });
      process.exit(1);
    }
    const code = doRollback(candidateDir, args.restoreDigest);
    process.exit(code);
  }

  const candidateDir = resolveCandidateDir(args.candidateDir);
  if (!candidateDir) {
    // No candidate → honest demotion (nothing to promote), prior asset stays live.
    process.exit(doDemote(DEMOTE_CODES.NO_CANDIDATE, "no staged candidate", null, null));
  }
  const mpath = join(candidateDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(mpath, "utf8"));
  } catch {
    process.exit(doDemote(DEMOTE_CODES.CANDIDATE_INVALID, "candidate manifest unparsable", null, null));
  }
  const candidateDigest = sha256Hex(readFileSync(mpath));
  const color = manifest?.color === "red" ? "red" : "green";

  // 1) Digest-verify every staged byte BEFORE any swap.
  const verify = verifyCandidate(candidateDir, manifest);
  if (!verify.ok) {
    process.exit(doDemote(verify.code, verify.detail, color, candidateDigest));
  }

  // 2) Existing threshold/holdout evaluation.
  const calibration = readCalibration();
  const headVerdicts = checkHeadVerdicts(calibration);
  const fiveOk = headVerdicts.every((v) => v.pass);
  const beat = heldOutBeat(calibration, ledger);

  // 3) Decision.
  if (color === "green" && fiveOk && beat) {
    const code = doPromote(candidateDir, manifest, calibration, ledger);
    process.exit(code);
  }
  const code = !fiveOk ? DEMOTE_CODES.HEAD_THRESHOLD : (!beat ? DEMOTE_CODES.HELDOUT_BEAT : DEMOTE_CODES.RED_QUALIFICATION);
  process.exit(doDemote(code, color === "red" ? "red qualification" : "green evaluated, threshold miss", color, candidateDigest));
}

main();

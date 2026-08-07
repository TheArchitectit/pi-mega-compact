/**
 * dashboard-server/setup-cortex-actions.ts — VC9B action driver (actor surface).
 *
 * Implements the actual mechanics behind POST /api/setup-cortex-action and
 * GET /api/setup-cortex-action-log: locating + spawning ONLY the committed local
 * vc2-model-prep scripts (fetch-model.sh, bench-onnx.mjs), capturing their
 * output to <stateDir>/logs/vc9b/<action>-<ts>.log, re-running the committed
 * encoder asset verification seam for verify-asset (NO subprocess), and serving
 * a bounded + redacted log tail.
 *
 * This module is the ONLY place that touches the filesystem for VC9B actions.
 * The route file (routes-setup-cortex-actions.ts) carries NO path/script/blocker
 * string literals — it delegates here. Guardrails: the spawned scripts are the
 * existing committed local developer-tooling scripts (never fetched, no network,
 * PREVENT-PI-004); the log tail is bounded at 8 KiB and redacted (digest
 * prefixes + codes only, never payload bytes — EVAL-REDACT-002); PREVENT-011
 * (no `any`).
 */

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: local subprocess spawn of committed repo script (loopback)
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SetupCortexActionKind,
  SetupCortexActionResult,
} from "./api-contracts/setup-cortex.js";
import {
  readEncoderManifest,
  verifyEncoderAsset,
  detectPlatform,
} from "../../src/vector-cortex/encoder/asset.js";
import { ENC_0G_ENABLED, ENC_0F_ENABLED } from "../../src/config.js";
import {
  readQualificationRecord,
  encoderStateDir,
} from "./qualification-record.js";

/** Cap applied to every log tail served by the action-log route. */
export const ACTION_LOG_TAIL_BYTES = 8192;

/** Locate the commit's vc2-model-prep directory by walking up to the repo root. */
function vc2ScriptDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("scripts", "vc2-model-prep");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    if (existsSync(join(candidate, "fetch-model.sh"))) return candidate;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** Absolute dir holding this repo's <stateDir>/logs/vc9b/ action logs. */
export function vc9bLogDir(stateDir: string): string {
  return join(stateDir, "logs", "vc9b");
}

/** Ensure the vc9b log dir exists and return its absolute path. */
function ensureLogDir(stateDir: string): string {
  const dir = vc9bLogDir(stateDir);
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem write (loopback)
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Safe log basename: non-empty, no separators, not a dot/double-dot segment. */
export function isSafeLogName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  // Must match our own file naming: <action>-<ts>.log where ts is digits.
  return /^[a-z-]+-\d+\.log$/.test(name);
}

/**
 * Redact a fragment of action-log output: bound long digests to their prefix and
 * collapse long base64-looking tokens, so the served tail carries digest prefixes
 * + codes only — never arbitrary payload bytes. Returns the redacted text.
 */
export function redactLog(text: string): string {
  let out = text;
  // SHA-256 (64 hex) or any long hex digest -> keep the first 12 chars.
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, (m) => `sha256:${m.slice(0, 12)}`);
  // Long base64-ish tokens (26+ chars from the base64 alphabet) -> collapse.
  out = out.replace(/[A-Za-z0-9+/=]{26,}/g, (m) => `<redacted:${m.length}>`);
  return out;
}

/** Read + bound + redact the tail of one vc9b log file. */
export function readActionLogTail(
  stateDir: string,
  name: string,
): { name: string; tail: string; complete: boolean } | null {
  if (!isSafeLogName(name)) return null;
  const dir = vc9bLogDir(stateDir);
  const full = join(dir, name);
  if (basename(full) !== name) return null; // belt-and-suspenders: no traversal
  if (!existsSync(full)) return null;
  let raw: string;
  try {
    // guardrails-allow PREVENT-PI-004: local state-dir filesystem read (loopback)
    raw = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const bounded = raw.length > ACTION_LOG_TAIL_BYTES
    ? raw.slice(-ACTION_LOG_TAIL_BYTES)
    : raw;
  return {
    name,
    tail: redactLog(bounded),
    complete: raw.length <= ACTION_LOG_TAIL_BYTES,
  };
}

/** Run a vc2-model-prep subprocess and capture its output to a vc9b log file. */
function runSpawnedAction(
  action: Extract<SetupCortexActionKind, "fetch-model" | "bench">,
  stateDir: string,
): SetupCortexActionResult {
  const dir = vc2ScriptDir();
  const { name, logPath } = writeLogName(action, stateDir);
  if (dir === null) {
    writeLog(logPath, "vc2-model-prep scripts not found in this checkout\n");
    return { action, ok: false, exitCode: null, logPath, logName: name, spawned: true };
  }
  let result;
  if (action === "fetch-model") {
    // guardrails-allow PREVENT-PI-004: local subprocess spawn of committed repo script (loopback)
    result = spawnSync("bash", [join(dir, "fetch-model.sh"), join(stateDir, "vc2-model-prep")], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } else {
    // guardrails-allow PREVENT-PI-004: local subprocess spawn of committed repo script (loopback)
    result = spawnSync(process.execPath, [join(dir, "bench-onnx.mjs")], {
      encoding: "utf8",
      timeout: 60_000,
    });
  }
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeLog(logPath, out || "(no output)\n");
  return {
    action,
    ok: result.status === 0,
    exitCode: result.status === null ? null : result.status,
    logPath,
    logName: name,
    spawned: true,
  };
}

/**
 * Re-run the committed encoder asset verification seam (readEncoderManifest +
 * verifyEncoderAsset + detectPlatform) WITHOUT any subprocess, and log a
 * redacted summary (mode + digest prefix + verdict/code only). Uses the same
 * repo-root walk the VC9A status route uses to find assets/vector-cortex.
 */
function runVerifyAsset(stateDir: string): SetupCortexActionResult {
  const { name, logPath } = writeLogName("verify-asset", stateDir);
  const body = buildVerifySummary();
  writeLog(logPath, body);
  return {
    action: "verify-asset",
    ok: body.includes("verdict=qualified"),
    exitCode: null,
    logPath,
    logName: name,
    spawned: false,
  };
}

/**
 * The ENC-0g honesty suffix for the verify-asset summary line: when both gates
 * are ON, surface the QualificationV1 record verdict so the action log is honest
 * alongside the (possibly demoted) status card. Returns "" byte-identical when
 * ENC_0G is off. Bounded + redacted (verdict + reasons only).
 */
function qualificationRecordSuffix(): string {
  if (!ENC_0G_ENABLED() || !ENC_0F_ENABLED()) return "";
  const record = readQualificationRecord(encoderStateDir());
  if (record === null) return " record_verdict=unavailable";
  return ` record_verdict=${record.verdict} record_reasons=${record.reasons.join(",")}`;
}

/** Compute the redacted verify-asset summary lines (digests + codes only). */
function buildVerifySummary(): string {
  const suffix = qualificationRecordSuffix();
  const dir = encoderAssetDir();
  if (dir === null) {
    return `mode=C verdict=unavailable reason=asset_missing${suffix}\n`;
  }
  const manifest = readEncoderManifest(dir);
  if (manifest === null) {
    return `mode=B verdict=demoted reason=ENC_MANIFEST_INVALID${suffix}\n`;
  }
  const platform = detectPlatform();
  const verify = verifyEncoderAsset(dir, manifest, platform);
  if (verify.ok) {
    const prefix = verify.onnxDigest.slice(0, 12);
    return `mode=A verdict=qualified onnx_digest_prefix=${prefix} embedded_bytes=${verify.embeddedBytes}${suffix}\n`;
  }
  return `mode=B verdict=demoted reason=${verify.code}${suffix}\n`;
}

/** Walk up to the committed encoder-v1 asset dir (mirrors routes-setup-cortex.ts). */
function encoderAssetDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("assets", "vector-cortex", "encoder-v1");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    // guardrails-allow PREVENT-PI-004: local asset filesystem read (loopback)
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

interface LogFileRef {
  name: string;
  logPath: string;
}

/** Unique <action>-<ts>.log name + absolute path under the vc9b log dir. */
function writeLogName(action: SetupCortexActionKind, stateDir: string): LogFileRef {
  let ts = Date.now();
  const existing = new Set(readdirSync(ensureLogDir(stateDir)));
  while (existing.has(`${action}-${ts}.log`)) ts++;
  const name = `${action}-${ts}.log`;
  return { name, logPath: join(vc9bLogDir(stateDir), name) };
}

function writeLog(logPath: string, body: string): void {
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem write (loopback)
  writeFileSync(logPath, body, "utf8");
}

/**
 * Run one Setup Cortex action against the given stateDir. Returns the action
 * result on success; throws nothing — every failure is surfaced as a result with
 * ok=false so the route can shape the HTTP response. Never touches the network;
 * the subprocesses it may spawn are the committed local vc2-model-prep scripts.
 */
export function runSetupCortexAction(
  action: SetupCortexActionKind,
  stateDir: string,
): SetupCortexActionResult {
  if (action === "verify-asset") return runVerifyAsset(stateDir);
  return runSpawnedAction(action, stateDir);
}

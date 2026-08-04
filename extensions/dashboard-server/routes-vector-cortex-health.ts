/**
 * dashboard-server/routes-vector-cortex-health.ts — VC0C vector-cortex breaker
 * health + reset routes (plus the VC2C encoder-health facts they surface).
 *
 *   GET  /api/vector-cortex/health          — reader-only aggregate health card
 *   POST /api/vector-cortex/breakers/reset  — explicit admin capability
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate (never payloads/prompts/ledger — EVAL-REDACT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "./routes-core.js";
import { VC0C_ENABLED, VC2C_ENABLED } from "../../src/config.js";
import { createVectorCortexSafety } from "../mega-runtime/vector-cortex-safety.js";
import { readEncoderManifest, verifyEncoderAsset, detectPlatform } from "../../src/vector-cortex/encoder/asset.js";
import { sendJson, readJsonBody } from "./routes-vector-cortex-shared.js";
import type {
  VectorCortexHealthCard,
  VectorCortexResetResult,
} from "./api-contracts/vector-cortex.js";

/** Resolve the committed encoder-v1 asset dir by walking up to the repo root. */
function encoderAssetDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("assets", "vector-cortex", "encoder-v1");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    try {
      // guardrails-allow PREVENT-PI-004: local asset filesystem read (loopback)
      readFileSync(join(candidate, "manifest.json"));
      return candidate;
    } catch {
      /* keep walking */
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/**
 * VC2C encoder health facts (task 5): the SHA-256 of the committed qualified
 * manifest (asset digest) and the encoder triad mode. Reader-only aggregate
 * (digest prefix, no bytes). Gated on MEGACOMPACT_VC2C: when the flag is OFF
 * (rollback), the card reports mode C with an absent digest — consistent with
 * the rest of the card, whose enabled/mode fields reflect active (flag-gated)
 * state. When ON: "A" when the committed asset verifies on this host, "B" when
 * present but not verified (demotion), "C" when absent.
 *
 * The verification hashes the full ONNX + tokenizer bytes, which is expensive
 * on a periodically-polled endpoint as the shipped asset grows. The result is
 * memoized against a cheap key (manifest bytes + file sizes/mtimes + platform);
 * any on-disk mutation invalidates the key, so the cache never goes stale while
 * avoiding the repeated large-file hashing. A failed digest read returns null
 * (an absent digest), never a misleading zero-sentinel.
 */
type EncoderHealthFacts = { assetDigest: string | null; mode: "A" | "B" | "C" };

interface HealthFactCache {
  key: string;
  facts: EncoderHealthFacts;
}

let healthCache: HealthFactCache | null = null;

/** Stable cache key: manifest bytes + (size,mtime) of the asset files + platform. */
function healthFactCacheKey(dir: string, manifestPath: string): string | null {
  const platform = detectPlatform();
  if (!platform) return null;
  const parts: string[] = [platform];
  try {
    for (const p of [manifestPath, join(dir, "model.onnx"), join(dir, "tokenizer.json")]) {
      const s = statSync(p);
      parts.push(`${s.size}:${s.mtimeMs}`);
    }
    // guardrails-allow PREVENT-PI-004: local manifest filesystem read (loopback)
    parts.push(createHash("sha256").update(readFileSync(manifestPath)).digest("hex"));
  } catch {
    return null;
  }
  return parts.join("|");
}

function computeEncoderHealthFacts(dir: string): EncoderHealthFacts | null {
  const manifest = readEncoderManifest(dir);
  if (manifest === null) return { assetDigest: null, mode: "C" };
  const manifestPath = join(dir, "manifest.json");
  const key = healthFactCacheKey(dir, manifestPath);
  if (key === null) return null;
  if (healthCache !== null && healthCache.key === key) return healthCache.facts;
  let digest: string;
  try {
    // guardrails-allow PREVENT-PI-004: local manifest filesystem read (loopback)
    digest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  } catch {
    return { assetDigest: null, mode: "B" };
  }
  const verify = verifyEncoderAsset(dir, manifest, detectPlatform());
  const facts: EncoderHealthFacts = { assetDigest: digest, mode: verify.ok ? "A" : "B" };
  healthCache = { key, facts };
  return facts;
}

function encoderHealthFacts(): EncoderHealthFacts {
  if (!VC2C_ENABLED()) {
    // Rollback: MEGACOMPACT_VC2C=0 selects C — report the inactive (flag-gated)
    // mode with no asset digest rather than an on-disk-computed A/B.
    return { assetDigest: null, mode: "C" };
  }
  const dir = encoderAssetDir();
  if (dir === null) return { assetDigest: null, mode: "C" };
  const facts = computeEncoderHealthFacts(dir);
  if (facts === null) return { assetDigest: null, mode: "C" };
  return facts;
}

/**
 * Reader-only GET /api/vector-cortex/health (VC0C).
 *
 * Aggregate health card: breaker state (window/probe/backoff), durable spool
 * frontier/authority/lag, and a worst-state aggregate. Constructs the safety
 * adapter over the state dir — durable spool state (frontier-frozen, lag) is
 * read from disk, so it reflects restart. Purely read: no mutation, never
 * payloads/prompts/ledger.
 */
export function handleVectorCortexHealth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/vector-cortex/health") return false;
  if (req.method !== "GET") {
    // Reader-only path: no mutation endpoint lives at /health.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC0C_ENABLED();
  const safety = enabled ? createVectorCortexSafety({ stateDir: ctx.stateDir }) : null;
  const card = safety ? safety.health() : null;

  const enc = encoderHealthFacts();

  const fallback: VectorCortexHealthCard = {
    enabled: false,
    mode: "C",
    state: "CLOSED_A",
    subsystem: "provider",
    sinceMs: 0,
    windowMs: 0,
    probeCount: 0,
    backoffDelayMs: 0,
    frontierFrozen: false,
    authorityOutage: false,
    spoolLag: 0,
    attempts: 0,
    failures: 0,
    p95Ms: 0,
    failureRate: 0,
    updatedAt: new Date().toISOString(),
    aggregate: "CLOSED_A",
    stateSource: "ephemeral",
    encoderAssetDigest: enc.assetDigest,
    encoderMode: enc.mode,
  };
  if (!card) {
    sendJson(res, 200, fallback);
    return true;
  }

  const mode: "A" | "B" | "C" =
    card.state === "CLOSED_A" ? "A" : card.state === "MANUAL_HALT" ? "C" : "B";
  const aggregate =
    card.state === "MANUAL_HALT"
      ? "MANUAL_HALT"
      : card.state === "OPEN_C"
        ? "OPEN_C"
        : card.state === "OPEN_B"
          ? "OPEN_B"
          : card.state === "PROBE_B" || card.state === "PROBE_A"
            ? "PROBE"
            : "CLOSED_A";

  const body: VectorCortexHealthCard = {
    enabled,
    mode,
    state: card.state,
    subsystem: card.subsystem,
    sinceMs: card.sinceMs,
    reason: card.reason,
    windowMs: card.windowMs,
    probeCount: card.probeCount,
    backoffDelayMs: card.backoffDelayMs,
    frontierFrozen: card.frontierFrozen,
    authorityOutage: card.authorityOutage,
    spoolLag: card.spoolLag,
    attempts: card.attempts,
    failures: card.failures,
    p95Ms: card.p95Ms,
    failureRate: card.failureRate,
    updatedAt: new Date().toISOString(),
    aggregate,
    stateSource: card.stateSource,
    encoderAssetDigest: enc.assetDigest,
    encoderMode: enc.mode,
  };
  sendJson(res, 200, body);
  return true;
}

/**
 * Admin POST /api/vector-cortex/breakers/reset (VC0C).
 *
 * Explicit admin capability (separate from the reader GET). Clears a breaker's
 * cooldown — or unwires a MANUAL_HALT — but NEVER evidence (attempts/failures
 * are retained, per TRIAD_RESILIENCE). The subsystem is actor-supplied via the
 * JSON body `{ subsystem }`. Every reset is documented in the returned record
 * (state, retained evidence, updatedAt) — an auditable mutation surface; the
 * GET path can never mutate.
 */
export function handleVectorCortexBreakersReset(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/vector-cortex/breakers/reset") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!VC0C_ENABLED()) {
    sendJson(res, 409, { error: "vco_c_disabled" });
    return true;
  }

  readJsonBody(req, (parsed) => {
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const subsystem = parsed.value.subsystem;
    if (typeof subsystem !== "string" || subsystem.length === 0) {
      sendJson(res, 400, { error: "subsystem_required" });
      return;
    }
    try {
      const safety = createVectorCortexSafety({ stateDir: ctx.stateDir });
      const rec = safety.reset(subsystem);
      const body: VectorCortexResetResult = {
        subsystem: rec.subsystem,
        state: rec.state,
        cooldownCleared: true,
        attempts: rec.attempts,
        failures: rec.failures,
        probeCount: rec.probeCount,
        manualReason: rec.manualReason,
        updatedAt: rec.updatedAt,
      };
      sendJson(res, 200, body);
    } catch {
      sendJson(res, 500, { error: "reset_failed" });
    }
  });
  return true;
}

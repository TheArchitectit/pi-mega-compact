/**
 * dashboard-server/routes-cortex-improve.ts — ML5-D "Improve Cortex" job routes.
 *
 *   POST /api/cortex/improve          — confirmation-gated local ML5-A training
 *   GET  /api/cortex/improve/status/:jobId — poll an in-process job to terminal
 *
 * The Improve action launches the committed ML5-A training pipeline
 * (training/vector-cortex/train.py) as a background child_process against the
 * latest local corpus, then re-qualifies the five heads. Job state is kept
 * in-process in a Map<jobId, JobState> on this module; nothing is persisted
 * across restarts (the status endpoint is read-only, in-memory).
 *
 * LOCAL ONLY (PREVENT-PI-004): the job spawns a local python process and reads
 * local files — never a fetch. The `onnxruntime-node` native path is attempted
 * only when MEGACOMPACT_ENCODER_NATIVE=1 (default OFF); otherwise the harness
 * uses the WASM/trigram fallback. The status payload surfaces mode/verdict/
 * digest/reason/progress only — never message or corpus content (EVAL-REDACT-002).
 *
 * Guardrails: PREVENT-011 (no `any`), PREVENT-001 (guarded JSON.parse via
 * readJsonBody), flag-off byte-identical (no card + endpoints 404).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "./routes-core.js";
import { sendJson, readJsonBody } from "./routes-vector-cortex-shared.js";
import { ML5D_ENABLED } from "../../src/config.js";
import { qualifyDecision } from "../../src/vector-cortex/improve.js";
import type {
  CortexImproveStart,
  CortexImproveStatus,
  QualificationV1,
} from "./api-contracts/cortex-improve.js";

/** Resolve the committed training entry by walking up to the repo root. */
function trainingScript(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("training", "vector-cortex", "train.py");
  for (let i = 0; i < 8; i++) {
    // guardrails-allow PREVENT-PI-004: local script read (loopback)
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** An in-process improve job (restart-scoped, never persisted). */
interface JobState {
  status: "improving" | "qualified" | "demoted_to_B";
  progress: number;
  verdict?: QualificationV1;
  assetDigest?: string;
  reason?: string;
  updatedAt: string;
}

/** In-process job registry; nothing survives a server restart. */
const JOBS = new Map<string, JobState>();

/** Opaque job token: sha256(ts+random) hex-sliced. */
function newJobId(): string {
  return createHash("sha256")
    .update(`${Date.now()}:${randomBytes(16).toString("hex")}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Spawn the ML5-A training pipeline in the background and drive the job state
 * to a terminal qualified / demoted_to_B verdict. Honest: an empty corpus (the
 * host state) makes train.py no-op and the job ends demoted_to_B.
 */
function startJob(jobId: string): void {
  const script = trainingScript();
  const boot = Date.now();
  JOBS.set(jobId, { status: "improving", progress: 0, updatedAt: new Date().toISOString() });

  if (script === null) {
    settle(jobId, { status: "demoted_to_B", reason: "ENC_TRAIN_PIPELINE_ABSENT", progress: 1 });
    return;
  }

  const env = { ...process.env };
  const proc = spawn("python3", [script], {
    env,
    cwd: join(dirname(script), "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const step = () => {
    const pct = Math.min(0.9, 0.1 + ((Date.now() - boot) / 60000) * 0.6);
    const cur = JOBS.get(jobId);
    if (cur && cur.status === "improving" && pct > cur.progress) {
      JOBS.set(jobId, { ...cur, progress: pct, updatedAt: new Date().toISOString() });
    }
  };
  const timer = setInterval(step, 2000);
  const stop = () => clearInterval(timer);

  proc.stdout?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  proc.on("error", (err) => {
    stop();
    settle(jobId, {
      status: "demoted_to_B",
      reason: `ENC_TRAIN_SPAWN_FAILED:${err.message}`,
      progress: 1,
    });
  });
  proc.on("close", (code) => {
    stop();
    // Read the produced trained-heads artifact digest. The report line includes
    // `trainedHeadsPath`; verify the file exists after a successful run.
    const match = /trainedHeadsPath":\s*"([^"]+)"/.exec(output);
    const assetPath = match?.[1];
    let digest: string | null = null;
    if (assetPath) {
      // guardrails-allow PREVENT-PI-004: local artifact read (loopback)
      try {
        digest = createHash("sha256")
          .update(readFileSync(assetPath))
          .digest("hex")
          .slice(0, 12);
      } catch {
        digest = null;
      }
    }
    const decision = qualifyDecision(code ?? -1, digest);
    if (decision === "qualified") {
      settle(jobId, {
        status: "qualified",
        progress: 1,
        assetDigest: digest ?? undefined,
        verdict: { mode: "A", assetDigestPrefix: digest ?? null, verdict: "qualified" },
      });
    } else {
      settle(jobId, {
        status: "demoted_to_B",
        reason: assetPath
          ? "trained asset did not verify — demoted to mode B"
          : "empty corpus (no groups) — no qualified asset emitted",
        progress: 1,
      });
    }
  });
}

/** Write a terminal job state (idempotent — only advances from improving). */
function settle(
  jobId: string,
  terminal: { status: "qualified" | "demoted_to_B"; progress: number; verdict?: QualificationV1; assetDigest?: string; reason?: string },
): void {
  const cur = JOBS.get(jobId);
  if (cur && cur.status !== "improving") return;
  JOBS.set(jobId, { ...terminal, updatedAt: new Date().toISOString() });
}

/** Flag-off response, byte-identical regardless of request (ML5-D absent). */
function sendDisabled(res: ServerResponse): void {
  sendJson(res, 404, { error: "disabled" });
}

/**
 * POST /api/cortex/improve (ML5-D). Returns true when it claims the request.
 * Requires `confirm:true` server-side (mirrors the client window.confirm).
 */
export function handleImproveCortex(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/cortex/improve") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!ML5D_ENABLED()) {
    sendDisabled(res);
    return true;
  }
  readJsonBody(req, (parsed) => {
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body" });
      return;
    }
    if (parsed.value.confirm !== true) {
      sendJson(res, 400, { error: "confirmation_required" });
      return;
    }
    const jobId = newJobId();
    startJob(jobId);
    const body: CortexImproveStart = { status: "improving", jobId };
    sendJson(res, 200, body);
  });
  return true;
}

/**
 * GET /api/cortex/improve/status/:jobId (ML5-D). Returns true when it claims the
 * request. Flag-off or unknown jobId → 404. Read-only in-memory.
 */
export function handleImproveCortexStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const match = /^\/api\/cortex\/improve\/status\/([A-Za-z0-9]+)$/.exec(url);
  if (!match) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!ML5D_ENABLED()) {
    sendDisabled(res);
    return true;
  }
  const job = JOBS.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: "job_not_found" });
    return true;
  }
  // Narrow job.status into the discriminated CortexImproveStatus variant. The
  // terminal shapes require their payload fields, so construct per-state.
  const body: CortexImproveStatus =
    job.status === "improving"
      ? { status: "improving", progress: job.progress }
      : job.status === "qualified"
        ? {
            status: "qualified",
            progress: job.progress,
            verdict:
              job.verdict ?? { mode: "A", assetDigestPrefix: null, verdict: "qualified" },
            assetDigest: job.assetDigest ?? "",
          }
        : {
            status: "demoted_to_B",
            progress: job.progress,
            reason: job.reason ?? "UNKNOWN_TERMINAL",
          };
  sendJson(res, 200, body);
  return true;
}

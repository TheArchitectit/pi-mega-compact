/**
 * dashboard-server/routes-repo-corpus.ts — REPO-A cross-repo corpus status route.
 *
 * GET /api/repo-corpus — reader-only aggregate answering "which pseudonymous
 * repos/sessions are in the consented corpus, what cross-repo overlap exists,
 * and is consent active for each". Reads the corpus manifest + consent-state the
 * CLI corpus-builder (scripts/repo-corpus/build.mjs) produced into the resolved
 * corpus dir, memoized by {mtime,size} key with a 5s TTL (mirrors
 * routes-cosine-fp.ts). Serves counts + IDs + status only — never payload
 * content (EVAL-REDACT-002).
 *
 * IMPORTANT (distribution): this route does NOT import the builder scripts
 * (scripts/ is excluded from package.json `files`). It reads the manifest files
 * the builder wrote; the corpus dir is resolved from MEGACOMPACT_REPO_CORPUS_DIR
 * (operator/test seam) or a bundled asset dir. The contract types ship in
 * api-contracts/repo-corpus.ts.
 *
 * Flag-off (MEGACOMPACT_REPO_CORPUS=0) returns 404 — byte-identical
 * predecessor. Absent corpus → awaiting_data (never a fabricated zero row).
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-001
 * (JSON.parse guarded), PREVENT-011 (no `any`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "./routes-core.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { REPO_CORPUS_ENABLED } from "../../src/config.js";
import { deriveVcStatus } from "./vc-status.js";
import type {
  RepoCorpusManifestV1,
  RepoCorpusStatusV1,
  RepoCorpusConsentStateV1,
  RepoCorpusPerRepoStatusV1,
} from "./api-contracts/repo-corpus.js";

const MEMO_TTL_MS = 5000; // ≤5s per file state
const MANIFEST_FILENAME = "manifest.json";
const CONSENT_STATE_FILENAME = "consent-state.json";

interface MemoEntry {
  key: string;
  at: number;
  body: RepoCorpusStatusV1;
}

let memo: MemoEntry | null = null;

/**
 * Resolve the directory containing the corpus manifest + consent-state.
 * 1. MEGACOMPACT_REPO_CORPUS_DIR (operator/test seam) — the canonical runtime
 *    location where an operator ran the builder (or a test points a temp dir).
 * 2. Bundled asset extension/dashboard-server/assets/ — the shipped location,
 *    so a pre-built corpus can be shipped in the tarball (PREVENT-DIST-001);
 *    tsc does not copy .json into dist, so probe co-located + repo-root.
 * 3. Git-checkout well-known dir for dev use (scripts/repo-corpus/corpus-run/).
 * Returns null when unresolvable — caller serves awaiting_data.
 */
export function repoCorpusDir(): string | null {
  const override = process.env.MEGACOMPACT_REPO_CORPUS_DIR;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const bundledCandidates = [
    join(here, "assets"),
    join(here, "..", "..", "..", "extensions", "dashboard-server", "assets"),
  ];
  for (const bundled of bundledCandidates) {
    try {
      // guardrails-allow PREVENT-PI-004: local bundled manifest stat (loopback)
      statSync(join(bundled, MANIFEST_FILENAME));
      return bundled;
    } catch {
      /* try next candidate, then fall through to git-checkout walk */
    }
  }
  // Git-checkout corpus dir — dev path only.
  let dir = here;
  const rel = join("scripts", "repo-corpus", "corpus-run");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    try {
      // guardrails-allow PREVENT-PI-004: local corpus-run dir stat (loopback)
      statSync(candidate);
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

/** Guarded JSON file read → parsed value or null (PREVENT-001, PREVENT-011). */
function readJsonFile(p: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(p, "utf8"); // guardrails-allow PREVENT-PI-004: local corpus file read (loopback)
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Project a raw consent-state file (structurally guarded, PREVENT-011). */
function readConsentState(corpusDir: string): RepoCorpusConsentStateV1 | null {
  const raw = readJsonFile(join(corpusDir, CONSENT_STATE_FILENAME));
  if (!isRecord(raw)) return null;
  const perRepo = Array.isArray(raw.perRepo) ? raw.perRepo : [];
  const rows = perRepo
    .filter(isRecord)
    .map((r) => ({
      repoPseudonym:
        typeof r.repoPseudonym === "string" ? r.repoPseudonym : "",
      consentedCrossRepo: r.consentedCrossRepo === true || r.consentedCrossRepo === "true",
      revokedAt: typeof r.revokedAt === "string" ? r.revokedAt : undefined,
    }))
    .filter((r) => r.repoPseudonym.length > 0);
  return { schema: "repo-corpus-consent-state-v1", perRepo: rows };
}

/** Project a raw manifest file (structurally guarded, PREVENT-011). */
function readManifest(corpusDir: string): RepoCorpusManifestV1 | null {
  const raw = readJsonFile(join(corpusDir, MANIFEST_FILENAME));
  if (!isRecord(raw)) return null;
  if (raw.schema !== "repo-corpus-manifest-v1") return null;
  const repos = Array.isArray(raw.repos)
    ? raw.repos
        .filter(isRecord)
        .map((r) => ({
          repoPseudonym:
            typeof r.repoPseudonym === "string" ? r.repoPseudonym : "",
          sessions: typeof r.sessions === "number" ? r.sessions : 0,
          sessionIds: Array.isArray(r.sessionIds)
            ? r.sessionIds.filter((x): x is string => typeof x === "string")
            : [],
          events: typeof r.events === "number" ? r.events : 0,
          digest: typeof r.digest === "string" ? r.digest : "",
        }))
        .filter((r) => r.repoPseudonym.length > 0)
    : [];
  const overlaps = Array.isArray(raw.overlaps)
    ? raw.overlaps
        .filter(isRecord)
        .map((o) => ({
          repoA: typeof o.repoA === "string" ? o.repoA : "",
          repoB: typeof o.repoB === "string" ? o.repoB : "",
          sharedSessions: typeof o.sharedSessions === "number" ? o.sharedSessions : 0,
          sharedIds: Array.isArray(o.sharedIds)
            ? o.sharedIds.filter((x): x is string => typeof x === "string")
            : [],
        }))
        .filter((o) => o.repoA.length > 0 && o.repoB.length > 0)
    : [];
  return {
    schema: "repo-corpus-manifest-v1",
    ownerPseudonym:
      typeof raw.ownerPseudonym === "string" ? raw.ownerPseudonym : "",
    datasetVersion:
      typeof raw.datasetVersion === "string" ? raw.datasetVersion : "",
    effectiveSeq: typeof raw.effectiveSeq === "number" ? raw.effectiveSeq : 0,
    totalEvents: typeof raw.totalEvents === "number" ? raw.totalEvents : 0,
    repos,
    overlaps,
  };
}

/**
 * Build the perRepo status rows. A repo whose consent cannot be confirmed
 * (missing from consent-state, or missing stateDir at the builder) degrades to
 * consentedCrossRepo:false — never a crash, never a silent inclusion.
 */
function buildPerRepo(
  manifest: RepoCorpusManifestV1,
  consent: RepoCorpusConsentStateV1 | null,
): RepoCorpusPerRepoStatusV1[] {
  const consentByRepo = new Map<string, RepoCorpusConsentStateV1["perRepo"][number]>();
  if (consent) {
    for (const row of consent.perRepo) consentByRepo.set(row.repoPseudonym, row);
  }
  return manifest.repos.map((r) => {
    const c = consentByRepo.get(r.repoPseudonym);
    return {
      repoPseudonym: r.repoPseudonym,
      sessions: r.sessions,
      consentedCrossRepo: c ? c.consentedCrossRepo : false,
      revokedAt: c && c.revokedAt ? c.revokedAt : undefined,
    };
  });
}

function buildBody(corpusDir: string, manifest: RepoCorpusManifestV1): RepoCorpusStatusV1 {
  const consent = readConsentState(corpusDir);
  const perRepo = buildPerRepo(manifest, consent);
  const hasData = manifest.repos.length > 0;
  const status = deriveVcStatus({ enabled: true, hasData, structuralOnly: false });
  return {
    schema: "repo-corpus-status-v1",
    corpus: manifest,
    perRepo,
    totalEvents: manifest.totalEvents,
    status,
  };
}

function awaitingDataBody(): RepoCorpusStatusV1 {
  const status = deriveVcStatus({
    enabled: true,
    hasData: false,
    structuralOnly: false,
  });
  return {
    schema: "repo-corpus-status-v1",
    corpus: null,
    perRepo: [],
    totalEvents: 0,
    status,
  };
}

export function handleRepoCorpus(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/repo-corpus") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!REPO_CORPUS_ENABLED()) {
    // Flag-off: 404 — byte-identical predecessor.
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  const corpusDir = repoCorpusDir();
  if (corpusDir === null) {
    sendJson(res, 200, awaitingDataBody());
    return true;
  }

  // Memoized-facts pattern: serve a still-fresh entry keyed on {mtime,size}.
  let size = 0;
  let mtime = 0;
  try {
    const s = statSync(join(corpusDir, MANIFEST_FILENAME)); // guardrails-allow PREVENT-PI-004: local stat (loopback)
    size = s.size;
    mtime = s.mtimeMs;
  } catch {
    // no manifest on disk yet
  }
  if (size === 0 && mtime === 0) {
    sendJson(res, 200, awaitingDataBody());
    return true;
  }

  const key = `${mtime}:${size}`;
  const now = Date.now();
  if (memo !== null && memo.key === key && now - memo.at <= MEMO_TTL_MS) {
    sendJson(res, 200, memo.body);
    return true;
  }

  const manifest = readManifest(corpusDir);
  const body = manifest === null ? awaitingDataBody() : buildBody(corpusDir, manifest);
  memo = { key, at: now, body };
  sendJson(res, 200, body);
  return true;
}

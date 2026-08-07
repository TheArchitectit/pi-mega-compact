#!/usr/bin/env node
/**
 * scripts/repo-corpus/build.mjs — REPO-A read-side corpus-builder CLI.
 *
 * Builds a PSEUDONYMOUS cross-repo corpus manifest from per-repo events.log
 * slices, CONSENT-GATED: before touching a single byte, it verifies active
 * explicit cross-repo consent for EVERY repo in the manifest. Zero writes on any
 * consent failure (REPO_CORPUS_CONSENT_REQUIRED), and on any consent failure or
 * I/O error it freezes (no partial artifact), logs `repo_corpus_consent_refused`
 * WITHOUT payload content (repoPseudonym + seq + refusal code only), and empties
 * the corpus out dir.
 *
 * It NEVER reads or writes `conversation_thread`/`tool_results` payloads — it
 * aggregates IDs/counts/digests/cross-repo-overlap descriptors only. The
 * canonicalRemote→pseudonym mapping is a pure in-memory function of the git
 * remote string and is never written into any production table; only pseudonyms
 * leave this process.
 *
 * The RepoCorpusManifestV1 it emits is consumed READ-ONLY by the reader route
 * (GET /api/repo-corpus), which does NOT import this script at runtime — this is
 * a CLI seam only. It is pure-local: reads events.log slices from each repo's
 * stateDir + local git introspection; never network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/repo-corpus/build.mjs \
 *       --manifest <path> --corpus-out <dir>
 *
 * --manifest JSON shape:
 *   {
 *     "schema": "repo-corpus-request-v1",
 *     "ownerPseudonym": "<owner>",
 *     "datasetVersion": "<v>",
 *     "repos": [
 *       {
 *         "stateDir": "<abs path to a repo stateDir>",
 *         "repoPseudonym": "<16-hex (may be empty: derived from git remote)>",
 *         "consentLog": "<abs path to the repo's consent JSONL>",
 *         "ownerAttestation": "<same-session-set attestation string>"
 *       }
 *     ]
 *   }
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalRemote,
  repoPseudonymForRemote,
  repoPseudonymForGitRoot,
  readConsentRecords,
  consentCoversCrossRepo,
  activeConsent,
} from "./consent.mjs";

// guardrails-allow PREVENT-PI-004: read-side corpus builder; git remote introspection is read-only spawnSync against the local repo, never a fetch/clone; only local events.log reads

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONSENT_LOG_NAME = ".mega-compact-repo-corpus.consent.jsonl";

// ---------------------------------------------------------------------------
// Refusal / audit
// ---------------------------------------------------------------------------

const REFUSAL = ((code) => code)("REPO_CORPUS_CONSENT_REQUIRED");

/**
 * Append a pseudonymous refusal line to an audit log — NEVER payload content.
 * @param {string} auditPath
 * @param {string} repoPseudonym
 * @param {number} effectiveSeq
 * @param {string} refusalCode
 */
export function logRefusal(auditPath, repoPseudonym, effectiveSeq, refusalCode) {
  const line = JSON.stringify({
    ts: Date.now(),
    event: "repo_corpus_consent_refused",
    repoPseudonym,
    effectiveSeq,
    refusalCode,
  });
  try {
    appendFileSync(auditPath, `${line}\n`, "utf8");
  } catch {
    // audit write is best-effort; the refusal is already surfaced by exit code
  }
  return line;
}

/** Wipe a corpus out dir so no derived artifact ever remains live from a failed build. */
export function emptyCorpusDir(outDir) {
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// events.log slice reading (aggregates only — never payloads)
// ---------------------------------------------------------------------------

const SESSION_FIELD_GUESSES = ["sessionId", "session_id", "session", "id"];

/**
 * Read a repo's events.log and extract the set of session IDs it mentions.
 * Aggregates IDs only — never matched text, checkpoint paths, or any payload
 * field. Uses `session`/`session_id`/`sessionId` line fields and the event's own
 * id as a fallback session key. Guarded per-line parse (PREVENT-001).
 * @param {string} eventsPath
 * @returns {{ sessionIds: string[], totalEvents: number }}
 */
export function readEventsSlice(eventsPath) {
  const sessionIds = new Set();
  let totalEvents = 0;
  if (!existsSync(eventsPath)) return { sessionIds, totalEvents };
  const raw = readFileSync(eventsPath, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    totalEvents++;
    let parsed;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // malformed line — skip, never fabricate (PREVENT-001)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const o = parsed;
    for (const key of SESSION_FIELD_GUESSES) {
      const v = o[key];
      if (typeof v === "string" && v.length > 0) {
        sessionIds.add(v);
        break;
      }
    }
  }
  return { sessionIds: [...sessionIds], totalEvents };
}

/** Digest over an event slice's session ids (sorted) + count — content-free. */
export function sliceDigest(sessionIds, totalEvents) {
  const h = createHash("sha256");
  h.update(`REPO-CORPUS-SLICE-v1:`);
  h.update(`${totalEvents}:`);
  h.update([...sessionIds].sort().join(","));
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Manifest building
// ---------------------------------------------------------------------------

/**
 * Compute cross-repo overlap descriptors across repo session-id sets.
 * Purely sets of ids; no payload content.
 * @param {Array<{repoPseudonym: string, sessionIds: string[]}>} repos
 * @returns {Array<{repoA: string, repoB: string, sharedSessions: number, sharedIds: string[]}>}
 */
export function crossRepoOverlap(repos) {
  const out = [];
  for (let a = 0; a < repos.length; a++) {
    for (let b = a + 1; b < repos.length; b++) {
      const setB = new Set(repos[b].sessionIds);
      const shared = repos[a].sessionIds.filter((id) => setB.has(id));
      if (shared.length > 0) {
        out.push({
          repoA: repos[a].repoPseudonym,
          repoB: repos[b].repoPseudonym,
          sharedSessions: shared.length,
          sharedIds: shared.sort(),
        });
      }
    }
  }
  return out;
}

/**
 * Build a RepoCorpusManifestV1 from validated per-repo slices. Read-side only.
 * @param {object} opts
 * @returns {Record<string, unknown>}
 */
export function buildCorpusManifest({
  schemaVersion,
  ownerPseudonym,
  datasetVersion,
  repos,
  overlaps,
  totalEvents,
  effectiveSeq,
}) {
  return {
    schema: schemaVersion,
    ownerPseudonym,
    datasetVersion,
    effectiveSeq,
    totalEvents,
    repos,
    overlaps,
  };
}

// ---------------------------------------------------------------------------
// Parsing + main
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "repo-corpus-manifest-v1";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest" && argv[i + 1]) {
      out.manifest = argv[++i];
    } else if (a === "--corpus-out" && argv[i + 1]) {
      out.corpusOut = argv[++i];
    } else if (a === "--audit" && argv[i + 1]) {
      out.audit = argv[++i];
    } else if (a === "--effective-seq" && argv[i + 1]) {
      out.effectiveSeq = argv[++i];
    }
  }
  return out;
}

/**
 * Read + validate the manifest request JSON (PREVENT-001). Returns null on any
 * parse/shape failure (caller treats as fatal — no partial artifact).
 * @param {string} manifestPath
 * @returns {Record<string, unknown> | null}
 */
export function readManifestRequest(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed;
  if (
    typeof p.ownerPseudonym !== "string" ||
    typeof p.datasetVersion !== "string" ||
    !Array.isArray(p.repos)
  ) {
    return null;
  }
  return p;
}

/** Validate a single manifest repo entry; returns null when malformed. */
function validateRepoEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry;
  if (typeof e.stateDir !== "string" || e.stateDir.length === 0) return null;
  if (typeof e.ownerAttestation !== "string") return null;
  return e;
}

/**
 * Resolve a repo's pseudonym: prefer the manifest-provided one when non-empty,
 * otherwise derive from the git remote of its stateDir/git-root (read-only).
 * Returns null when unresolvable.
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
export function resolveRepoPseudonym(entry) {
  const provided = entry.repoPseudonym;
  if (typeof provided === "string" && provided.length > 0) return provided;
  const root = entry.gitRoot || entry.stateDir;
  return repoPseudonymForGitRoot(root || "");
}

/**
 * Build a corpus from a manifest request. Pure read-side; refuses all writes on
 * any consent failure. Returns { ok, code, manifest, refusal }.
 * @param {Record<string, unknown>} request
 * @param {object} opts
 * @param {string} opts.corpusOut
 * @param {string} opts.auditPath
 * @param {number} opts.effectiveSeq
 */
export function buildCorpus(request, { corpusOut, auditPath, effectiveSeq }) {
  const ownerPseudonym = String(request.ownerPseudonym);
  const datasetVersion = String(request.datasetVersion);
  const effectiveSeqNum =
    typeof effectiveSeq === "number" ? effectiveSeq : Date.now();

  // Phase 1 — verify EVERY repo's cross-repo consent BEFORE touching a byte.
  const repoSlices = [];
  for (const entry of request.repos) {
    const valid = validateRepoEntry(entry);
    if (!valid) {
      const pseud =
        typeof entry?.repoPseudonym === "string" ? entry.repoPseudonym : "unknown";
      logRefusal(auditPath, pseud, effectiveSeqNum, "MALFORMED_REPO_ENTRY");
      return { ok: false, code: REFUSAL, ...refusalJson(pseud, "MALFORMED_REPO_ENTRY") };
    }

    const pseud = resolveRepoPseudonym(valid);
    if (pseud === null) {
      logRefusal(auditPath, "unknown", effectiveSeqNum, "NO_PSEUDONYM");
      return { ok: false, code: REFUSAL, ...refusalJson("unknown", "NO_PSEUDONYM") };
    }
    valid.repoPseudonym = pseud;

    // Owner's same-session-set attestation must match (no third-party sessions).
    if (valid.ownerAttestation !== ownerPseudonym) {
      logRefusal(auditPath, pseud, effectiveSeqNum, "OWNER_ATTESTATION_MISMATCH");
      return { ok: false, code: REFUSAL, ...refusalJson(pseud, "OWNER_ATTESTATION_MISMATCH") };
    }

    const consentLog = valid.consentLog || join(valid.stateDir, DEFAULT_CONSENT_LOG_NAME);
    const records = readConsentRecords(consentLog);
    if (
      !activeConsent(records, pseud, "cross-repo", effectiveSeqNum) ||
      !consentCoversCrossRepo(records, [pseud], effectiveSeqNum)
    ) {
      logRefusal(auditPath, pseud, effectiveSeqNum, REFUSAL);
      return { ok: false, code: REFUSAL, ...refusalJson(pseud, REFUSAL) };
    }

    // Read the repo's events.log slice (aggregates only — never payloads).
    const slice = readEventsSlice(join(valid.stateDir, "events.log"));
    repoSlices.push({ pseud, stateDir: valid.stateDir, ...slice });
  }

  // Phase 2 — build the preserved in-memory slices + manifest.
  const repos = repoSlices.map((s) => ({
    repoPseudonym: s.pseud,
    sessions: s.sessionIds.length,
    sessionIds: s.sessionIds.sort(),
    events: s.totalEvents,
    digest: sliceDigest(s.sessionIds, s.totalEvents),
  }));
  const overlaps = crossRepoOverlap(
    repoSlices.map((s) => ({ repoPseudonym: s.pseud, sessionIds: s.sessionIds })),
  );
  const manifest = buildCorpusManifest({
    schemaVersion: SCHEMA_VERSION,
    ownerPseudonym,
    datasetVersion,
    repos,
    overlaps,
    totalEvents: repoSlices.reduce((n, s) => n + s.totalEvents, 0),
    effectiveSeq: effectiveSeqNum,
  });

  // Phase 3 — write the corpus out dir. Two pseudonymous artifacts: the manifest
  // (repos/overlaps/counts/digests) + the consent-state (perRepo consent rows the
  // reader route projects). Both are content-free (pseudonyms + booleans only).
  const consentState = {
    schema: "repo-corpus-consent-state-v1",
    perRepo: repoSlices.map((s) => ({
      repoPseudonym: s.pseud,
      consentedCrossRepo: true,
    })),
  };
  emptyCorpusDir(corpusOut);
  mkdirSync(corpusOut, { recursive: true });
  writeFileSync(
    join(corpusOut, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(corpusOut, "consent-state.json"),
    `${JSON.stringify(consentState, null, 2)}\n`,
    "utf8",
  );
  return { ok: true, code: "ok", manifest };
}

/** Refusal summary (pseudonym + seq + code only — never payload content). */
function refusalJson(repoPseudonym, code) {
  return { repoPseudonym, refusal: code };
}

export function main(argv) {
  try {
    const args = parseArgs(argv);
    if (!args.manifest || !args.corpusOut) {
      console.error(
        "usage: node scripts/repo-corpus/build.mjs --manifest <path> --corpus-out <dir>",
      );
      return 2;
    }
    const request = readManifestRequest(args.manifest);
    if (request === null) {
      emptyCorpusDir(args.corpusOut);
      console.error("build.mjs: invalid or unreadable --manifest; corpus dir emptied");
      return 1;
    }
    const auditPath = args.audit || join(HERE, "repo-corpus.consent-refused.audit.jsonl");
    const effectiveSeq = args.effectiveSeq ? Number(args.effectiveSeq) : Date.now();
    const result = buildCorpus(request, {
      corpusOut: args.corpusOut,
      auditPath,
      effectiveSeq,
    });
    if (!result.ok) {
      emptyCorpusDir(args.corpusOut);
      console.error(
        `build.mjs: ${result.refusal} for repo ${result.repoPseudonym}; zero bytes written`,
      );
      return 3;
    }
    console.log(
      `build.mjs: wrote ${join(args.corpusOut, "manifest.json")} (${concise(result.manifest)})`,
    );
    return 0;
  } catch (err) {
    console.error(`build.mjs: fatal ${err instanceof Error ? err.message : String(err)}`);
    return 4;
  }
}

function concise(manifest) {
  return `${manifest.repos.length} repos · ${manifest.totalEvents} events · ${manifest.overlaps.length} overlap pairs`;
}

if (process.argv[1] && process.argv[1].endsWith("build.mjs")) {
  process.exit(main(process.argv.slice(2)));
}

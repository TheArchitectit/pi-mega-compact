#!/usr/bin/env node
/**
 * scripts/repo-corpus/consent.mjs — REPO-A append-only consent record helpers.
 *
 * The consent engine shared by the corpus-builder (build.mjs), the reader route
 * (via the corpus manifest + consent audit log), and the consent tests. Consent
 * is STRICT-APPEND ONLY (SECURITY_PRIVACY.md §Lifecycle): records are appended,
 * never mutated, never UPDATE'd. `revoke` subordinates a prior `grant` for the
 * same scope from its effectiveSeq onward — an instant freeze of that scope.
 *
 * Repo pseudonyms are hash-of-canonical-remote: `repoPseudonym =
 * sha256("REPO-CORPUS-v1:" + canonicalRemote)[0..16 hex]`. The canonical remote
 * is resolved from the repo's git root via `git remote get-url origin` (local,
 * read-only spawnSync). The canonicalRemote→pseudonym mapping is a PURE function
 * of the remote string and is NEVER persisted back into any production table;
 * only the pseudonym ever leaves this process.
 *
 * No third-party sessions: a `scope:"cross-repo"` record requires the owner's
 * SAME session set (the owner pseudonym is carried on every record, and the
 * builder only admits sessions whose owner matches the corpus owner).
 *
 * CLI (append-only; the only way consent is granted/revoked — the dashboard card
 * is reader-only by design):
 *   node scripts/repo-corpus/consent.mjs append --repo-git-root <dir> \
 *       --owner <ownerPseudonym> --scope single-repo|cross-repo \
 *       --purpose <purpose> --dataset-version <v> [--action revoke] [--out <log>]
 *   node scripts/repo-corpus/consent.mjs resolve --repo-git-root <dir> [--seq N]
 *
 * This file does NOT ship in the npm tarball (scripts/ is excluded from
 * package.json `files`). It is a CLI/ops-only tool; nothing under extensions/ or
 * src/ imports it at runtime (PREVENT-PI-004).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// guardrails-allow PREVENT-PI-004: local-only consent helpers; git remote introspection is read-only spawnSync against the local repo, never a fetch/clone

// ---------------------------------------------------------------------------
// Pseudonym derivation (pure, read-only)
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical remote of a git-root from its git config (local,
 * read-only). Returns null when the repo has no origin remote (callers treat a
 * missing remote as "no pseudonym resolvable" — degrade, and the builder refuses
 * absent cross-repo consent).
 * @param {string} gitRoot
 * @returns {string | null}
 */
export function canonicalRemote(gitRoot) {
  if (!gitRoot || typeof gitRoot !== "string") return null;
  const res = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0 || !res.stdout) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

/**
 * sha256("REPO-CORPUS-v1:" + canonicalRemote)[0..16 hex]. Deterministic pure
 * function of the remote string. Never persisted back into production tables.
 * @param {string} remote
 * @returns {string} 16-hex pseudonym
 */
export function repoPseudonymForRemote(remote) {
  const digest = createHash("sha256")
    .update(`REPO-CORPUS-v1:${String(remote)}`, "utf8")
    .digest("hex");
  return digest.slice(0, 16);
}

/**
 * Resolve a repo's pseudonym from its git root, or null when no origin remote.
 * @param {string} gitRoot
 * @returns {string | null}
 */
export function repoPseudonymForGitRoot(gitRoot) {
  const remote = canonicalRemote(gitRoot);
  return remote === null ? null : repoPseudonymForRemote(remote);
}

// ---------------------------------------------------------------------------
// Record classification
// ---------------------------------------------------------------------------

const REPO_CORPUS_POLICY_VERSION = "1";

/**
 * Build a consent record object. Does not persist; callers append it.
 * @param {object} arg
 * @param {string} arg.ownerPseudonym
 * @param {string} arg.repoPseudonym
 * @param {"single-repo"|"cross-repo"} arg.scope
 * @param {string} arg.purpose
 * @param {string} arg.datasetVersion
 * @param {string} arg.sourceEventId
 * @param {"grant"|"revoke"} [arg.action]
 * @param {number} [arg.ts]
 * @param {string} [arg.policyVersion]
 * @param {number} [arg.effectiveSeq]
 * @returns {Record<string, unknown>}
 */
export function makeConsentRecord({
  ownerPseudonym,
  repoPseudonym,
  scope,
  purpose,
  datasetVersion,
  sourceEventId,
  action = "grant",
  ts,
  policyVersion = REPO_CORPUS_POLICY_VERSION,
  effectiveSeq,
}) {
  if (!["single-repo", "cross-repo"].includes(scope)) {
    throw new Error(`invalid scope: ${scope}`);
  }
  if (!["grant", "revoke"].includes(action)) {
    throw new Error(`invalid action: ${action}`);
  }
  return {
    consentId: sourceEventId, // unique per event; the latest action per consentId wins
    ownerPseudonym,
    repoPseudonym,
    scope,
    purpose,
    datasetVersion,
    ts: typeof ts === "number" ? ts : Date.now(),
    policyVersion,
    action,
    sourceEventId,
    effectiveSeq:
      typeof effectiveSeq === "number" ? effectiveSeq : Math.floor(Date.now()),
  };
}

/**
 * Append one consent record to a JSONL log. Strict-append: appends a line; never
 * mutates an existing line (no UPDATE — §Lifecycle). Returns the record written.
 * @param {string} logPath  JSONL consent audit log path
 * @param {object} record
 * @returns {Record<string, unknown>}
 */
export function appendConsentRecord(logPath, record) {
  return appendConsentRecords(logPath, [record])[0];
}

/**
 * Append one or more consent records to a JSONL log (atomic per file append).
 * @param {string} logPath
 * @param {Array<Record<string, unknown>>} records
 * @returns {Array<Record<string, unknown>>}
 */
export function appendConsentRecords(logPath, records) {
  for (const r of records) {
    appendFileSync(logPath, `${JSON.stringify(r)}\n`, "utf8");
  }
  return records;
}

/**
 * Read all consent records from a JSONL log (guard PREVENT-001 on each line).
 * @param {string} logPath
 * @returns {Array<Record<string, unknown>>}
 */
export function readConsentRecords(logPath) {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // skip malformed line; never fabricate (PREVENT-001)
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      out.push(parsed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effective-state resolver (pure)
// ---------------------------------------------------------------------------

/**
 * The effective action for a (consentId) as of an effectiveSeq. The latest
 * record (by effectiveSeq, then insertion order) for that consentId wins. A
 * `revoke` for the same scope SUBORDINATES a prior `grant` from that seq onward
 * — instant freeze.
 * @param {Array<Record<string, unknown>>} records
 * @param {string} repoPseudonym
 * @param {string} scope
 * @param {number} effectiveSeq
 * @returns {{ action: "grant"|"revoke"|"absent", revokedAtSeq: number | null }}
 */
export function effectiveConsent(records, repoPseudonym, scope, effectiveSeq) {
  const relevant = records
    .filter(
      (r) =>
        r &&
        typeof r === "object" &&
        r.repoPseudonym === repoPseudonym &&
        r.scope === scope &&
        typeof r.effectiveSeq === "number" &&
        r.effectiveSeq <= effectiveSeq,
    )
    .sort(
      (a, b) =>
        Number(a.effectiveSeq) - Number(b.effectiveSeq) ||
        Number(a.ts) - Number(b.ts),
    );
  if (relevant.length === 0) {
    return { action: "absent", revokedAtSeq: null };
  }
  const last = relevant[relevant.length - 1];
  return {
    action: last.action === "revoke" ? "revoke" : "grant",
    revokedAtSeq:
      last.action === "revoke" ? Number(last.effectiveSeq) : null,
  };
}

/**
 * Whether the repo has ACTIVE consent for a scope as of effectiveSeq.
 * @param {Array<Record<string, unknown>>} records
 * @param {string} repoPseudonym
 * @param {string} scope
 * @param {number} effectiveSeq
 * @returns {boolean}
 */
export function activeConsent(records, repoPseudonym, scope, effectiveSeq) {
  return (
    effectiveConsent(records, repoPseudonym, scope, effectiveSeq).action ===
    "grant"
  );
}

/**
 * Whether every repo in the set has ACTIVE cross-repo consent as of the seq.
 * @param {Array<Record<string, unknown>>} records
 * @param {string[]} repoPseudonyms
 * @param {number} effectiveSeq
 * @returns {boolean}
 */
export function consentCoversCrossRepo(records, repoPseudonyms, effectiveSeq) {
  for (const pseud of repoPseudonyms) {
    if (!activeConsent(records, pseud, "cross-repo", effectiveSeq)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `consent.mjs — REPO-A append-only consent ledger (CLI/ops-only)

Usage:
  consent.mjs append --repo-git-root <dir> --owner <ownerPseudonym>
      --scope single-repo|cross-repo --purpose <purpose>
      --dataset-version <v> [--action grant|revoke] [--audit <log>]
      [--seat <ownerPseudonym>] [--effective-seq <n>]
  consent.mjs resolve --repo-git-root <dir> [--seq <n>]

append: writes ONE consent record (JSONL) to --audit (default:
  <repo-git-root>/.mega-compact-repo-corpus.consent.jsonl). Strict-append only.
resolve: prints effective consent for the repo's OWN cross-repo scope.

The dashboard card is reader-only; grants/revokes happen HERE (ops-only).
`;

function die(msg) {
  console.error(`consent.mjs: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val === undefined || val.startsWith("--") ? true : val;
      if (typeof out[key] === "string") i++;
    }
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (cmd !== "append" && cmd !== "resolve") {
    console.error(USAGE);
    return 2;
  }
  const gitRoot = args["repo-git-root"];
  if (!gitRoot) die("--repo-git-root is required");

  const pseud = repoPseudonymForGitRoot(gitRoot);

  if (cmd === "append") {
    const scope = args.scope;
    const purpose = args.purpose;
    const datasetVersion = args["dataset-version"];
    const owner = args.owner;
    if (!["single-repo", "cross-repo"].includes(scope)) die("invalid --scope");
    if (!purpose || !datasetVersion || !owner) {
      die("--owner / --purpose / --dataset-version are required to append");
    }
    if (pseud === null) die("no origin remote — cannot derive a repo pseudonym");
    const audit = args.audit || join(gitRoot, ".mega-compact-repo-corpus.consent.jsonl");
    const rec = makeConsentRecord({
      ownerPseudonym: owner,
      repoPseudonym: pseud,
      scope,
      purpose,
      datasetVersion,
      sourceEventId: args["source-event-id"] || `consent-${Date.now()}`,
      action: args.action === "revoke" ? "revoke" : "grant",
      effectiveSeq: args["effective-seq"]
        ? Number(args["effective-seq"])
        : Date.now(),
    });
    appendConsentRecord(audit, rec);
    console.log(
      JSON.stringify({ ok: true, repoPseudonym: pseud, action: rec.action, scope }),
    );
    return 0;
  }

  // resolve
  const seq = args.seq ? Number(args.seq) : Date.now();
  if (pseud === null) {
    console.log(JSON.stringify({ ok: true, repoPseudonym: null, action: "absent" }));
    return 0;
  }
  const audit = args.audit || join(gitRoot, ".mega-compact-repo-corpus.consent.jsonl");
  const records = readConsentRecords(audit);
  const eff = effectiveConsent(records, pseud, "cross-repo", seq);
  console.log(
    JSON.stringify({
      ok: true,
      repoPseudonym: pseud,
      action: eff.action,
      revokedAtSeq: eff.revokedAtSeq,
    }),
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("consent.mjs")) {
  process.exit(main(process.argv.slice(2)));
}

/**
 * extractive-salvage.ts — file-path policy + skeleton salvage for extractive.ts.
 *
 * Extracted from extractive.ts (A1/A2 sprint) to keep that file under the
 * 300-line src/ soft limit. Pure functions only — no I/O, no logging.
 *
 * DESIGN (A1): blocklist, not allowlist. The old `INTERESTING_EXT` allowlist
 * (rs/ts/tsx/js/json/md) silently produced content-free summaries for every
 * other language — a .go/.py/.c project got a 34-token skeleton. An allowlist
 * has to be *right* about ~40 ecosystems to be useful and fails closed (drops
 * real work) when it is wrong; a NOISE blocklist only has to be right about the
 * small, stable set of binary/generated/asset extensions and fails open (an
 * unknown extension is surfaced, which is the safe direction for a summary).
 */

import type { EngineMessage } from "./types.js";

// ---- File path policy ------------------------------------------------------

/**
 * Generic extension capture: any 1–6 char ALPHABETIC extension. Path
 * character class is unchanged from the original FILE_PATH_RE so existing
 * matching behaviour (quotes/backticks/whitespace as delimiters) is preserved.
 * Alphabetic-only is deliberate: every real source/config extension is alpha
 * (c..tsx, tsconfig.json), while an alphanumeric class matches version strings
 * ("GLM-4.7", "v0.21.9", "Node 18.2") as "files" and spams Key files.
 */
export const FILE_PATH_RE = /(?:^|\s)([^\s"`']+\.([A-Za-z]{1,6}))\b/g;

/** Same policy, single-match, for inferCurrentWork (also excludes ':'). */
export const CURRENT_WORK_PATH_RE = /(?:^|\s)([^\s"`':]+\.([A-Za-z]{1,6}))\b/m;

/**
 * Binary / generated / asset / vendored extensions that carry no summary value.
 * Deliberately small and stable. Note `md`, `json`, `toml`, `yaml`, `sql`, `css`
 * and `html` are NOT noise — they are hand-edited source in most repos.
 */
export const NOISE_EXT = new Set([
  // lockfiles & logs
  "lock", "log", "sum",
  // images & media
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff",
  "mp3", "mp4", "mov", "wav", "webm", "avi",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // archives & binaries
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "obj", "class", "pyc", "pyo",
  "wasm", "node", "jar", "war", "deb", "rpm", "dmg", "iso", "img",
  // generated / build artifacts
  "map", "min", "lockb", "snap", "cache", "tmp", "temp", "swp", "bak", "orig",
  // data blobs & databases
  "pdf", "db", "sqlite", "sqlite3", "pack", "idx", "pem", "key", "crt",
]);

/** Directory fragments whose files are never "key files" for a summary. */
const NOISE_DIR_RE = /(?:^|\/)(?:node_modules|\.git|dist|build|coverage|vendor|target|__pycache__|\.venv|venv)(?:\/|$)/;

/**
 * TLD-shaped extensions: `example.com`, `github.com`, `npm.cmd` are domains and
 * launchers, not code. (QA lens 1 finding, 2026-08-19.) Conservative list only —
 * no real source extension lives here (.go/.rs/.ts stay interesting).
 */
const TLD_EXT = new Set([
  "com", "org", "net", "io", "gov", "edu", "biz", "info", "dev", "app",
  "page", "xyz", "site", "online", "cloud", "me", "co", "us", "uk", "de",
  "fr", "jp", "cn", "nl", "se", "eu", "int", "mil", "cmd",
]);

/** True when a matched path is worth surfacing in a summary. */
export function isInterestingPath(filePath: string, ext: string): boolean {
  const lowerExt = ext.toLowerCase();
  if (NOISE_EXT.has(lowerExt)) return false;
  if (TLD_EXT.has(lowerExt)) return false; // bare domains, not code
  if (/^(?:https?|ftp):\/\//i.test(filePath) || filePath.toLowerCase().startsWith("www.")) return false;
  if (NOISE_DIR_RE.test(filePath)) return false;
  // `app.min.js` / `bundle.min.css` style double extensions.
  if (/\.min\.[A-Za-z0-9]{1,6}$/.test(filePath)) return false;
  if (/\.map$/.test(filePath)) return false;
  // Prose abbreviations ("e.g", "i.e", "U.S"): a single-char base with no slash
  // and no digit is never a filename. ("a.c" is rare collateral; "q1.py" and
  // "src/a.ts" survive — digit / slash both exempt.)
  const base = filePath.slice(0, filePath.lastIndexOf("."));
  if (!filePath.includes("/") && !/\d/.test(filePath) && base.length <= 1) return false;
  return true;
}

// ---- Path collection -------------------------------------------------------

const MAX_KEY_FILES = 5;
const MAX_FILES = 10;
const FRESHNESS_WINDOW = 10;

/** All interesting file paths mentioned in a blob of text. */
export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(FILE_PATH_RE)) {
    if (isInterestingPath(m[1], m[2])) paths.push(m[1]);
  }
  return paths;
}

/** Most-mentioned paths within the recency window (behaviour unchanged). */
export function collectKeyFiles(messages: EngineMessage[]): string[] {
  const recent = messages.slice(-FRESHNESS_WINDOW);
  const pathFreq = new Map<string, number>();
  for (const m of recent) {
    for (const p of extractFilePaths(m.text)) {
      pathFreq.set(p, (pathFreq.get(p) ?? 0) + 1);
    }
  }
  return [...pathFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEY_FILES)
    .map(([p]) => p);
}

/** Paths written/edited by tools (extension-agnostic; behaviour unchanged). */
export function extractFilesModified(tools: EngineMessage[]): string[] {
  const files = new Set<string>();
  for (const m of tools) {
    if (!m.toolName) continue;
    const name = m.toolName.toLowerCase();
    if (name === "write" || name === "edit" || name === "notebookedit") {
      const input = m.input ?? m.text;
      const pathMatch = input.match(/["']?(\/[^\s"']+\.\w+)["']?/);
      if (pathMatch) files.add(pathMatch[1]);
    }
    if (name === "bash") {
      const cmd = m.input ?? m.text;
      if (cmd.includes("git add") || cmd.includes("git commit") || cmd.includes("git diff")) {
        for (const p of extractFilePaths(cmd)) files.add(p);
      }
    }
  }
  return [...files].slice(0, MAX_FILES);
}

// ---- Placeholder user turns (A2b) ------------------------------------------

/**
 * Content-free user turns. Extremely common in resumed sessions; taking them
 * verbatim as "User requests" is what produced the three "• resume" bullets.
 */
const PLACEHOLDER_RE =
  /^(?:resume|continue|go on|go ahead|proceed|next|yes|yeah|yep|y|ok|okay|k|sure|thanks|thank you|ty|done|please continue|carry on)\W*$/i;

export function isPlaceholderRequest(text: string): boolean {
  return PLACEHOLDER_RE.test(text.trim());
}

// ---- Skeleton salvage (A2c) ------------------------------------------------

const MAX_SALVAGE_LINES = 5;
const SALVAGE_LINE_LEN = 120;

/**
 * A "skeleton" summary is the scope line and nothing else — no files, no current
 * work, no decisions, no pending items, and no *substantive* user request. That
 * is ~34 tokens of zero information and is what breaks a resumed session.
 *
 * NOTE: `recentUser` is treated as empty when it holds only placeholders. The
 * incident summary DID have three "• resume" bullets, so a plain
 * `recentUser.length === 0` test would never have fired on the very case this
 * salvage exists for.
 */
export function isSkeletonSummary(parts: {
  recentUser: string[];
  keyFiles: string[];
  currentWork: string | undefined;
  decisions: string[];
  pending: string[];
}): boolean {
  const hasRealRequest = parts.recentUser.some((r) => !isPlaceholderRequest(r));
  return (
    !hasRealRequest &&
    parts.keyFiles.length === 0 &&
    !parts.currentWork &&
    parts.decisions.length === 0 &&
    parts.pending.length === 0
  );
}

/**
 * Last-resort content: the first meaningful line of the most recent assistant
 * and tool messages. Deterministic (pure scan, newest-first, then re-ordered
 * oldest-first for reading). Returns [] when there is genuinely nothing.
 */
export function buildSalvageDigest(messages: EngineMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && out.length < MAX_SALVAGE_LINES; i--) {
    const m = messages[i];
    if (m.role !== "assistant" && m.role !== "tool") continue;
    const raw = m.text || m.output || m.input || "";
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) continue;
    const label = m.role === "tool" ? `${m.toolName ?? "tool"}: ` : "";
    const entry = truncateLine(`${label}${line}`, SALVAGE_LINE_LEN);
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.reverse();
}

function truncateLine(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

/**
 * conflict-scan.ts — detect other installed pi extensions that overlap with
 * pi-mega-compact's two owned responsibilities:
 *
 *   1. Conversation auto-compaction (we hook session_before_compact).
 *   2. Durable "save to memory" (we now keep a `memories` table in our SQLite).
 *
 * This is a DETECT-AND-WARN scanner only. pi has no pre-load / veto hook — one
 * extension cannot block another from loading — so we inspect the installed
 * package set at startup and on demand, then report overlaps. No config is
 * mutated. (See memory `pi-memory-mcp-review` for the original conflict pattern.)
 *
 * Pi-agnostic: reads package.json + greps source. No pi runtime types, so it is
 * unit-testable against a fixture node_modules tree.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type ConflictKind = "compaction" | "memory" | "tool-output";
export type ConflictSeverity = "high" | "info";

export interface ConflictHit {
  package: string;
  severity: ConflictSeverity;
  kind: ConflictKind;
  evidence: string[];
  /** One-line recommended action for the user. */
  recommendation: string;
}

export interface ConflictReport {
  scanned: string[];
  conflicts: ConflictHit[];
}

// Marker sets. A package is flagged when its source matches a marker in a
// category. File-grep (not AST) keeps this dependency-free and fast.
const MARKERS = {
  // Directly competes with our conversation compaction.
  compaction: [
    "session_before_compact",
    "session_compact",
    "compactSession",
    "autoCompact",
    "auto_compact",
  ],
  // Saves durable memory to its own store — the takeover target.
  memory: [
    "MEMORY_TOOL",
    "learn-memory",
    "saveMemory",
    "memoryPolicy",
    "wal_checkpoint",
    "store/db.ts",
    "memoryTool",
  ],
  // Tool-output shaping (compact/summarize tool results) — overlap, not a rival.
  toolOutput: [
    "tool_result",
    "ToolResult",
  ],
} as const;

/** Resolve the node_modules dir that contains this package (or env override). */
export function resolveExtensionRoot(selfDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const override = process.env.MEGACOMPACT_EXT_SCAN_DIR;
  if (override && override.trim() !== "") return override;
  // selfDir is <root>/extensions or <root>/dist/extensions. Walk up to the
  // node_modules that holds pi-mega-compact.
  let dir = selfDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate) && existsSync(join(candidate, "pi-mega-compact"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Recursively collect source-ish files under a package, capped to avoid scans. */
function collectFiles(root: string, max = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (e === "node_modules" || e === ".git") continue;
        walk(full);
      } else if (/\.(ts|js|mjs|cjs|json|md)$/.test(e)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Grep a package's source for any marker in `keys`; return matched markers. */
function matchMarkers(pkgDir: string, keys: readonly string[]): string[] {
  const found = new Set<string>();
  let files: string[];
  try {
    files = collectFiles(pkgDir);
  } catch {
    return [];
  }
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    for (const m of keys) {
      if (text.includes(m)) found.add(m);
    }
    if (found.size === keys.length) break;
  }
  return [...found];
}

/**
 * Scan installed extensions for overlaps with pi-mega-compact.
 * @param selfName package name to skip (defaults to this package's name).
 */
export function detectConflicts(selfName = "pi-mega-compact"): ConflictReport {
  const root = resolveExtensionRoot();
  const scanned: string[] = [];
  const conflicts: ConflictHit[] = [];
  if (!root || !existsSync(root)) return { scanned, conflicts };

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { scanned, conflicts };
  }

  for (const name of entries) {
    const pkgDir = join(root, name);
    if (!statSync(pkgDir).isDirectory()) continue;
    const pkgJson = join(pkgDir, "package.json");
    if (!existsSync(pkgJson)) continue;
    let pkg: { name?: string; pi?: { extensions?: string[] } };
    try {
      pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
    } catch {
      continue;
    }
    const pkgName = pkg.name ?? name;
    if (pkgName === selfName) continue;
    // Only consider packages that declare pi extensions.
    if (!pkg.pi || !Array.isArray(pkg.pi.extensions) || pkg.pi.extensions.length === 0) continue;
    scanned.push(pkgName);

    const memHits = matchMarkers(pkgDir, MARKERS.memory);
    const compHits = matchMarkers(pkgDir, MARKERS.compaction);
    const toolHits = matchMarkers(pkgDir, MARKERS.toolOutput);

    if (compHits.length > 0) {
      conflicts.push({
        package: pkgName,
        severity: "high",
        kind: "compaction",
        evidence: compHits,
        recommendation: "Disabling recommended — competes with pi-mega-compact's conversation compaction.",
      });
      continue; // compaction is the dominant conflict; don't double-flag.
    }
    if (memHits.length > 0) {
      conflicts.push({
        package: pkgName,
        severity: "high",
        kind: "memory",
        evidence: memHits,
        recommendation: "pi-mega-compact now owns save-to-memory (/mega-memory, its own SQLite). Disable this to avoid duplicate memory stores.",
      });
      continue;
    }
    if (toolHits.length > 0) {
      conflicts.push({
        package: pkgName,
        severity: "info",
        kind: "tool-output",
        evidence: toolHits,
        recommendation: "Shapes tool output (summarize/compact tool results). Generally compatible; no action needed.",
      });
    }
  }

  return { scanned, conflicts };
}

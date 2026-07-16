/**
 * mega-conflict-cmds.ts — extension conflict validator + save-to-memory command.
 *
 * Detects other installed extensions that overlap with pi-mega-compact
 * (conversation compaction, or save-to-memory) and WARNs — pi has no pre-load
 * veto hook, so this is detect-and-warn only. Also registers /mega-memory, our
 * own durable memory store in SQLite (the takeover of memory extensions).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectConflicts, type ConflictReport } from "./conflict-scan.js";
import { addMemory, listMemories, searchMemories, recallMemory, type MemoryRecord } from "../src/store/sqlite.js";
import { resolveRepoRoot } from "./mega-config.js";
import { MegaRuntime } from "./mega-runtime.js";

/** Run the conflict scan and format a human-readable report. */
export function validateExtensions(): { report: ConflictReport; lines: string[] } {
  const report = detectConflicts();
  const lines: string[] = [];
  if (report.conflicts.length === 0) {
    lines.push(`[mega-compact] conflict check: ${report.scanned.length} extensions scanned, no overlaps.`);
    return { report, lines };
  }
  const high = report.conflicts.filter((c) => c.severity === "high");
  lines.push(`[mega-compact] conflict check: ${report.scanned.length} scanned, ${report.conflicts.length} overlap(s), ${high.length} high-severity.`);
  for (const c of report.conflicts) {
    const tag = c.severity === "high" ? "⚠ HIGH" : "ℹ info";
    lines.push(`  ${tag} ${c.package} — ${c.kind} — ${c.recommendation}`);
  }
  return { report, lines };
}

/** Run the scan at activation and surface a one-line warning if needed. */
export function runLoadTimeConflictCheck(): void {
  try {
    const { lines } = validateExtensions();
    const high = lines.filter((l) => l.includes("⚠ HIGH"));
    if (high.length > 0) {
      // Non-fatal: just inform on stderr; the dashboard/commands carry details.
      console.warn(lines.join("\n"));
    }
  } catch {
    /* best-effort; never block session load */
  }
}

function memoryLine(m: MemoryRecord): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  const snap = m.content.length > 80 ? m.content.slice(0, 77) + "…" : m.content;
  return `#${m.id} (${m.kind})${tags}: ${snap}`;
}

/** Register conflict-check + memory commands. */
export function registerConflictCommands(pi: ExtensionAPI, runtime: MegaRuntime): void {
  runLoadTimeConflictCheck();

  pi.registerCommand("mega-compat-check", {
    description: "Scan installed extensions for overlaps with pi-mega-compact (compaction / save-to-memory) and warn.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const { lines } = validateExtensions();
      for (const l of lines) ctx.ui.notify(l);
      if (lines.length === 1) {
        ctx.ui.notify("[mega-compact] You own compaction + memory; no conflicting extensions detected.");
      }
    },
  });

  pi.registerCommand("mega-memory", {
    description: "Save and recall durable memory in pi-mega-compact's SQLite store. Usage: /mega-memory save <text> | list | search <q> | recall <id>",
    handler: async (args: string, ctx: ExtensionContext) => {
      const repo = resolveRepoRoot(ctx.cwd) ?? runtime.currentStateDir;
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "list";

      if (sub === "save") {
        const text = args.trim().slice(4).trim();
        if (!text) {
          ctx.ui.notify("[mega-memory] usage: /mega-memory save <text>");
          return;
        }
        // Optional "#tag #tag" parsing from the tail.
        const tagMatches = [...text.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
        const content = text.replace(/#[\w-]+/g, "").trim();
        const id = addMemory({ content, tags: tagMatches }, repo, runtime.currentStateDir);
        ctx.ui.notify(`[mega-memory] saved #${id} to ${repo.split(/[\\/]/).pop()}`);
        return;
      }

      if (sub === "search") {
        const q = parts.slice(1).join(" ").trim();
        if (!q) {
          ctx.ui.notify("[mega-memory] usage: /mega-memory search <query>");
          return;
        }
        const hits = searchMemories(q, repo, 50, runtime.currentStateDir);
        if (!hits.length) {
          ctx.ui.notify("[mega-memory] no memories match.");
          return;
        }
        for (const m of hits) ctx.ui.notify(memoryLine(m));
        return;
      }

      if (sub === "recall") {
        const id = Number(parts[1]);
        if (!Number.isFinite(id) || parts[1] === undefined) {
          ctx.ui.notify("[mega-memory] usage: /mega-memory recall <id>");
          return;
        }
        if (recallMemory(id, runtime.currentStateDir)) {
          const found = listMemories(repo, 1000, runtime.currentStateDir).find((m) => m.id === id);
          ctx.ui.notify(found ? `[mega-memory] ${memoryLine(found)}` : `[mega-memory] recalled #${id}`);
        } else {
          ctx.ui.notify(`[mega-memory] #${id} not found.`);
        }
        return;
      }

      // default: list
      const all = listMemories(repo, 50, runtime.currentStateDir);
      if (!all.length) {
        ctx.ui.notify("[mega-memory] no saved memories yet. Use /mega-memory save <text>.");
        return;
      }
      ctx.ui.notify(`[mega-memory] ${all.length} saved to ${repo.split(/[\\/]/).pop()}:`);
      for (const m of all) ctx.ui.notify(memoryLine(m));
    },
  });

  // Shortform aliases — `m save "..."`, `m status`, `m list`, `m search <q>`,
  // `m recall <id>`. Delegates to the same SQLite store so there's one source
  // of truth. The /mega-memory command remains the canonical form.
  pi.registerCommand("m", {
    description: "Shortform alias for /mega-memory. Usage: /m save <text> | list | search <q> | recall <id> | status",
    handler: async (args: string, ctx: ExtensionContext) => {
      const repo = resolveRepoRoot(ctx.cwd) ?? runtime.currentStateDir;
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "list";

      if (sub === "save") {
        // Strip leading "save" so /m save "#foo bar" works the same as the
        // canonical form. Then strip a balanced outer quote pair if the user
        // wrote /m save "..." — common when the text contains spaces.
        let text = args.trim().slice(4).trim();
        const mq = text.match(/^["“](.*)["”]$/s);
        if (mq) text = mq[1].trim();
        if (!text) {
          ctx.ui.notify('[/m] usage: /m save "<text>" or /m save <text>');
          return;
        }
        const tagMatches = [...text.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
        const content = text.replace(/#[\w-]+/g, "").trim();
        const id = addMemory({ content, tags: tagMatches }, repo, runtime.currentStateDir);
        ctx.ui.notify(`[/m] saved #${id} to ${repo.split(/[\\/]/).pop()}`);
        return;
      }

      if (sub === "search") {
        const q = parts.slice(1).join(" ").trim();
        if (!q) {
          ctx.ui.notify("[/m] usage: /m search <query>");
          return;
        }
        const hits = searchMemories(q, repo, 50, runtime.currentStateDir);
        if (!hits.length) {
          ctx.ui.notify("[/m] no memories match.");
          return;
        }
        for (const mem of hits) ctx.ui.notify(memoryLine(mem));
        return;
      }

      if (sub === "recall") {
        const id = Number(parts[1]);
        if (!Number.isFinite(id) || parts[1] === undefined) {
          ctx.ui.notify("[/m] usage: /m recall <id>");
          return;
        }
        if (recallMemory(id, runtime.currentStateDir)) {
          const found = listMemories(repo, 1000, runtime.currentStateDir).find((mem) => mem.id === id);
          ctx.ui.notify(found ? `[/m] ${memoryLine(found)}` : `[/m] recalled #${id}`);
        } else {
          ctx.ui.notify(`[/m] #${id} not found.`);
        }
        return;
      }

      if (sub === "status") {
        const all = listMemories(repo, 1000, runtime.currentStateDir);
        const byKind = all.reduce<Record<string, number>>((acc, m) => {
          acc[m.kind] = (acc[m.kind] ?? 0) + 1;
          return acc;
        }, {});
        const kinds = Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(", ");
        const head = `[/m] ${all.length} memory record(s) in ${repo.split(/[\\/]/).pop() ?? repo}`;
        ctx.ui.notify(kinds ? `${head} (${kinds})` : head);
        return;
      }

      // default: list
      const all = listMemories(repo, 50, runtime.currentStateDir);
      if (!all.length) {
        ctx.ui.notify("[/m] no saved memories yet. Use /m save <text>.");
        return;
      }
      ctx.ui.notify(`[/m] ${all.length} memory record(s):`);
      for (const mem of all) ctx.ui.notify(memoryLine(mem));
    },
  });
}

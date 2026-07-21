/**
 * dashboard-client/src/components/RepoTable.tsx — sortable, searchable repo table.
 *
 * Columns: name, model, checkpoints, tokens saved, last compacted, sessions.
 * Client-side sort (click header to toggle asc/desc). Search by displayName
 * (case-insensitive substring). Default sort: lastSeen DESC.
 */

import type React from "react";
import { useState, useMemo } from "react";
import type { IndexesIndexRow } from "@contracts";

export interface RepoTableProps {
  repos: IndexesIndexRow[];
  /** Called when a row is clicked — opens the detail modal. */
  onSelect: (repo: IndexesIndexRow) => void;
}

type SortKey =
  | "displayName"
  | "modelName"
  | "checkpointCount"
  | "tokensSaved"
  | "lastCompactedAt"
  | "sessions";

type SortDir = "asc" | "desc";

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "displayName", label: "Name" },
  { key: "modelName", label: "Model" },
  { key: "checkpointCount", label: "Checkpoints" },
  { key: "tokensSaved", label: "Saved" },
  { key: "lastCompactedAt", label: "Last compacted" },
  { key: "sessions", label: "Sessions" },
];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTs(ts: number | null): string {
  if (ts === null || ts === undefined) return "never";
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return String(ts);
  }
}

export function RepoTable({ repos, onSelect }: RepoTableProps): React.ReactElement {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastCompactedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? repos.filter((r) => r.displayName.toLowerCase().includes(q))
      : repos.slice();
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // nulls last on desc, first on asc (consistent UX)
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return sortDir === "desc" ? 1 : -1;
      if (bNull) return sortDir === "desc" ? -1 : 1;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "desc" ? -cmp : cmp;
    });
    return list;
  }, [repos, search, sortKey, sortDir]);

  const handleSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "lastCompactedAt" || key === "tokensSaved" ? "desc" : "asc");
    }
  };

  return (
    <div className="repo-table-wrap">
      <input
        type="search"
        className="repo-search"
        placeholder="Search repos…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search repos"
      />
      <table className="repo-table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key}>
                <button
                  type="button"
                  className={`sort-header ${sortKey === col.key ? `active-${sortDir}` : ""}`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && <span className="sort-arrow">{sortDir === "asc" ? " ▲" : " ▼"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="repo-empty">
                {repos.length === 0 ? "No repos yet." : "No repos match your search."}
              </td>
            </tr>
          )}
          {filtered.map((repo) => (
            <tr key={repo.stateDir} onClick={() => onSelect(repo)}>
              <td className="repo-name">{repo.displayName}</td>
              <td className="repo-model">{repo.modelName ?? "—"}</td>
              <td>{repo.checkpointCount.toLocaleString()}</td>
              <td>{fmt(repo.tokensSaved)}</td>
              <td>{formatTs(repo.lastCompactedAt)}</td>
              <td>{repo.sessions.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

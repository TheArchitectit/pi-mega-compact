/**
 * foundation.ts — future-feature foundation (resume sessions / daily log / lessons).
 *
 * Scaffolded tables + minimal helpers so all store data lives in SQLite from
 * day one. Full UI/recall for these lands in later sprints.
 */
import { getStateDir, normalizeSessionId } from "../../store.js";
import { openStore } from "./utils.js";

/** Upsert a `sessions` row (resume + per-repo session history). */
export function touchSession(
  sessionId: string,
  repo: string | undefined,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const existing = db
    .prepare("SELECT started_at FROM sessions WHERE session_id = ?")
    .get(sid) as { started_at: number | null } | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!existing) {
    db.prepare(
      `INSERT INTO sessions(session_id, repo, started_at, last_compacted_at, status)
       VALUES(?, ?, ?, ?, 'active')`,
    ).run(sid, repo ?? null, now, now);
  } else {
    db.prepare(
      "UPDATE sessions SET last_compacted_at = ?, repo = COALESCE(?, repo), status = 'active' WHERE session_id = ?",
    ).run(now, repo ?? null, sid);
  }
}

/** Append a `daily_log` entry (day = YYYY-MM-DD, local-naive from Date). */
export function logDaily(
  sessionId: string,
  event: string,
  detail: string | undefined,
  tokensSaved: number,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const day = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO daily_log(day, session_id, event, detail, tokens_saved, ts)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(day, normalizeSessionId(sessionId), event, detail ?? null, tokensSaved, now);
}

/** Append a `lessons` entry (future lessons-learned browse/recall). */
export function addLesson(
  sessionId: string,
  repo: string | undefined,
  lesson: string,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO lessons(session_id, repo, lesson, ts) VALUES(?, ?, ?, ?)`,
  ).run(normalizeSessionId(sessionId), repo ?? null, lesson, now);
}

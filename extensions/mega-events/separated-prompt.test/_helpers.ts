/**
 * Shared helpers for the separated-prompt.test split files.
 * Extracted from extensions/mega-events/separated-prompt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../../../src/store/sqlite/schema.js";

/** Cast output to a plain Record array for role/content access in assertions. */
export type R = Record<string, unknown>;

export function asR(arr: unknown[]): R[] {
  return arr as R[];
}

/** Create a temp DB with schema initialized, returns db + dir. */
export function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "separated-prompt-test-"));
  const db = new DatabaseSync(join(dir, "sqlite.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  initSchema(db);
  return { db, dir };
}

/** Helper: create an AgentMessage-like object. */
export function msg(
  role: string,
  content: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { role, content, ...extra };
}

/**
 * Shared helpers for the memoryGraph-gates split files.
 * Extracted from src/memoryGraph-gates.test.ts: temp dirs, node/edge/ws
 * builders, withEnv, and populateStore (real SQLite seeding).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryGraphNode, MemoryGraphEdge } from "../memoryGraph.js";
import type { GraphWorkingSet } from "../memoryGraph/gates.js";
import { openStore } from "../store/sqlite/utils.js";
import { upsertCheckpoint } from "../store/sqlite/checkpoints.js";
import { recordTurn, newConversationId } from "../store/sqlite/turns.js";
import { appendRawTranscript } from "../store/sqlite/raw-transcript.js";
import type { RawTranscriptRow } from "../store/sqlite/raw-transcript.js";

export const baseTmp = mkdtempSync(join(tmpdir(), "mc-mgraph-gates-"));
let counter = 0;

export function tmpDir(): string {
  return join(baseTmp, `run-${counter++}`);
}

export function n(
  id: string,
  overrides: Partial<MemoryGraphNode> = {},
): MemoryGraphNode {
  return {
    id,
    sessionId: "sess_test",
    label: id,
    summaryTruncated: "",
    tokenEstimate: 0,
    timestamp: 1000,
    dedupStatus: undefined,
    raptorLevel: 0,
    topicSummary: undefined,
    decisionCount: 0,
    textSnippet: "",
    nodeType: "checkpoint",
    epochId: undefined,
    ...overrides,
  };
}

export function e(
  source: string,
  target: string,
  overrides: Partial<MemoryGraphEdge> = {},
): MemoryGraphEdge {
  return { source, target, weight: 1.0, type: "temporal", ...overrides };
}

export function ws(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[] = [],
): GraphWorkingSet {
  return { nodes, edges };
}

/** Save and restore env vars around a test. */
export function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = env[k]!;
    }
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

export function populateStore(
  dir: string,
  sessionId: string,
  sources: { checkpoint?: boolean; turn?: boolean; turnContent?: boolean; memory?: boolean },
): void {
  const db = openStore(dir);

  if (sources.checkpoint) {
    upsertCheckpoint(
      {
        checkpointId: "chkpt_001",
        sessionId,
        regionHash: "abc",
        contentHash: "def",
        normalizedText: "checkpoint one",
        summary: "Checkpoint One",
        tokenEstimate: 50,
        timestamp: 1000,
        embedding: [],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
      },
      dir,
    );
    upsertCheckpoint(
      {
        checkpointId: "chkpt_002",
        sessionId,
        regionHash: "ghi",
        contentHash: "jkl",
        normalizedText: "checkpoint two",
        summary: "Checkpoint Two",
        tokenEstimate: 60,
        timestamp: 2000,
        embedding: [],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
      },
      dir,
    );
  }

  if (sources.turn) {
    const convId = newConversationId();
    recordTurn(
      { conversationId: convId, sessionId, turnIndex: 0, role: "user", endedAt: 1500, ctxTokens: 100 },
      dir,
    );
    recordTurn(
      { conversationId: convId, sessionId, turnIndex: 1, role: "assistant", endedAt: 2500, ctxTokens: 200 },
      dir,
    );
  }

  if (sources.turnContent) {
    const rows: RawTranscriptRow[] = [
      { sessionId, seq: 0, role: "user", contentBytes: "hello from the user", contentHash: "hash_0", toolName: null, messageTimestamp: 1500, checkpointEpoch: "", turnIndex: 0 },
      { sessionId, seq: 1, role: "assistant", contentBytes: "response from assistant", contentHash: "hash_1", toolName: null, messageTimestamp: 2500, checkpointEpoch: "", turnIndex: 1 },
    ];
    for (const row of rows) {
      appendRawTranscript(db, row);
    }
  }

  if (sources.memory) {
    db.prepare(
      `INSERT OR IGNORE INTO memories (content, kind, created_at, source_turn)
       VALUES (?, ?, ?, ?)`,
    ).run("remembered fact", "fact", 2000, 0);
    db.prepare(
      `INSERT OR IGNORE INTO memories (content, kind, created_at, source_turn)
       VALUES (?, ?, ?, ?)`,
    ).run("user preference", "preference", 3000, 1);
  }
}

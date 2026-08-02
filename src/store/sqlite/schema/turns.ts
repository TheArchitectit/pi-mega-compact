/**
 * turns.ts — S43 per-turn vector tracking DDL (extracted from schema.ts).
 * The relational spine for per-turn + per-conversation memories. Executed via
 * db.exec in initSchema. No user input reaches this SQL (PREVENT-002).
 */

export const TURNS_DDL = `
    -- S43 (per-turn vector tracking): the relational spine for per-turn +
    -- per-conversation memories. One row per turn_end; links turns to the
    -- epoch that compacted them (epoch_id) and to the checkpoints/cluster
    -- summaries that were RECALLED during that turn (turn_recall).
    -- conversation_id groups turns across pi session resumes (/clear starts a
    -- new conversation root; a fork carries parent_conversation_id).
    CREATE TABLE IF NOT EXISTS turns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT, -- global turn id
      conversation_id TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      turn_index      INTEGER NOT NULL,                   -- per-session turn (event.turnIndex)
      role            TEXT,                                -- 'user' | 'assistant' | 'tool' (turn's last role)
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,                             -- set at turn_end
      ctx_tokens      INTEGER,                             -- runtime.lastCtxTokens snapshot
      ctx_percent     REAL,                                -- runtime.lastCtxPercent
      pressure_band   TEXT,                                -- 'low'|'mid'|'high'|'critical'
      model_id        TEXT,
      epoch_id        TEXT,                                -- FK checkpoint_epochs (set when a compact closes this turn's epoch)
      UNIQUE(session_id, turn_index)
    );
    CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_turns_epoch ON turns(epoch_id) WHERE epoch_id IS NOT NULL;

    -- S43: recall provenance — which checkpoints/cluster summaries were
    -- injected at which turn, their score, and the path that sourced them.
    -- This is the per-turn vector data that makes memory quality measurable
    -- per turn and enables recall-to-point (replay these checkpoint_ids into a
    -- forked session). source: 'flat' | 'raptor' | 'cross-repo' | 'memory'.
    CREATE TABLE IF NOT EXISTS turn_recall (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id       INTEGER NOT NULL,
      checkpoint_id TEXT NOT NULL,
      score         REAL NOT NULL,
      source        TEXT NOT NULL,
      raptor_level  INTEGER,                              -- set for RAPTOR cluster hits
      UNIQUE(turn_id, checkpoint_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_recall_turn ON turn_recall(turn_id);
    CREATE INDEX IF NOT EXISTS idx_turn_recall_cp ON turn_recall(checkpoint_id);

    -- S43: conversation branch/fork registry. A row per fork: the child
    -- conversation inherits the parent's recall state at fork_turn_id as its
    -- starting injected-set. The root conversation has no row here.
    CREATE TABLE IF NOT EXISTS conversation_branches (
      conversation_id        TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL,
      fork_turn_id           INTEGER NOT NULL,             -- FK turns.id at the branch point
      created_at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_branch_parent ON conversation_branches(parent_conversation_id);
`;

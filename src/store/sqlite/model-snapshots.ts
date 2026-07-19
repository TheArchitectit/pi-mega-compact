/**
 * model-snapshots.ts — `model_snapshots` table (active model/provider per repo).
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

/** A captured model/provider snapshot (for cost estimation + dashboard). */
export interface ModelSnapshot {
  provider: string;
  providerName: string | null;
  modelId: string;
  modelName: string | null;
  inputRate: number; // USD per input token
  outputRate: number; // USD per output token
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  capturedAt: number;
}

/** Persist the active model/provider for a repo (latest row wins per repo). */
export function recordModelSnapshot(
  repoRoot: string,
  snap: Omit<ModelSnapshot, "capturedAt">,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO model_snapshots
       (repo_root, provider, provider_name, model_id, model_name, input_rate,
        output_rate, context_window, max_tokens, reasoning, captured_at)
     VALUES (@repo_root, @provider, @provider_name, @model_id, @model_name,
             @input_rate, @output_rate, @context_window, @max_tokens, @reasoning, @captured_at)`,
  ).run({
    repo_root: repoRoot,
    provider: snap.provider,
    provider_name: snap.providerName,
    model_id: snap.modelId,
    model_name: snap.modelName,
    input_rate: snap.inputRate,
    output_rate: snap.outputRate,
    context_window: snap.contextWindow,
    max_tokens: snap.maxTokens,
    reasoning: snap.reasoning ? 1 : 0,
    captured_at: Date.now(),
  });
}

/** Most recent model/provider snapshot for a repo, or undefined. */
export function latestModelSnapshot(stateDir: string = getStateDir()): ModelSnapshot | undefined {
  const db = openStore(stateDir);
  const row = db
    .prepare(
      `SELECT * FROM model_snapshots ORDER BY captured_at DESC LIMIT 1`,
    )
    .get() as
    | {
        provider: string;
        provider_name: string | null;
        model_id: string;
        model_name: string | null;
        input_rate: number;
        output_rate: number;
        context_window: number;
        max_tokens: number;
        reasoning: number;
        captured_at: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    provider: row.provider,
    providerName: row.provider_name,
    modelId: row.model_id,
    modelName: row.model_name,
    inputRate: row.input_rate,
    outputRate: row.output_rate,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    reasoning: row.reasoning === 1,
    capturedAt: row.captured_at,
  };
}

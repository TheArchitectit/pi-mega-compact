/**
 * guardrails.ts — hallucination defense for RAPTOR summary nodes (Sprint 13, QA #16).
 *
 * Four layers gate a candidate summary before it may be marked high-quality:
 *   1. Claim grounding — every claim in the summary maps to source text
 *      (no entity/claim appears that isn't supported by a source chunk).
 *   2. Entity coverage — fraction of summary entities that are present in source.
 *   3. Consistency — cosine(reEmbed(summary), cluster centroid) ≥ threshold.
 *      This is the HARD gate: a low score means the summary drifted from the
 *      source cluster, so we fall back to extractive (never serve a low-quality
 *      LLM summary).
 *   4. Quality markers — 'high' | 'low' | 'extractive_fallback' assigned from the
 *      above.
 *
 * Pure functions, no network, no model. The consistency check uses the caller's
 * embedder (the same local Embedder used everywhere else).
 */

import type { Embedder, Vector } from "../../embedder.js";
import { cosineSimilarity } from "../../embedder.js";

export type QualityMarker = "high" | "low" | "extractive_fallback";

export interface GuardrailInput {
  summary: string;
  /** Source chunk texts the summary is supposed to cover. */
  sources: string[];
  /** Cluster centroid (embedding) the summary must stay consistent with. */
  centroid: Vector;
  /** The local embedder (reused from the rest of the pipeline). */
  embedder: Embedder;
  /** Deterministically-precomputed source tokens (uppercased words) for grounding. */
  sourceTokens: Set<string>;
  /** Consistency threshold; below this → extractive fallback (QA #16). */
  consistencyThreshold?: number;
}

export interface GuardrailResult {
  marker: QualityMarker;
  entityCoverage: number; // 0..1
  consistency: number; // cosine(summEmbed, centroid)
  grounded: boolean;
  reason: string;
}

const ENTITY_RE = /\b([A-Z][a-zA-Z0-9_]{2,}|[a-z_]+_[a-z_]+|\d{2,})\b/g;

/** Extract candidate "entities"/tokens from a summary for grounding checks. */
export function extractEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ENTITY_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Lowercase word set from a body of source text (for grounding lookups). */
export function sourceTokenSet(sources: string[]): Set<string> {
  const set = new Set<string>();
  for (const s of sources) for (const w of s.toLowerCase().split(/\W+/)) if (w) set.add(w);
  return set;
}

/**
 * Verify a summary against its sources + centroid.
 *
 * Faithfulness (QA #16): consistency is the hard gate. If the summary embedding
 * is insufficiently similar to the cluster centroid, the summary is NOT faithful
 * to the source — mark it 'extractive_fallback' so callers fall back to the
 * deterministic extractive summary instead of serving a drifted LLM summary.
 *
 * grounding: every summary entity must appear in the source token set. A single
 * un-grounded entity fails grounding (caught hallucination).
 */
export function applyHallucinationGuardrails(input: GuardrailInput): GuardrailResult {
  const threshold = input.consistencyThreshold ?? 0.6;
  const sourceTokens = input.sourceTokens;

  // Layer 1 + 2: entity grounding & coverage.
  const entities = extractEntities(input.summary);
  let groundedCount = 0;
  for (const e of entities) {
    if (sourceTokens.has(e)) groundedCount++;
  }
  const entityCoverage = entities.length === 0 ? 1 : groundedCount / entities.length;
  const grounded = entities.length === 0 || groundedCount === entities.length;

  // Layer 3: consistency re-embed.
  const summEmbed = input.embedder.embed(input.summary);
  const consistency = cosineSimilarity(summEmbed, input.centroid);

  // Layer 4: quality marker decision.
  if (!grounded || consistency < threshold) {
    return {
      marker: "extractive_fallback",
      entityCoverage,
      consistency,
      grounded,
      reason: !grounded
        ? "ungrounded entity in summary"
        : `consistency ${consistency.toFixed(2)} < ${threshold} (drift from source)`,
    };
  }
  const marker: QualityMarker = entityCoverage >= 0.7 ? "high" : "low";
  return { marker, entityCoverage, consistency, grounded, reason: "ok" };
}

/**
 * Convenience: build a fixture summary that is deliberately un-grounded (used by
 * tests to prove the guardrail CATCHES a hallucination). Not used in production.
 */
export function makeUngroundedSummary(realSource: string, fakeEntity: string): string {
  return `${realSource.slice(0, 60)} The quarterly revenue doubled to ${fakeEntity}.`;
}

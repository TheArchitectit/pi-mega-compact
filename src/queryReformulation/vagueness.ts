/**
 * vagueness.ts — heuristic vagueness detection for S43 query reformulation.
 *
 * Detects whether a query is "vague" enough to benefit from reformulation.
 */

/**
 * Heuristic: is this query "vague" enough to benefit from reformulation?
 * Returns true if the query is short, question-like, or lacks specific terms.
 *
 * ANY match -> vague:
 *   a) Total words <= `vagueMinWords` (e.g. "what about auth")
 *   b) Contains a question word AND total words <= `vagueVeryShortWords`
 *
 * NOTE: Misclassification is low-cost: a specific query that's wrongly expanded
 * just gets a slightly broader search; a vague query that's wrongly skipped
 * just gets the raw-query search (today's behavior).
 */
export function isVagueQuery(
  query: string,
  opts: { vagueMinWords: number; vagueVeryShortWords: number },
): boolean {
  const cleaned = query.replace(/[^\w\s]/g, "").trim();
  if (!cleaned) return true; // empty or punctuation-only query is vague

  const words = cleaned.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Rule a: very short query
  if (wordCount <= opts.vagueMinWords) return true;

  // Rule b: contains a question word AND is short-ish
  const questionWords = /^(what|why|how|when|where|who|which|does|did|is|are|was|were|can|could|would|should)\b/i;
  const hasQuestionWord = words.some((w) => questionWords.test(w));
  if (hasQuestionWord && wordCount <= opts.vagueVeryShortWords) return true;

  return false;
}

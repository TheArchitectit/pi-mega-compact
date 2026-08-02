/**
 * helpers.ts — shared micro-helpers (extracted from sources.ts).
 */

export function safeJsonCount(raw: string | null | undefined): number {
  if (!raw || typeof raw !== "string") return 0;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

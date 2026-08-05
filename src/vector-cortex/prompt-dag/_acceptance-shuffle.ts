/**
 * prompt-dag/_acceptance-shuffle.ts — small deterministic helpers shared by the
 * VC5A acceptance DAG/planner materializers.
 */

/** Array element equality (length + pairwise). */
export function eq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Fisher–Yates with a FIXED seed so permutation tests are reproducible across
 * runs and machines (no Math.random in tests).
 */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  let seed = 0x9e3779b9;
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/**
 * topk.ts — min-heap based top-K selection (Sprint 12, QA #4).
 *
 * Replaces the O(N log N) full `.sort()` in search() with an O(N log k) heap,
 * which matters once a session holds thousands of checkpoints. Generic over any
 * scored item with a numeric `score`.
 *
 * Pure, no deps, no network (PREVENT-PI-004).
 */

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Return the `k` highest-scoring items (stable insertion order on ties).
 * O(N log k) — a bounded min-heap of size k.
 */
export function topK<T>(items: Scored<T>[], k: number): Scored<T>[] {
  if (k <= 0) return [];
  if (items.length <= k) return [...items].sort((a, b) => b.score - a.score);

  // Min-heap of the current top-k, stored as a flat array of Scored<T>.
  const heap: Scored<T>[] = [];
  const push = (e: Scored<T>): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].score <= heap[i].score) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const siftDown = (start: number): void => {
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < heap.length && heap[l].score < heap[smallest].score) smallest = l;
      if (r < heap.length && heap[r].score < heap[smallest].score) smallest = r;
      if (smallest === i) break;
      [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
      i = smallest;
    }
  };

  for (const it of items) {
    if (heap.length < k) {
      push(it);
    } else if (it.score > heap[0].score) {
      // Replace the current minimum with this better-scoring item, then sift
      // it down to restore the min-heap invariant.
      heap[0] = it;
      siftDown(0);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

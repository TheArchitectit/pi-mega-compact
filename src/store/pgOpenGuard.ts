/**
 * pgOpenGuard.ts — bound the PGlite open so a stalled WASM init can never wedge
 * a pi turn.
 *
 * Both index modules (vectorIndex / memoryIndex) cache their in-flight open in a
 * module-level `initPromise`. That cache is what turns a single stalled open
 * into a permanent hang: PGlite is a single-writer WASM Postgres over a shared
 * dataDir (~/.pi/mega-compact-vector), so a second pi process opening the same
 * dir can block indefinitely. `await new PGlite(...)` then never settles, the
 * never-settling promise is cached, and every later caller awaits that same dead
 * promise — with no timers and no sockets left, node reports
 * "Promise resolution is still pending but the event loop has already resolved"
 * and the pi turn that awaited it never ends.
 *
 * withOpenTimeout() puts a ceiling on that wait. On timeout the caller gets
 * undefined (both modules already degrade to a synchronous scan), and the
 * abandoned open is disowned: if it does eventually settle, the instance is
 * closed so a stray PGlite can't keep the loop alive or hold the dataDir lock.
 *
 * A rejected open is NOT swallowed — it propagates so the callers' existing
 * corrupt-dir detection (Aborted / RuntimeError → wipe + one retry) still runs.
 * Only the timeout resolves to undefined.
 */

/** Sentinel so a legitimately-undefined open is distinguishable from a timeout. */
const TIMED_OUT = Symbol("pglite-open-timeout");

/** Default ceiling for a PGlite open. Generous — a cold WASM + HNSW init is slow. */
export const DEFAULT_PG_OPEN_TIMEOUT_MS = 30_000;

/** Resolve the open timeout. 0 (or negative) disables the guard entirely. */
export function pgOpenTimeoutMs(): number {
  const raw = process.env.MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PG_OPEN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PG_OPEN_TIMEOUT_MS;
  return n;
}

/** A PGlite-ish handle we may need to dispose of after abandoning it. */
interface Closable {
  close?: () => Promise<unknown> | unknown;
}

/**
 * Race `open` against the configured timeout.
 *
 * Resolves to the opened value, or to undefined when the open outruns the
 * timeout (`onTimeout` fires first so the caller can log and flip its own
 * disabled state). Rejections propagate to the caller unchanged.
 */
export async function withOpenTimeout<T>(
  open: Promise<T>,
  onTimeout: (reason: string) => void,
  timeoutMs: number = pgOpenTimeoutMs(),
): Promise<T | undefined> {
  // Guard disabled — preserve the original unbounded behavior verbatim.
  if (timeoutMs <= 0) return open;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    // Never hold the process open on account of the guard itself.
    timer.unref?.();
  });

  try {
    // `open` is raced as-is so a rejection rejects the race — and therefore
    // this function — leaving the caller's corrupt-retry path intact.
    const winner = await Promise.race([open, expiry]);

    if (winner === TIMED_OUT) {
      // Disown the open. If it ever settles, close the instance so an orphaned
      // PGlite cannot keep the event loop alive or hold the dataDir lock.
      void open
        .then((late) => {
          try {
            void (late as Closable | undefined)?.close?.();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {
          /* the abandoned open failed on its own — nothing left to release */
        });
      onTimeout(`timed out after ${timeoutMs}ms`);
      return undefined;
    }
    return winner as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

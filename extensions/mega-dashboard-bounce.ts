/**
 * mega-dashboard-bounce.ts — VC0F stale-runner detection + bounce.
 *
 * Delegate of `mega-dashboard-cmds.ts` (kept under the extensions/ soft limit):
 * owns the once-per-process staleness gate and the pure
 * `bounceStaleRunnerIfAny` decision, which is the durable restart-on-upgrade
 * seam — after `pi update --extensions` replaces the on-disk package, the next
 * `session_start` probes the running dashboard, sees the version mismatch, and
 * kills + respawns the stale runner so it serves the current code.
 *
 * The function is dependency-injected so unit tests (VC0F C1–C3) can stub every
 * primitive; the production wiring (live discovery / version / kill) lives in
 * `mega-dashboard-cmds.ts` and is passed in. No network here — the localhost
 * HTTP probes live behind the injected `isServerRunning`/`serverVersion` deps
 * (already audited PREVENT-PI-004 in the parent file).
 */

/**
 * Once-per-process staleness gate (VC0F A2). After the FIRST successful probe
 * we skip re-probing on later /mega-dashboard invocations or session-start
 * events within the same extension process — the probe is cheap but the
 * kill+respawn it triggers is disruptive. Set regardless of outcome.
 */
let stalenessCheckedThisProcess = false;

/** Test-only seam: clear the once-per-process gate between unit tests. */
export function resetStalenessGateForTests(): void {
  stalenessCheckedThisProcess = false;
}

/** Injectables `bounceStaleRunnerIfAny` needs from the current repo's dashboard
 *  lifecycle. Injected so the unit tests (VC0F C1–C3) can stub each primitive
 *  independently. */
export interface BounceStaleDeps {
  /** Discover a live dashboard server for the current repo, or null. */
  isServerRunning(): Promise<{ port: number; url: string; hasPidFile: boolean } | null>;
  /** Version the running server reports via HTTP (/api/version), or null. */
  serverVersion(port: number): Promise<string | null>;
  /** Version stamped in the current repo's port.pid marker, or null. */
  markerVersion(): string | null;
  /** Version of THIS extension package (from its own package.json). */
  ownVersion(): string | null;
  /** Kill the server on `port` and clear its marker (best-effort). */
  killServerOnPort(port: number): void;
  /** User notification; a no-op on the silent session-start path (VC0F A3). */
  notify(message: string): void;
}

/**
 * Detect + replace a STALE dashboard runner for the current repo (VC0F A1).
 *
 * A runner is stale when it is an orphan (live but missing its port.pid
 * marker), when its marker's stamped `version` differs from this extension's
 * own version (VC0F B2 — avoids the HTTP probe), or when the version it
 * reports over HTTP differs from our own (fallback for pre-B2 servers whose
 * marker has no `version` field). A stale runner is killed so the next launch
 * serves the current on-disk code.
 *
 * Best-effort and non-fatal (Goal 4): any failure returns `{bounced:false}`
 * and never throws. Runs at most once per extension process (A2).
 */
export async function bounceStaleRunnerIfAny(deps: BounceStaleDeps): Promise<{ bounced: boolean }> {
  if (stalenessCheckedThisProcess) return { bounced: false };
  try {
    stalenessCheckedThisProcess = true; // once per process, regardless of outcome
    const info = await deps.isServerRunning();
    if (!info) return { bounced: false };
    const orphan = !info.hasPidFile;
    const want = deps.ownVersion();
    const marker = deps.markerVersion();
    let stale: boolean;
    let from: string | null = null;
    if (orphan) {
      stale = true; // live server with no marker → orphan by definition
    } else if (want != null && marker != null) {
      stale = marker !== want; // B2: compare the stamped marker, skip the HTTP probe
      from = marker;
    } else {
      const running = await deps.serverVersion(info.port);
      from = running;
      stale = want != null && running != null && running !== want;
    }
    if (stale) {
      deps.notify(
        orphan
          ? "[mega-compact] replacing orphaned dashboard server…"
          : `[mega-compact] replacing stale dashboard (${from ?? "?"} → ${want ?? "?"})…`,
      );
      deps.killServerOnPort(info.port);
      return { bounced: true };
    }
    return { bounced: false };
  } catch {
    // Best-effort, non-fatal — a failed probe/kill never breaks the caller.
    return { bounced: false };
  }
}

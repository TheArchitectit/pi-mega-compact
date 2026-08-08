/**
 * vector-cortex/livewire/livewire-registry.ts — per-stateDir LIWIRE registry.
 *
 * The single seam the runtime and the reader-only dashboard routes BOTH access.
 * It owns a `Map<stateDir, LivewireLiveState>` (one live subsystem cluster per
 * repo) and lazily opens a state on first access, rehydrating its cumulative
 * counters from the persisted aggregate snapshot (`livewire-snapshot.ts`) so a
 * freshly-spawned process — e.g. the dashboard server — reports the same counts
 * the runtime has already accumulated.
 *
 * The runtime WRITES through this registry (see `livewire-runtime.ts`): each
 * mutation persists a reduced, count-only snapshot. The routes READ through
 * `livewireOf(stateDir)` and call the pure `snapshotOf`. There is no other path.
 *
 * BEST-EFFORT + NON-FATAL. `openLivewire` never throws: persistence failures are
 * swallowed by the snapshot layer and state is always returned. PREVENT-PI-004
 * (local in-process Map + filesystem only), PREVENT-011 (no `any`).
 */

import type { LivewireSnapshot } from "./livewire-types.js";
import {
  createLiveState,
  rehydrateLive,
  snapshotOf,
  type LivewireLiveState,
} from "./livewire-live.js";
import {
  loadLivewireSnapshot,
  saveLivewireSnapshot,
} from "./livewire-snapshot.js";

/** The per-stateDir registry (process-local; a fresh process starts empty). */
const REGISTRY = new Map<string, LivewireLiveState>();

/** Optional structured logger for best-effort failure events. */
export type LivewireLogger = (line: unknown) => void;

let activeLogger: LivewireLogger | undefined;

/**
 * Bind the structured logger the snapshot layer uses for its non-fatal write
 * failures. The runtime calls this once at startup with its JSON logger.
 */
export function setLivewireLogger(logger: LivewireLogger | undefined): void {
  activeLogger = logger;
}

/**
 * Open (or return the cached) live state for a stateDir. Lazy: on first access
 * it rehydrates from the persisted aggregate so a separate dashboard process
 * reflects prior runtime work. Never throws.
 */
export function livewireOf(stateDir: string): LivewireLiveState {
  const cached = REGISTRY.get(stateDir);
  if (cached !== undefined) return cached;
  const state = createLiveState();
  const snap = loadLivewireSnapshot(stateDir);
  if (snap !== null) rehydrateLive(state, snap);
  REGISTRY.set(stateDir, state);
  return state;
}

/**
 * Persist a state's reduced aggregate (counts + codes only). Best-effort and
 * non-fatal. Called by the runtime after every mutation so the snapshot stays
 * fresh for any reader process.
 */
export function persistLivewire(state: LivewireLiveState, stateDir: string): void {
  saveLivewireSnapshot(stateDir, snapshotOf(state), activeLogger);
}

/** Persist the live state for a stateDir (convenience over open + persist). */
export function flushLivewire(stateDir: string): void {
  const state = REGISTRY.get(stateDir);
  if (state === undefined) return;
  persistLivewire(state, stateDir);
}

/**
 * Build the reader aggregate for one stateDir WITHOUT persisting — the reader
 * seam the dashboard routes call. Reads the live state (rehydrated from disk on
 * first access) and projects it to the count-only snapshot.
 */
export function readLivewireSnapshot(stateDir: string): LivewireSnapshot {
  return snapshotOf(livewireOf(stateDir));
}

/** For tests: drop the registry so a fresh stateDir is fully rehydrated. */
export function _resetLivewireRegistryForTests(): void {
  REGISTRY.clear();
}

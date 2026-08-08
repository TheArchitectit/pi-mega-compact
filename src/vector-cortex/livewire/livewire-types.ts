/**
 * vector-cortex/livewire/livewire-types.ts — LIVEWIRE aggregate snapshot types.
 *
 * LIVEWIRE wires the four complete-but-unwired Vector Cortex subsystems into the
 * runtime so their dashboard routes report LIVE state instead of hardcoded
 * "deferred" zeros. This module is the SINGLE SOURCE OF TRUTH for the persisted
 * aggregate snapshot shape (counts + codes ONLY) and for the per-stateDir
 * live-state records the routes read.
 *
 * SECURITY_PRIVACY: every field here is a count, a code, or a finite triad mode.
 * There is deliberately NO string slot for a session id, a request/crystal
 * digest, a covered range, frozen bytes, a profile id, or ledger content — a
 * crystal IS a frozen rendered prompt, so the card that reports on it must never
 * be able to carry one. The snapshot is the SAME reduced shape, so nothing secret
 * reaches disk either.
 *
 * PREVENT-PI-004: type definitions only, no network code. PREVENT-011: no `any`.
 */

/** Triad mode shared by the crystals / diagnostics / economics cards. */
export type LivewireMode = "A" | "B" | "C";

/** VC7A crystal aggregate — mirrors `CrystalStoreStats` one-for-one. */
export interface LivewireCrystalAggregate {
  readonly mode: LivewireMode;
  readonly crystalCount: number;
  readonly totalBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly hitBytes: number;
  readonly writes: number;
  readonly duplicateWrites: number;
  readonly collisions: number;
}

/** VC7C per-miss-class tallies + breaker observable state. */
export interface LivewireDiagnosticsAggregate {
  readonly profileMisses: number;
  readonly rangeMisses: number;
  readonly dependencyMisses: number;
  readonly requestMisses: number;
  readonly generationMisses: number;
  readonly unknownMisses: number;
  readonly serveBlocked: number;
  /** Breaker observable state name (CLOSED_A / OPEN_B / ... / MANUAL_HALT). */
  readonly breakerState: string;
  /** Last CACHE/M5 code, or null. */
  readonly lastFailure: string | null;
}

/** VC7B economics aggregate — static profile tallies + computed bit. */
export interface LivewireEconomicsAggregate {
  /** Provider profiles that declare cache economics. */
  readonly profileCount: number;
  /** Exclusions that carry a proving fixture id. */
  readonly provenExclusions: number;
  /** Exclusions rejected for lacking a fixture id. */
  readonly unprovenExclusions: number;
  /** True once the runtime has actually run `computeEconomics` at least once. */
  readonly computed: boolean;
  /** Last ECON_* code, or null. */
  readonly lastFailure: string | null;
}

/** VC8B shadow-policy aggregate — maps 1:1 to the policy card fields. */
export interface LivewirePolicyAggregate {
  readonly shadowDecisions: number;
  readonly clampedDecisions: number;
  readonly rejectedInputs: number;
  readonly liveMutations: number;
  /** Active pressure version (1 legacy / 2 migrated). */
  readonly pressureVersion: 1 | 2;
  /** Last POL_ or M7_ code, or null. */
  readonly lastFailure: string | null;
}

/** The persisted, restart-surviving aggregate for one stateDir. */
export interface LivewireSnapshot {
  readonly schema: "vector-cortex-livewire-v1";
  readonly crystals: LivewireCrystalAggregate;
  readonly diagnostics: LivewireDiagnosticsAggregate;
  readonly economics: LivewireEconomicsAggregate;
  readonly policy: LivewirePolicyAggregate;
}

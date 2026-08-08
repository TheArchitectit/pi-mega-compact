/**
 * vector-cortex/livewire/livewire-live.ts — LIVEWIRE in-process live state.
 *
 * Holds the LIVE subsystem objects for ONE stateDir: the VC7A `CrystalStore`,
 * the VC7C cache breaker, the per-miss-class tallies, the VC8B shadow metrics,
 * and the VC7B economics computed bit. This is the object the RUNTIME accumulates
 * into (`recordMiss`, `recordServeBlocked`, `recordShadowRun`, ...) and that the
 * reader-only dashboard routes snapshot out of. Kept separate from the registry
 * (which owns the per-stateDir `Map` + persistence) so neither file crosses the
 * 300-line soft-as-hard gate.
 *
 * AGGREGATE-FIRST, COUNTS ONLY. `snapshotOf` projects the live objects down to
 * the SECURITY_PRIVACY-safe `LivewireSnapshot` (counts + codes + triad mode) that
 * gets persisted and rendered. No session id, digest, range, profile id, bytes,
 * or prompt text can pass through ANY of these fields.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any`. Non-fatal: every derive is
 * a pure read.
 */

import { CrystalStore } from "../cache/store.js";
import { createCacheBreaker } from "../cache/breaker.js";
import type { MissClass } from "../cache/diagnostics-types.js";
import { validateProfileEconomics } from "../provider/economics.js";
import { BASE_PROVIDER_PROFILES } from "../provider/registry.js";
import type {
  LivewireDiagnosticsAggregate,
  LivewireEconomicsAggregate,
  LivewirePolicyAggregate,
  LivewireSnapshot,
} from "./livewire-types.js";

/** One VC7C miss classification tally (in-process, counts only). */
export interface LivewireDiagnosticsRecord {
  readonly tallies: { [K in MissClass]: number };
  serveBlocked: number;
  /**
   * Observable breaker state (CLOSED_A / OPEN_B / ... / MANUAL_HALT). Tracked as
   * a field so it survives process restart: the runtime syncs it from the live
   * breaker when persisting, and a reader process restores it from the snapshot
   * (a fresh in-process breaker is always CLOSED_A, which would be misleading).
   */
  breakerState: string;
  lastFailure: string | null;
}

/** One VC7B economics record (computed bit + profile tallies + last failure). */
export interface LivewireEconomicsRecord {
  computed: boolean;
  /** Provider profiles that declare cache economics (static from BASE_PROFILES). */
  profileCount: number;
  /** Exclusions that carry a proving fixture id (static from BASE_PROFILES). */
  provenExclusions: number;
  /** Exclusions rejected for lacking a fixture id (static from BASE_PROFILES). */
  unprovenExclusions: number;
  lastFailure: string | null;
}

/**
 * Static VC7B economics profile tallies derived from the base provider registry.
 * `profileCount` counts profiles that declare economics; `provenExclusions` /
 * `unprovenExclusions` tally the exclusion sets validated against the fixture
 * rule. This is PURE (no storage/clock/network) and identical regardless of the
 * `MEGACOMPACT_VC7B` flag — only the emission/route seam is flag-gated.
 */
function baseEconomicsTallies(): {
  profileCount: number;
  provenExclusions: number;
  unprovenExclusions: number;
} {
  let profileCount = 0;
  let provenExclusions = 0;
  let unprovenExclusions = 0;
  for (const bundle of BASE_PROVIDER_PROFILES) {
    const econ = bundle.profile.economics;
    if (econ === null) continue;
    profileCount += 1;
    const codes = validateProfileEconomics(bundle.profile, econ);
    const failed = new Set(codes);
    for (const _ex of bundle.profile.excludedJsonPointers) {
      if (failed.has("ECON_EXCLUSION_UNPROVEN")) {
        unprovenExclusions += 1;
      } else {
        provenExclusions += 1;
      }
    }
  }
  return { profileCount, provenExclusions, unprovenExclusions };
}

/** One VC8B shadow-policy record (metrics + active pressure version). */
export interface LivewireShadowRecord {
  shadowDecisions: number;
  clampedDecisions: number;
  rejectedInputs: number;
  liveMutations: number;
  pressureVersion: 1 | 2;
  lastFailure: string | null;
}

/** The live, in-process state for one stateDir. */
export interface LivewireLiveState {
  readonly crystalStore: CrystalStore;
  readonly breaker: ReturnType<typeof createCacheBreaker>;
  readonly diagnostics: LivewireDiagnosticsRecord;
  readonly economics: LivewireEconomicsRecord;
  readonly shadow: LivewireShadowRecord;
}

/** A zeroed per-class tally map. */
function zeroTallies(): LivewireDiagnosticsRecord["tallies"] {
  return {
    profile: 0,
    range: 0,
    dependency: 0,
    request: 0,
    generation: 0,
    unknown: 0,
  };
}

/** Build a fresh (empty) live state with real subsystem objects. */
export function createLiveState(): LivewireLiveState {
  const econTallies = baseEconomicsTallies();
  return {
    crystalStore: new CrystalStore(),
    breaker: createCacheBreaker(),
    diagnostics: {
      tallies: zeroTallies(),
      serveBlocked: 0,
      breakerState: "CLOSED_A",
      lastFailure: null,
    },
    economics: {
      computed: false,
      profileCount: econTallies.profileCount,
      provenExclusions: econTallies.provenExclusions,
      unprovenExclusions: econTallies.unprovenExclusions,
      lastFailure: null,
    },
    shadow: {
      shadowDecisions: 0,
      clampedDecisions: 0,
      rejectedInputs: 0,
      liveMutations: 0,
      pressureVersion: 1,
      lastFailure: null,
    },
  };
}

/** Project the live state down to the persisted, reader-only aggregate. */
export function snapshotOf(state: LivewireLiveState): LivewireSnapshot {
  const crystals = state.crystalStore.stats();
  const diag: LivewireDiagnosticsAggregate = {
    profileMisses: state.diagnostics.tallies.profile,
    rangeMisses: state.diagnostics.tallies.range,
    dependencyMisses: state.diagnostics.tallies.dependency,
    requestMisses: state.diagnostics.tallies.request,
    generationMisses: state.diagnostics.tallies.generation,
    unknownMisses: state.diagnostics.tallies.unknown,
    serveBlocked: state.diagnostics.serveBlocked,
    breakerState: state.diagnostics.breakerState,
    lastFailure: state.diagnostics.lastFailure,
  };
  const econ: LivewireEconomicsAggregate = {
    profileCount: state.economics.profileCount,
    provenExclusions: state.economics.provenExclusions,
    unprovenExclusions: state.economics.unprovenExclusions,
    computed: state.economics.computed,
    lastFailure: state.economics.lastFailure,
  };
  const policy: LivewirePolicyAggregate = {
    shadowDecisions: state.shadow.shadowDecisions,
    clampedDecisions: state.shadow.clampedDecisions,
    rejectedInputs: state.shadow.rejectedInputs,
    liveMutations: state.shadow.liveMutations,
    pressureVersion: state.shadow.pressureVersion,
    lastFailure: state.shadow.lastFailure,
  };
  return {
    schema: "vector-cortex-livewire-v1",
    crystals: {
      mode: crystals.mode,
      crystalCount: crystals.crystalCount,
      totalBytes: crystals.totalBytes,
      hits: crystals.hits,
      misses: crystals.misses,
      hitBytes: crystals.hitBytes,
      writes: crystals.writes,
      duplicateWrites: crystals.duplicateWrites,
      collisions: crystals.collisions,
    },
    diagnostics: diag,
    economics: econ,
    policy,
  };
}

/** Seed a fresh live state's CUMULATIVE counters from a persisted snapshot. */
export function rehydrateLive(state: LivewireLiveState, snap: LivewireSnapshot): void {
  state.crystalStore.rehydrate(snap.crystals);
  state.diagnostics.tallies.profile = snap.diagnostics.profileMisses;
  state.diagnostics.tallies.range = snap.diagnostics.rangeMisses;
  state.diagnostics.tallies.dependency = snap.diagnostics.dependencyMisses;
  state.diagnostics.tallies.request = snap.diagnostics.requestMisses;
  state.diagnostics.tallies.generation = snap.diagnostics.generationMisses;
  state.diagnostics.tallies.unknown = snap.diagnostics.unknownMisses;
  state.diagnostics.serveBlocked = snap.diagnostics.serveBlocked;
  state.diagnostics.breakerState = snap.diagnostics.breakerState;
  state.diagnostics.lastFailure = snap.diagnostics.lastFailure;
  state.economics.computed = snap.economics.computed;
  state.economics.profileCount = snap.economics.profileCount;
  state.economics.provenExclusions = snap.economics.provenExclusions;
  state.economics.unprovenExclusions = snap.economics.unprovenExclusions;
  state.economics.lastFailure = snap.economics.lastFailure;
  state.shadow.shadowDecisions = snap.policy.shadowDecisions;
  state.shadow.clampedDecisions = snap.policy.clampedDecisions;
  state.shadow.rejectedInputs = snap.policy.rejectedInputs;
  state.shadow.liveMutations = snap.policy.liveMutations;
  state.shadow.pressureVersion = snap.policy.pressureVersion;
  state.shadow.lastFailure = snap.policy.lastFailure;
}

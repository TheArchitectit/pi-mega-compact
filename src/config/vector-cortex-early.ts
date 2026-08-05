/**
 * config/vector-cortex-early.ts — VC0/VC1/VC2 phase sprint flags.
 *
 * Extracted from vector-cortex.ts to keep that file under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-breakers.ts was. These are
 * the FOUNDATION-phase flags (observability, ledger, conformance, encoder); the
 * VC3+ derived-state and prompt-path flags stay in vector-cortex.ts alongside
 * the shared `sprintFlag` reader they are documented against.
 *
 * The split is purely mechanical: every flag below is byte-identical in name,
 * semantics, and default to its previous definition, and vector-cortex.ts
 * re-exports all of them so no consumer import path changes.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/** VC0A — baseline observability (MetricEventV1 / AnnotationV1). Default ON. */
export const VC0A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0A");

/**
 * VC0B — replay correctness (ReplayCutV2 / ReplayReportV2, M3 effective-cut-v2).
 * Default ON. `MEGACOMPACT_VC0B=0` disables and is byte-identical to the
 * predecessor (legacy capped-replay behavior preserved; the v2 cut/replay is
 * only consulted on the vector-cortex path).
 */
export const VC0B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0B");

/**
 * VC1A — canonical byte events (EventV2 / EventCodec).
 * Default ON. `MEGACOMPACT_VC1A=0` disables and is byte-identical to the
 * predecessor (mode C: ledger absent, current transcript codec unchanged).
 * The single real consumer is the ledger emit seam (`ledger/emit.ts`): flag OFF
 * gates zero observability writes.
 */
export const VC1A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1A");

/**
 * VC1B — occurrence ledger + tool identity + compat journal (LedgerReader/
 * Writer/Admin, CompatJournalV1, M2 occurrence-v2 migration).
 * Default ON. `MEGACOMPACT_VC1B=0` disables and is byte-identical to the
 * predecessor (mode C: the neutral occurrence ledger is not written, no
 * journal rows, zero `vector_cortex_occurrence_appended` emissions). The real
 * consumers are the ledger write integration seam and the compat-journal
 * switch seam.
 */
export const VC1B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1B");

/**
 * VC0C — live safety envelope (TriadResult / Breaker / KillDecision + durable
 * spool). Default ON. `MEGACOMPACT_VC0C=0` disables and is byte-identical to
 * the predecessor (mode C: selected before provider invocation, unchanged host
 * transcript, breaker/spool idle and emitting nothing). The single real
 * consumer is the resilience emit seam + the safety adapter's triad selection.
 */
export const VC0C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0C");

/**
 * VC1C — cross-language conformance v2 (FixtureManifestV2 / DowngradeReport /
 * MinHashV2 + M4 minhash-v2 migration).
 * Default ON. `MEGACOMPACT_VC1C=0` disables and is byte-identical to the
 * predecessor (mode C: a v2 conformance runner that accepts authority fixtures
 * and the manifest validator idle; the sync dedup scan stays on the v1 path;
 * zero `vector_cortex_*` VC1C emissions). The real consumers are the conformance
 * emit seam, the minhash-v2 backfill seam and the downgrade-export seam.
 */
export const VC1C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1C");

/**
 * VC2A — offline model runtime and asset decision (ModelManifestV1 /
 * EncoderRuntime).
 * Default ON. `MEGACOMPACT_VC2A=0` disables and is byte-identical to the
 * predecessor (mode C: no asset manifest is read/verified, the encoder runtime
 * idles in mode C, zero `vector_cortex_encoder_*` emissions; the trigram/lexical
 * paths are unchanged). The real consumers are the encoder emit seam and the
 * encoder runtime's A/B/C selection.
 */
export const VC2A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC2A");

/**
 * VC2B — multi-head encoder (VectorSetV1 / HeadCalibrationDraft).
 * Default ON. `MEGACOMPACT_VC2B=0` disables and is byte-identical to the
 * predecessor (the encoder emits no per-head vectors and no fallback-selected
 * event; the trigram/lexical paths themselves are unchanged and are the
 * predecessor's mode-B/C producers). The real consumers are the encoder-heads
 * emit seam and the multi-head encoder producers (heads/trigram/lexical).
 */
export const VC2B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC2B");

/**
 * VC2C — encoder qualification + calibration (QualifiedEncoderV1 / CalibrationV1).
 * Default ON. `MEGACOMPACT_VC2C=0` disables and is byte-identical to the
 * predecessor (mode C: no qualification manifest is read or selected, the
 * calibrate/select/fallback seams are idle, zero `vector_cortex_encoder_qualification_*`
 * emissions; the trigram/lexical paths are unchanged). The real consumers are
 * the encoder-qualification emit seam and the calibrate/select seams.
 */
export const VC2C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC2C");

// VC0B replay/migration fixtures CUT-001..020 and M3-001..010.
// Owner VC0B: ReplayCutV2 min-of-three + pair retreat + anchor floor, and the
// M3 effective-cut-v2 copy/validate/switch migration (see
// src/vector-cortex/replay/types.ts). seqs are integers in the envelope; the
// acceptance test converts to bigint.

import { producer } from "./common.mjs";

const REPLAY_SCHEMA = "schemas/replay-fixture.schema.json";

function cutFixture(id, assertion, input, expected) {
  return { id, schema: REPLAY_SCHEMA, producer, assertion, kind: "cut", input, expected };
}

function migrationFixture(id, assertion, input, expected) {
  return { id, schema: REPLAY_SCHEMA, producer, assertion, kind: "migration", input, expected };
}

// CUT-001 = CUT-PAIR-001: requested cut between call c7 and result r7 retreats
// before c7 (retreat to call boundary => call-1).
const cut001 = cutFixture(
  "CUT-001",
  "CUT-PAIR-001: requested cut between call c7 and result r7 retreats before c7",
  {
    requestedSeq: 8,
    boundarySafeSeq: 8,
    committedSeq: 9,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [{ callSeq: 7, resultSeq: 9 }],
  },
  { ok: true, effectiveSeq: 6, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-002 = CUT-ANCHOR-002: a pair retreat lands on the legal anchor floor and
// never crosses it; effective >= floor.
const cut002 = cutFixture(
  "CUT-002",
  "CUT-ANCHOR-002: retreat cannot cross the recent-anchor floor",
  {
    requestedSeq: 9,
    boundarySafeSeq: 9,
    committedSeq: 8,
    capturedHighWater: 7,
    anchorFloor: 5,
    pairs: [{ callSeq: 6, resultSeq: 8 }],
  },
  { ok: true, effectiveSeq: 5, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"], anchorFloorRespected: true },
);

// CUT-003 = CUT-HIGHWATER-003: captured high-water below committed seq wins.
const cut003 = cutFixture(
  "CUT-003",
  "CUT-HIGHWATER-003: captured high-water below committed seq wins",
  {
    requestedSeq: 10,
    boundarySafeSeq: 10,
    committedSeq: 9,
    capturedHighWater: 4,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: [] },
);

// CUT-004: committed is a unique min; no pair and no retreat.
const cut004 = cutFixture(
  "CUT-004",
  "committed unique min with no pairs; no retreat",
  {
    requestedSeq: 12,
    boundarySafeSeq: 12,
    committedSeq: 5,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 5, retreatCodes: [] },
);

// CUT-005: committed is the unique min; no pairs.
const cut005 = cutFixture(
  "CUT-005",
  "committed seq is the unique min; no retreat",
  {
    requestedSeq: 20,
    boundarySafeSeq: 20,
    committedSeq: 3,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 3, retreatCodes: [] },
);

// CUT-006: requestedSeq caps the cut when every source exceeds it.
const cut006 = cutFixture(
  "CUT-006",
  "requestedSeq caps the cut when every source exceeds it",
  {
    requestedSeq: 6,
    boundarySafeSeq: 30,
    committedSeq: 40,
    capturedHighWater: 50,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 6, retreatCodes: [] },
);

// CUT-007: two sources tie at the min; lower source order (committed) wins.
const cut007 = cutFixture(
  "CUT-007",
  "equal committed and captured minima; lower source order wins (CUT_LOWEST_SOURCE_ORDER)",
  {
    requestedSeq: 20,
    boundarySafeSeq: 20,
    committedSeq: 5,
    capturedHighWater: 5,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 5, retreatCodes: ["CUT_LOWEST_SOURCE_ORDER"] },
);

// CUT-008: balanced stream, contiguous cuts with no pairs (cut at even seq).
const cut008 = cutFixture(
  "CUT-008",
  "balanced contiguous stream with no pairs; cut honours the min",
  {
    requestedSeq: 100,
    boundarySafeSeq: 100,
    committedSeq: 50,
    capturedHighWater: 60,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 50, retreatCodes: [] },
);

// CUT-009: retreat across a pair to call-1 when committed is inside the pair.
const cut009 = cutFixture(
  "CUT-009",
  "committed lands inside a pair; retreats to call boundary",
  {
    requestedSeq: 16,
    boundarySafeSeq: 16,
    committedSeq: 13,
    capturedHighWater: 14,
    anchorFloor: 0,
    pairs: [{ callSeq: 12, resultSeq: 15 }],
  },
  { ok: true, effectiveSeq: 11, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-010: anchor floor is above the min; floor wins (CUT_ANCHOR_FLOOR).
const cut010 = cutFixture(
  "CUT-010",
  "anchor floor above the min cap; the cut rises to the floor",
  {
    requestedSeq: 10,
    boundarySafeSeq: 5,
    committedSeq: 3,
    capturedHighWater: 2,
    anchorFloor: 4,
    pairs: [],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: ["CUT_ANCHOR_FLOOR"] },
);

// CUT-011: pair retreat target stays above the anchor floor (no crossing).
const cut011 = cutFixture(
  "CUT-011",
  "pair retreat target lands above the anchor floor (no crossing)",
  {
    requestedSeq: 12,
    boundarySafeSeq: 12,
    committedSeq: 10,
    capturedHighWater: 9,
    anchorFloor: 5,
    pairs: [{ callSeq: 8, resultSeq: 11 }],
  },
  { ok: true, effectiveSeq: 7, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"], anchorFloorRespected: true },
);

// CUT-012: three distinct sources, boundary is smallest; boundary wins.
const cut012 = cutFixture(
  "CUT-012",
  "boundary-safe seq is the unique min; wins",
  {
    requestedSeq: 30,
    boundarySafeSeq: 2,
    committedSeq: 25,
    capturedHighWater: 28,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 2, retreatCodes: [] },
);

// CUT-013: no pairs, boundary is min, cut at boundary.
const cut013 = cutFixture(
  "CUT-013",
  "boundary-safe seq is min with no pairs; cut at it",
  {
    requestedSeq: 40,
    boundarySafeSeq: 7,
    committedSeq: 9,
    capturedHighWater: 8,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 7, retreatCodes: [] },
);

// CUT-014: multi-pair balanced stream; committed mid-window retreats past one pair.
const cut014 = cutFixture(
  "CUT-014",
  "cut inside a later pair retreats to the call boundary of that pair",
  {
    requestedSeq: 30,
    boundarySafeSeq: 30,
    committedSeq: 22,
    capturedHighWater: 24,
    anchorFloor: 0,
    pairs: [
      { callSeq: 10, resultSeq: 12 },
      { callSeq: 20, resultSeq: 25 },
    ],
  },
  { ok: true, effectiveSeq: 19, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-015: captured high-water inside a pair retreats to call boundary.
const cut015 = cutFixture(
  "CUT-015",
  "captured high-water inside a pair retreats to call boundary",
  {
    requestedSeq: 18,
    boundarySafeSeq: 18,
    committedSeq: 16,
    capturedHighWater: 14,
    anchorFloor: 0,
    pairs: [{ callSeq: 13, resultSeq: 17 }],
  },
  { ok: true, effectiveSeq: 12, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-016: requested cut inside a pair, boundary/commit/capture all above the call.
const cut016 = cutFixture(
  "CUT-016",
  "requested cut inside a pair retreats before the call",
  {
    requestedSeq: 9,
    boundarySafeSeq: 30,
    committedSeq: 30,
    capturedHighWater: 30,
    anchorFloor: 0,
    pairs: [{ callSeq: 8, resultSeq: 11 }],
  },
  { ok: true, effectiveSeq: 7, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-017: lower source order tie-break among committed+captured below boundary.
const cut017 = cutFixture(
  "CUT-017",
  "tie at committed and captured below boundary; lower source order wins",
  {
    requestedSeq: 25,
    boundarySafeSeq: 25,
    committedSeq: 6,
    capturedHighWater: 6,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 6, retreatCodes: ["CUT_LOWEST_SOURCE_ORDER"] },
);

// CUT-018: boundary is a legal pair-safe point and is the min; no retreat.
const cut018 = cutFixture(
  "CUT-018",
  "boundary min is pair-safe; no retreat",
  {
    requestedSeq: 15,
    boundarySafeSeq: 4,
    committedSeq: 6,
    capturedHighWater: 5,
    anchorFloor: 0,
    pairs: [{ callSeq: 5, resultSeq: 8 }],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: [] },
);

// CUT-019: min lands exactly on the call; pair split forces retreat before the call.
const cut019 = cutFixture(
  "CUT-019",
  "min lands exactly on the call; pair split forces retreat before the call",
  {
    requestedSeq: 10,
    boundarySafeSeq: 10,
    committedSeq: 5,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [{ callSeq: 5, resultSeq: 7 }],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-020: all three minima tie at a pair-safe value below requested; effective.
const cut020 = cutFixture(
  "CUT-020",
  "all three minima tie; cut at the shared pair-safe value",
  {
    requestedSeq: 20,
    boundarySafeSeq: 8,
    committedSeq: 8,
    capturedHighWater: 8,
    anchorFloor: 0,
    pairs: [{ callSeq: 3, resultSeq: 6 }],
  },
  { ok: true, effectiveSeq: 8, retreatCodes: ["CUT_LOWEST_SOURCE_ORDER"] },
);

// M3-001: full copy/validate/switch succeeds; new pointer activates.
const m3_001 = migrationFixture(
  "M3-001",
  "M3 copy/validate/switch activates the new effective cut",
  {
    host: { oldPointer: 0, stagedPointer: null, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 5, switched: true },
);

// M3-002: crash after validate, before switch retains the OLD pointer.
const m3_002 = migrationFixture(
  "M3-002",
  "M3 crash after copy/validate but before switch keeps the old pointer",
  {
    host: { oldPointer: 3, stagedPointer: 5, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 5, switched: false, retainedPointer: 3 },
);

// M3-003: resume after interrupted switch is idempotent (same result twice).
const m3_003 = migrationFixture(
  "M3-003",
  "M3 resume after interruption is idempotent",
  {
    host: { oldPointer: 1, stagedPointer: 5, active: "new" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 5, switched: true, idempotentResume: true },
);

// M3-004: invalid minima (staged effective > committed) -> M3_MINIMA_VIOLATED.
const m3_004 = migrationFixture(
  "M3-004",
  "M3 validation rejects an effective cut above a source minimum",
  {
    host: { oldPointer: 0, stagedPointer: 7, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: false, code: "M3_MINIMA_VIOLATED" },
);

// M3-005: staged pointer inside a pair -> M3_PAIR_SPLIT on validation.
const m3_005 = migrationFixture(
  "M3-005",
  "M3 validation rejects an effective cut splitting a tool pair",
  {
    host: { oldPointer: 0, stagedPointer: 4, active: "old" },
    cut: { requestedSeq: 6, boundarySafeSeq: 6, committedSeq: 4, capturedHighWater: 4, anchorFloor: 0, pairs: [{ callSeq: 3, resultSeq: 5 }] },
  },
  { ok: false, code: "M3_PAIR_SPLIT" },
);

// M3-006: staged pointer below the anchor floor -> M3_ANCHOR_CROSSED.
const m3_006 = migrationFixture(
  "M3-006",
  "M3 validation rejects an effective cut below the anchor floor",
  {
    host: { oldPointer: 0, stagedPointer: 1, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 1, capturedHighWater: 1, anchorFloor: 4, pairs: [] },
  },
  { ok: false, code: "M3_ANCHOR_CROSSED" },
);

// M3-007: staged pointer mismatch vs computed -> M3_COPY_MISMATCH.
const m3_007 = migrationFixture(
  "M3-007",
  "M3 validation rejects staged/effective mismatch (copy must not drift)",
  {
    host: { oldPointer: 0, stagedPointer: 9, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: false, code: "M3_COPY_MISMATCH", effectiveSeq: 5 },
);

// M3-008: missing host pointer -> M3_HOST_MISSING.
const m3_008 = migrationFixture(
  "M3-008",
  "M3 validation rejects a missing host pointer",
  {
    host: { oldPointer: 0, stagedPointer: null, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: false, code: "M3_HOST_MISSING" },
);

// M3-009: pair retreat bounded by floor keeps migration valid on resume.
const m3_009 = migrationFixture(
  "M3-009",
  "M3 pair retreat bounded by anchor floor produces a valid resumed cut",
  {
    host: { oldPointer: 1, stagedPointer: 5, active: "old" },
    cut: { requestedSeq: 20, boundarySafeSeq: 20, committedSeq: 18, capturedHighWater: 17, anchorFloor: 5, pairs: [{ callSeq: 14, resultSeq: 19 }] },
  },
  { ok: true, effectiveSeq: 13, switched: true, anchorFloorRespected: true },
);

// M3-010: captured high-water below committed freezes the migration cut.
const m3_010 = migrationFixture(
  "M3-010",
  "M3 captures a frozen high-water below committed; high-water wins",
  {
    host: { oldPointer: 0, stagedPointer: null, active: "old" },
    cut: { requestedSeq: 30, boundarySafeSeq: 30, committedSeq: 28, capturedHighWater: 9, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 9, switched: true, highWaterFrozen: true },
);

export const fixtures = [
  cut001, cut002, cut003, cut004, cut005, cut006, cut007, cut008, cut009, cut010,
  cut011, cut012, cut013, cut014, cut015, cut016, cut017, cut018, cut019, cut020,
  m3_001, m3_002, m3_003, m3_004, m3_005, m3_006, m3_007, m3_008, m3_009, m3_010,
];

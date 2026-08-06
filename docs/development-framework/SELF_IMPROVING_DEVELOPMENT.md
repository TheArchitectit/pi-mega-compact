# Self-Improving Development Framework

**Last updated:** 2026-08-05
**Status:** proposed
**Depends on:** docs/audits/2026-08-05-stub-gate-mock-audit.md
**Feeds:** docs/AGENT_GUARDRAILS.md, .guardrails/prevention-rules/pattern-rules.json

This is the meta-plan companion to the [2026-08-05 stub / hard-gate / mock-data audit](../audits/2026-08-05-stub-gate-mock-audit.md).
It converts **each defect class** the audit exposed into (a) a proposed guardrails rule, (b) an
enforceable scanner or CI gate, (c) a spec/process convention, and (d) a feedback loop so the same
class never recurs. It is the "self-improving" half of the audit: the template the user asked for,
to be folded into the overall development framework and the guardrails template.

> **Scope of this task:** this document is **the plan only**. It does NOT edit
> `AGENT_GUARDRAILS.md`, `INDEX_MAP.md`, `.guardrails/prevention-rules/pattern-rules.json`, or any
> `.mjs` scanner. Every code/scanner/guardrails edit called out here lands in the **CONFORM-HYGIENE**
> sprint (see §6) and the ML5 / VC6C closures. Wherever this doc references a concrete file edit, it
> is a proposed change queued for that sprint, not a change made here.

---

## 1. Why

The audit found **8 genuine code stubs**, **5 mock/fake/synthetic-data sites**, **5 open hard gates plus
2 manifest items missing HG IDs**, **4 conformance gaps**, and **~37 documentation/organization gaps**
(Table 5) — all landed and reached production paths. The single root cause, across every class:

> Work was allowed to land as a placeholder, stub, or mock with **no registry, no SLA, and no scanner**.
> Evidence/spec arithmetic drifted because numbers were **hand-maintained** (PC-D: 795→811 fixtures,
> `EXPECTED_SPRINTS` 36→37) instead of computed from the manifest. Hard-gate items lived in **prose**
> (`vc2-model-prep.md` §6 items 6/7) where the Setup Cortex blockers manifest could not see them.

Nothing in the current gate (`guardrails-scan.mjs` + `regression_check.py`) scans for "this function
is a stub", "this number is a literal not a computation", or "this gate has no HG ID". The gap is not
bad engineering intent — it is **absence of instrumentation around intentional placeholder work**. This
framework closes that absence.

---

## 2. Defect class → control matrix (THE CORE TABLE)

One row per defect class from the audit. Every row maps a defect to a rule, a scanner/CI gate, a
spec convention, and a feedback loop. Rule IDs use the project's PREVENT-* numbering approach but in
a proposed new domain — **STUB / MOCK / HYGIENE** — which become new entries in
`.guardrails/prevention-rules/pattern-rules.json` and new patterns in `scripts/guardrails-scan.mjs`.
All are marked **proposed — lands in the CONFORM-HYGIENE sprint** (with the ML5/VC6C rows closed by
their existing closures).

| # | Defect (from audit) | Example (file:line) | Proposed rule ID | Detection (scanner / CI) | Prevention (spec convention) | Feedback loop (self-correction) |
|---|---|---|---|---|---|---|
| 1 | Bearer placeholder asset committed and shipped as the Mode-A asset | `scripts/vector-cortex-gen-assets.mjs` → 42-byte `model.onnx` (`vc2-model-prep.md:152`, audit Table 1 row 7) | **PREVENT-PLACEHOLDER-001** *(error)* | `stub-scan.mjs` flags placeholder in a **committed asset path** not in a `Registered placeholders` table | Registered placeholders table requires `closure-sprint:` on every shipped placeholder asset | Asset manifest digest check bumps at ML5-A; an asset outside the registry = hard fail |
| 2 | Runtime stub with no registered closure plan | `src/vector-cortex/encoder/runtime.ts:107`, `heads.ts:11,48` (audit Table 1 rows 1–3) | **PREVENT-STUB-001** *(error)* | `stub-scan.mjs` flags in `src/`+`extensions/` UNLESS a `guardrails-allow PREVENT-STUB-001: <closure sprint id>` exists | Sprint spec declares every stub in the Registered placeholders table | Allow reference *must* name a real closure sprint; ML5-A verifies the stub is gone; a closure that slips = new finding |
| 3 | Mock/fake data in production paths presented as real | FNV-1a TrigramEmbedder default `src/embedder.ts:52-59,118-134,154`; LCG temps `calibrate.ts:88-111`; mulberry32 `dedup/raptor/kmeans.ts:15-25` (audit Table 2) | **PREVENT-MOCK-001** *(error)* | `mock-scan.mjs` flags `Math.random()`/seeded PRNG + hash-as-embedding markers outside tests | Known-accuracy floor MUST be documented; never silently semantic (embedder) | Allow requires `<reason — accuracy-floor acknowledged>`; mode-B documented as floor, not semantic |
| 4 | Verification-skip sentinel silently disables a real check | digest `"0"` in `reconstruct/validate.ts:65` + `_acceptance-helpers.ts:342`; `commit: "0".repeat(40)` in `_cross-language-fixture.ts:72` (audit Table 2 rows 4–5) | **PREVENT-VERIFICATION-BYPASS-001** *(critical)* | `stub-scan.mjs` flags `"0".repeat(`, `digest === "0"`, `?? "0"` in non-test code | Header "no mocks, no stubs" claim is a hard contract; sentinels require explicit fixture marker | CONFORM-HYGIENE fixes both sentinels; a new one without marker = hard fail |
| 5 | Spec arithmetic hand-maintained → drift | PC-D: spec "36 sprints / 795 fixtures", actual 37 / 811+4=815 (`evidence/PC-D.md:16`, audit Table 5-B) | **PREVENT-SPEC-DRIFT-001** *(error)* | `vector-cortex-docs-check.mjs` COMPUTES counts from manifest + sprints glob at check time | Evidence arithmetic generated, never literal; required `SpecDrift` note on every evidence record | Manifest is single source; a literal count that diverges = check fail at sprint exit |
| 6 | Spec/implementation status contradiction | VC6C: spec "Status: next"/unimplemented BUT evidence "implementer-complete" unattested (`sprints/VC6C-…md:3` vs `evidence/VC6C.md:3,5`, audit Table 5-A) | **PREVENT-EVIDENCE-DISRUPT-001** *(critical)* | evidence-attestation-check.mjs fails if "implemented" without reviewer attestation; status lint rejects spec-next ↔ evidence-complete | Attestation SLA: reviewer-acceptance, not implementer green, before status elevation | VC6C-impl reconciles; systemic: gate = reviewer attestation |
| 7 | Hard-gate items outside the blockers manifest | `vc2-model-prep.md:240-241` §6 items 6 (4-threads) & 7 (model-card/dataset/calibration) have no HG ID (audit Table 3) | **PREVENT-GATE-VISIBILITY-001** *(critical)* | `vector-cortex-evidence-check.mjs` asserts every OPEN gate carries an HG ID present in `setup-cortex-blockers.ts` | Blockers manifest is the ONLY source of truth; prose items must reference HG IDs | HG-6/HG-7 assigned in CONFORM-HYGIENE; an OPEN gate invisible to the manifest = fail |
| 8 | Unassigned future-scope rows with no owner/sprint | game-mode GM-B/GM-C/GM-D — cited plan file does not exist (audit Table 6) | **PREVENT-ORPHAN-SCOPE-001** *(error)* | `vector-cortex-docs-check.mjs` (grep `Future scope`/`unassigned`) flags rows lacking owner+phase | Every future-scope row must name a sprint or explicit transfer; no dangling prose | CONFORM-HYGIENE disposes GM-B/C/D (spec or transfer, traceable decision) |

All eight rules are **proposed** — they land as entries in `pattern-rules.json` + scanner patterns in
the CONFORM-HYGIENE sprint (with rule 2's sites already closed by ML5-A and rule 6's by VC6C-impl).

---

## 3. Detection — proposed scanners

Each scanner is proposed for CONFORM-HYGIENE. They share the existing `// guardrails-allow <RULE>: <reason>`
inline-annotation escape hatch and the `pattern-rules.json` severity/file_glob convention.

### 3.1 `scripts/stub-scan.mjs` — PREVENT-STUB-001 context

- **What it greps/parses:** in `src/` + `extensions/` production (non-test) code, flags: `stub`,
  `placeholder`, `TODO`, `FIXME`, `not implemented`, `future sprint`, LCG/PRNG constants
  (`1664525`, `1013904223`, `mulberry32`), `"0".repeat(`, `digest === "0"`, `?? "0"`.
- **Severity:** error.
- **Escape hatch (SUPERSEDED refusal):** `// guardrails-allow PREVENT-STUB-001: <closure sprint id>`.
  The allow **must reference the closure sprint** (e.g. `ML5-A`); a bare allow with no sprint id = fail.
  This is what turns a stub-allow into a tracked debt, not a permanent carve-out.

### 3.2 `scripts/mock-scan.mjs` — PREVENT-MOCK-001 context

- **What it greps/parses:** `Math.random()` / seeded PRNG use outside tests; hash-functions used as
  embeddings (djb2/fnv1a markers in `src/embedder.ts`); hardcoded metric tables returned as
  measurements.
- **Severity:** error.
- **Escape hatch:** `// guardrails-allow PREVENT-MOCK-001: <reason — accuracy-floor acknowledged>`.
  The *reason must acknowledge the accuracy floor* (e.g. "Mode-B hash-bag IS the documented floor"),
  so a mock can never be silently presented as semantic.

### 3.3 `vector-cortex-evidence-check.mjs` (extend, or new `evidence-attestation-check.mjs`)

- **What it greps/parses:** crosses spec `Status:` against evidence status for every sprint.
- **Fails when:** a sprint is "implemented" past **N days without reviewer attestation**, OR spec
  "Status: next" coexists with evidence "implementer-complete" (the VC6C contradiction, Table 5-A).
- **Severity:** critical (attestation-gap) / error (status-contradiction).
- **Escape hatch:** `// guardrails-allow PREVENT-EVIDENCE-DISRUPT-001: <SLA waiver reason>`.

### 3.4 `vector-cortex-docs-check.mjs` (extend) — PREVENT-SPEC-DRIFT-001

- **What it greps/parses:** `EXPECTED_SPRINTS` and fixture counts. **They are COMPUTED at check time**
  from `conformance/vector-cortex/v2/manifest.json` + the `docs/vector-cortex/sprints/` glob — never
  from literals. Kills hand-arithmetic drift (PC-D, 795→811 / 36→37).
- **Severity:** error.
- **Escape hatch:** n/a — a computed-vs-literal divergence is always a defect; there is no valid allow
  for a stale literal.

---

## 4. Prevention — spec conventions to add

These amend the **sprint-spec template** and the **EVIDENCE_TEMPLATE**. They are process conventions,
queued for CONFORM-HYGIENE.

1. **Registered-placeholders table (every sprint spec).** Every intentional placeholder (stub, shipped
   asset, seeded PRNG in prod) MUST appear in a `Registered placeholders` table with a mandatory
   `closure-sprint:` field. `stub-scan.mjs` reads these tables and requires a matching registry entry —
   a stub with no registration = fail.
2. **Evidence arithmetic MUST be generated, never literal.** `fixtures: manifest.fixtures.length`,
   not a hand number. PC-D (Table 5-B) is the cited precedent — the mismatch was caught and documented
   there; this makes that documented-catch the **norm, not the exception**. Every evidence record gains
   a required `SpecDrift` note field that records any drift from the spec it corrected.
3. **Hard gates live only in the blockers manifest.** `setup-cortex-blockers.ts` is the single source
   of truth. `vc2-model-prep.md` §6 prose items 6/7 must reference **HG IDs**, not free text (they
   become **HG-6** thread-count-mandatory and **HG-7** model-card/dataset-manifest/calibration). HG-6/HG-7
   assignment is queued in CONFORM-HYGIENE.
4. **Forced-deviation section is mandatory (pre-declared).** Every sprint spec declares foreseeable
   per-shard digest / acceptance deviations up front — mirroring the PC-C `tailResult.ts` precedent —
   instead of discovering a digest-skip at review. This prevents PREVENT-VERIFICATION-BYPASS-001 from
   arriving as a surprise.

---

## 5. Feedback loops — how the system self-corrects

- **Per-phase roll-up retro artifact.** Every phase's final sprint adds a `RETRO.md` listing defects
  found after landing and which new rule now covers each. ML5 gets one; PC / VC9 get them retroactively
  in CONFORM-HYGIENE. This closes the loop from "found late" → "now instrumented".
- **Stub/placeholder registry is the single ledger.** `deploy.sh` gains a
  `node scripts/stub-scan.mjs --fail-on-unregistered` step (name proposed): a NEW stub appearing with
  no registry entry is a deploy-blocking failure, not a review nit.
- **Conformance grows monotonically.** A missing reserved ID — `MIG-DOWN-002`, `SETUP-CORTEX 014-019` +
  `023-029`, the `EVAL-*` trio — is a conformance-check failure, so a reserved-but-un-emitted range
  fails at the sprint boundary (Table 4), not months later.
- **Nightly / CI runs the full scanner suite.** A NEW stub without a registry entry = **hard fail**.
  This is the systemic guard that would have caught every 2026-08-05 class before landing.

---

## 6. Rollout (maps to closure sprints; every step cites the audit finding it fixes)

### CONFORM-HYGIENE sprint (new — to be spec'd)

- Adds **HG-6 / HG-7** to the Setup Cortex blockers manifest (Table 3, missing-HG-ID items 6/7).
- Lands `stub-scan.mjs` + `mock-scan.mjs` and registers **all 8 existing sites** as tracked placeholders
  with closure sprints (Table 1).
- Fixes the two digest/commit `"0"` sentinels — `validate.ts:65` + `_acceptance-helpers.ts:342` and
  `_cross-language-fixture.ts:72` (Table 2 rows 4–5) — aligning the producer before eroding the
  per-shard-digest invariant.
- Backfills the missing conformance fixtures: `MIG-DOWN-002`, `SETUP-CORTEX 014-019` + `023-029`,
  `EVAL-BUCKET-001` / `EVAL-ORDER-003` / `EVAL-REDACT-002` (Table 4).
- Dispositions the game-mode **GM-B / GM-C / GM-D** rows — either spec them or transfer them with a
  traceable decision (Table 6).
- Adds superseded-doc banners to stale docs (Table 5-D).
- Writes the **PC + VC9 retro artifacts** (Table 5-E, §5) and reconciles Milestone-5-C's phase-doc-only
  state by splitting ML5 into per-sprint specs (Table 5-C).

### ML5 chain (already phase-planned)

- **ML5-A** closes the encoder stubs (`runtime.ts:107`, `heads.ts:11,48`, `calibrate.ts:87-126`),
  the committed 42-byte placeholder asset, and **HG-1/3/4/5** (Table 1 rows 1–3,7; Table 3).
- **ML5-B** closes HG-5 + 4-threads bench (HG-6) and the streaming backfill stub (`backfill.ts:136`).

### VC6C-impl sprint

- Implements the repair-planner stub (`afterCompact.ts:282,304`) and **reconciles the spec/evidence
  status contradiction** (Table 5-A: "next" vs "implementer-complete" unattested).

### AGENT_GUARDRAILS.md amendment (lands with CONFORM-HYGIENE)

- Add a `### PREVENT-STUB / PREVENT-MOCK rules` table and bump **Version 1.3 → 1.4** with the date.
  See §7 for the exact table text.

---

## 7. Guardrails-template diff (the concrete AGENT_GUARDRAILS.md change proposed)

This section is the **"template" the user asked for** — it becomes part of `AGENT_GUARDRAILS.md` as a
new PREVENT-PI-style rules table under the existing "pi-mega-compact Project Rules" heading, in the
CONFORM-HYGIENE sprint. Render style mirrors the existing PREVENT-PI table exactly (Rule ID | Severity |
Description).

| Rule ID | Severity | Description |
| --------- | ---------- | ------------- |
| PREVENT-STUB-001 | error | Shipping a runtime stub/placeholder in `src/` or `extensions/` without a `guardrails-allow PREVENT-STUB-001: <closure sprint id>` referencing a real closure. Enforced by `scripts/stub-scan.mjs`. |
| PREVENT-MOCK-001 | error | Presenting mock/fake/synthetic data (seeded PRNG, hash-as-embedding, hardcoded metric tables) as real measurements in a production path without a documented accuracy floor. Enforced by `scripts/mock-scan.mjs`. |
| PREVENT-PLACEHOLDER-001 | error | Committing a bearer placeholder asset (e.g. a sub-100-byte `model.onnx`) that ships to clients without a Registered-placeholders entry carrying a `closure-sprint:`. Enforced by `stub-scan.mjs` + asset-manifest digest check. |
| PREVENT-VERIFICATION-BYPASS-001 | critical | A sentinel (`digest === "0"`, `?? "0"`, `"0".repeat(40)`) that silently disables a real verification check, unless explicitly marked. Enforced by `stub-scan.mjs`. |
| PREVENT-SPEC-DRIFT-001 | error | Hand-maintained spec/evidence arithmetic (fixture counts, `EXPECTED_SPRINTS`) instead of values computed from the conformance manifest. Enforced by `vector-cortex-docs-check.mjs`. |
| PREVENT-EVIDENCE-DISRUPT-001 | critical | Spec `Status:` contradicting evidence status, or an "implemented" sprint lacking reviewer attestation past SLA. Enforced by `evidence-attestation-check.mjs`. |
| PREVENT-GATE-VISIBILITY-001 | critical | An OPEN hard gate that carries no HG ID in the Setup Cortex blockers manifest (`setup-cortex-blockers.ts` is the ONLY source of truth). Enforced by `vector-cortex-evidence-check.mjs`. |
| PREVENT-ORPHAN-SCOPE-001 | error | A future-scope / unassigned row with no owning sprint or explicit transfer decision (e.g. GM-B/C/D). Enforced by `vector-cortex-docs-check.mjs`. |

**Note:** this entire §7 is the **proposed template**, not a live change. It lands in
`AGENT_GUARDRAILS.md` only in the CONFORM-HYGIENE sprint alongside the scanners in §3.

---

## 8. Controller review protocol — live verification (added 2026-08-06)

**Defect class addressed:** Controller review was code-only — read files, run gates, mutation scan. A
sprint could pass every static gate while the actual runtime behavior was broken (dashboard serves stale
bundle, endpoint returns shaped-but-empty data, UI doesn't render). **Code review ≠ live verification.**

### 8.1 The rule

After every sprint's `./scripts/deploy.sh <version>` publish completes, the controller **MUST** run a
live verification pass **before** dispatching the next sprint:

1. **`curl -sS localhost:9320/api/version`** → confirm response shows the just-published version.
2. **`curl -sS http://localhost:9320/ | grep 'id="root"'`** → confirm React bundle is served (the
   0.8.5 regression check).
3. **Sprint-specific endpoints** → hit every API endpoint the sprint added or modified; confirm they
   return real data (not an empty shell). A new endpoint returning `{}` or a shaped-but-null payload is
   a finding, not a pass.
4. **Dashboard UI** (when the sprint added client components): open in a browser (Playwright headless)
   and confirm the component renders with data.

### 8.2 Where the result lives

Each sprint's evidence record gains a **"Live verification"** section (added 2026-08-06, retroactive
to all previously-shipped sprints via the retroactive pass described below). The section records the
exact curl command and a one-line PASS/FAIL/NOTED verdict. A FAIL blocks the sprint from advancing to
the next — the controller fixes the live defect first.

### 8.3 Retroactive pass

Sprints shipped before this protocol (VC9A through VC6C-IMPL / v0.20.35) get a single live-verification
pass against the current live dashboard + the version on disk. Findings are recorded in a new file:
`docs/audits/2026-08-06-live-verification-retro.md` with per-sprint verdict + endpoint tested.

### 8.4 Escape hatch

None. There is no `guardrails-allow` for "skipped live verification" — that would be the exact defect
this protocol exists to prevent.

---

*Companion plan to `docs/audits/2026-08-05-stub-gate-mock-audit.md`. Every rule is traceable to an audit
finding by file:line or audit-table reference. No code changed; no commit made.*

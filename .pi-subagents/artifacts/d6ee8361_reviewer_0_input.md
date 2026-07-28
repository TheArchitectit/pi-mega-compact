# Task for reviewer

REVIEW TASK (read-only — DO NOT modify any files): Review all pending sprint work in the pi-mega-compact repo (cwd: /mnt/data/git/pi-mega-compact).

Context: the team just finished the mega-runtime decomposition (splitting large files — Phases 1, 2, 2d, merged, now at v0.8.24). We need a complete review of ALL sprint work that still HAS TO BE DONE.

Read in this order:
1. ROADMAP.md (repo root) — consolidated P1/P2 deferred work
2. BACKLOG.md (repo root) — detailed backlog items
3. docs/INDEX_MAP.md + docs/HEADER_MAP.md — navigation maps
4. docs/specs/*.md — all ~46 sprint spec files. Read their headers/efficiently scan (many may be done). Determine status per spec: DONE (shipped — cross-check RELEASE_NOTES.md, `git log --oneline`, package.json version 0.8.24) vs PENDING (still to do).

Deliverable (return as your final message, tight and factual):
1. A table of ALL sprints in docs/specs/ with status DONE / IN-PROGRESS / PENDING + one-line evidence (ship version or release-notes ref)
2. Ordered list of PENDING sprints grouped by priority (P0/P1/P2 per ROADMAP.md), each with: one-line goal, rough scope, cross-sprint dependencies
3. Risks/conflicts between pending sprints (overlapping files, ordering constraints, e.g. s42 RAPTOR vs earlier dedup work)
4. Flag any spec that looks stale, superseded, or already implemented but not marked done

Token-saving rules are strict in this repo: skim spec headers/status sections rather than full bodies; use the maps; do not re-read files. Keep the report concise.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```
# Node Guardrails Pattern Scan (`guardrails-scan.mjs`)

A Node fallback for the Python `regression_check.py` pattern scanner, so
TypeScript / JavaScript pi-extensions can run the PREVENT-* gate without Python
installed.

## Usage

```bash
node scripts/guardrails-scan.mjs
# or wire into package.json:  "lint": "tsc --noEmit && node scripts/guardrails-scan.mjs"
```

Scans `*.ts` / `*.js` (excluding `*.d.ts`) under `extensions/` and `src/` for
lines matching any enabled `critical` / `error` rule in
`.guardrails/prevention-rules/pattern-rules.json`. Exits non-zero on violation.

## Path-matching note (important)

`walk()` yields **absolute** file paths, but rule `file_glob` patterns are
**repo-relative** (e.g. `extensions/**/*.ts`). The scanner strips the repo root
before glob-matching — otherwise no `file_glob` rule ever fires and the gate
reports "clean" while silently doing nothing. If you copy this scanner, keep the
`repoRel()` step in `ruleAppliesTo`.

## Inline allows

A line containing `// guardrails-allow <RULE_ID>: <reason>` is skipped (a reason
is required). Use it to document a deliberate, audited exception (e.g. a
localhost dev server) without disabling the rule project-wide. Add
project-specific file exclusions to the `SCAN_EXCLUSIONS` array at the top of the
script.

## Relation to `regression_check.py`

Both load the same `pattern-rules.json`. The Python scanner checks **diff
content** against patterns (CI / pre-commit); this Node scanner checks **working
tree files** (local `npm run lint`). They are complementary.

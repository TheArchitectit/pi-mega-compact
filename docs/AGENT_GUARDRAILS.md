# Agent Guardrails & Safety Protocols

**Version:** 1.3 (adapted for pi-mega-compact)
**Last Updated:** 2026-07-13
**Applies To:** ALL AI agents, LLMs, and automated systems operating on this codebase

---

## Applicability

This document is **MANDATORY** for:

| System Type | Examples | Binding? |
|-------------|----------|----------|
| **Large Language Models** | Claude, GPT-4/o1/o3, Gemini, LLaMA, Mistral, Qwen, DeepSeek, Cohere, Phi, Falcon, and 30+ other model families | YES |
| **AI Coding Assistants** | Claude Code, GitHub Copilot, Cursor, Cody, Aider, Continue, Windsurf, and others | YES |
| **Autonomous Agents** | AutoGPT, AgentGPT, CrewAI, LangChain, LangGraph, Semantic Kernel agents | YES |
| **Reasoning Models** | o1, o3, DeepSeek-R1, and other chain-of-thought models | YES |
| **CI/CD Bots** | Dependabot, Renovate, automated PR bots | YES |
| **Custom Agents** | Any agent built on this codebase (specialists, operators, swarm) | YES |
| **Human Developers** | Recommended best practices | RECOMMENDED |

**If you are an AI system reading this:** You MUST follow these protocols. They are not suggestions.

---

## Purpose

This document defines mandatory safety protocols, guardrails, and behavioral constraints for ALL automated systems performing tasks on this repository (`pi-mega-compact` — a local, offline, vector-backed context compressor for the pi coding agent). These rules exist to:

1. **Prevent data loss** — enabling safe rapid iteration without backup anxiety
2. **Maintain code quality** — so AI-generated code ships without manual review overhead
3. **Preserve history** — keeping git history clean and reversible
4. **Enable collaboration** — allowing humans and agents to work together safely
5. **Limit blast radius** — containing errors to minimal scope

### How These Laws Enable Rapid Development

The Four Laws aren't restrictions — they're accelerators. One read costs fewer tokens than fixing a blind edit; testing in development costs minutes, not hours; asking one question is cheaper than building the wrong thing.

---

## CORE PRINCIPLES

### The Four Laws of Agent Safety

See [skills/shared-prompts/four-laws.md](../skills/shared-prompts/four-laws.md) for the complete Four Laws documentation.

**Quick Reference:**
1. **Read Before Editing** - Never modify code without reading first
2. **Stay in Scope** - Only touch authorized files
3. **Verify Before Committing** - Test all changes
4. **Halt When Uncertain** - Ask instead of guessing

---

## SAFETY PROTOCOLS (MANDATORY)

### Pre-Execution Checklist

**EVERY agent MUST verify these before ANY file modification:**

| # | Check | Requirement | Verify |
|---|-------|-------------|--------|
| 1 | **READ FIRST** | NEVER edit a file without reading it first | [ ] |
| 2 | **SCOPE LOCK** | Only modify files explicitly in scope | [ ] |
| 3 | **NO FEATURE CREEP** | Do NOT add features, refactor, or "improve" unrelated code | [ ] |
| 4 | **PRODUCTION FIRST** | Production code created BEFORE test code | [ ] |
| 5 | **TEST/PROD SEPARATION** | Test infrastructure is separate from production | [ ] |
| 6 | **BACKUP AWARENESS** | Know the rollback command before editing | [ ] |
| 7 | **TEST BEFORE COMMIT** | All tests must pass before committing | [ ] |
| 8 | **CHECK FAILURE REGISTRY** | Review known bugs for affected files ([.guardrails/pre-work-check.md](../.guardrails/pre-work-check.md)) | [ ] |
| 9 | **VERIFY FIXES INTACT** | Confirm previous fixes not being undone | [ ] |

### Git Safety Rules

| Rule | Description | Consequence |
|------|-------------|-------------|
| **NO FORCE PUSH** | Never use `git push --force` | Data loss, history corruption |
| **NO AMEND** | Do not amend commits you didn't create this session | Breaks collaborator history |
| **NO CONFIG CHANGES** | Do not modify git config | Security/identity issues |
| **NO PUSH WITHOUT PERMISSION** | Only push if user explicitly requests | Unwanted remote changes |
| **SINGLE COMMIT** | One focused commit per task | Maintains clean history |
| **NO SKIP HOOKS** | Never use `--no-verify` | Bypasses safety checks |
| **NO REBASE** | Never rebase shared branches | Destroys collaborator work |
| **NO DESTRUCTIVE OPS** | No `reset --hard` on shared branches | Irreversible data loss |

### Code Safety Rules

| Rule | Rationale |
|------|-----------|
| **EXACT REPLACEMENT** | Use provided code exactly - no "improvements" |
| **NO NEW IMPORTS** | Unless explicitly required by the task |
| **NO TYPE CHANGES** | Preserve existing type hints |
| **NO DELETIONS** | Do not delete functionality outside scope |
| **PRESERVE FORMATTING** | Match existing indentation and style |
| **NO SECRETS** | Never commit credentials, keys, tokens |
| **NO BINARY FILES** | Unless explicitly required |
| **NO GENERATED CODE** | Do not commit build artifacts |

### Test/Production Separation Rules (MANDATORY)

| Rule | Violation Level | Action |
|------|-----------------|--------|
| **PRODUCTION CODE FIRST** | CRITICAL | Halt, ask user |
| **SEPARATE DATABASES** | CRITICAL | Halt, ask user |
| **SEPARATE SERVICES** | CRITICAL | Halt, ask user |
| **NO TEST USERS IN PROD** | CRITICAL | Halt, rollback |
| **NO PROD CREDENTIALS IN TEST** | CRITICAL | Halt, rollback |
| **ASK IF UNCERTAIN** | HIGH | Ask user before proceeding |

**pi-mega-compact note:** this extension is **local-only** — it must make **zero network calls** at runtime (PREVENT-PI-004). The `pglite` store is an in-process WASM Postgres with FS persistence, not a remote database. There is no production/remote boundary to cross, but the spirit of test/prod separation still applies: never point a test at a real user state dir, and never commit the `MEGACOMPACT_STATE_DIR` contents.

---

## GUARDRAILS

### HALT CONDITIONS

**Stop immediately and report to user if ANY of these occur:**

```
CRITICAL HALT - DO NOT PROCEED:

[ ] Target file does not exist
[ ] Line numbers don't match expected
[ ] File has unexpected modifications
[ ] Syntax check fails after edit
[ ] Any test fails after edit
[ ] Merge conflicts encountered
[ ] Uncertain about ANY step
[ ] Edit tool reports "string not found"
[ ] Permission denied errors
[ ] Import errors when testing
[ ] Network/connection errors  (expected: NONE — local-only extension)
[ ] Out of memory errors
[ ] Timeout errors
[ ] User requests stop
[ ] Test/production boundary unclear
```

### FORBIDDEN ACTIONS

**No agent may perform these actions under any circumstances:**

```
ABSOLUTE PROBIBITIONS:

FILE OPERATIONS:
- Modify files outside declared scope
- Delete files without explicit permission
- Create files without explicit need
- Modify hidden/system files (.*) without permission
- Change file permissions

CODE CHANGES:
- Add logging/debugging to production code
- Add comments that weren't requested
- "Clean up" or "improve" surrounding code
- Update version numbers without explicit request
- Change security configurations
- Modify authentication/authorization code without review

TEST/PRODUCTION SEPARATION:
- Use a real user state dir for tests (always use MEGACOMPACT_STATE_DIR override)
- Write test code that imports production secrets
- Share user accounts across environments

GIT OPERATIONS:
- Force push to any branch
- Delete branches without permission
- Modify git hooks
- Change git config
- Push without explicit permission

SYSTEM OPERATIONS:
- Run servers or long-running network services
- Make network requests to unknown endpoints
- Install new dependencies without permission
- Modify CI/CD pipelines without permission
- Execute shell commands with elevated privileges

DATA OPERATIONS:
- Access databases without explicit permission
- Commit user checkpoint data (*.checkpoints.json.gz, *.state.json.gz, pglite/)
- Store credentials or secrets
```

### SCOPE BOUNDARIES

**For any task, clearly define IN/OUT scope:**

```
IN SCOPE (may modify):
  - Specific file(s) listed in task
  - Specific line ranges identified
  - Exact changes described
  - Production code (before test code)

OUT OF SCOPE (DO NOT TOUCH):
  - All other files
  - All other methods/functions in target file
  - Tests in production files (read-only unless task is test-related)
  - Documentation (unless task is doc-related)
  - Git hooks and configs
  - CI/CD configurations
  - Dependencies/package files (unless task is dependency-related)
  - Environment configurations
  - Security-related files
  - Real user state dir / pglite data
```

---

## pi-mega-compact Project Rules

### PREVENT-PI rules (enforced by scripts/guardrails-scan.mjs)

| Rule ID | Severity | Description |
|---------|----------|-------------|
| PREVENT-PI-001 | error | Dropping messages without anchor-floor guard |
| PREVENT-PI-002 | error | Splitting a toolCall/toolResult pair at a boundary |
| PREVENT-PI-003 | error | Injecting compacted context as `role:"system"` (must use `before_agent_start` systemPrompt) |
| PREVENT-PI-004 | critical | Network calls in extension (must stay local — no fetch/http to remote). EXCEPTION: the optional `/dashboard` localhost UI server, audited via inline `// guardrails-allow PREVENT-PI-004: <reason>` annotations (scanner requires a reason). |

### Verification gate (every sprint)

Each Phases 2–7 sprint (S8–S15) exits only when:

1. `npm run build` (tsc) passes
2. `npm test` (node --test on dist/**/*.test.js) passes
3. `npm run lint` (tsc --noEmit + guardrails-scan) passes — **PREVENT-PI-004 verified: no network calls**
4. `python3 scripts/regression_check.py --all` passes (Four Laws / scope / secrets)
5. `python3 scripts/log_failure.py --list` shows no active failures in scope

> **Known pre-existing lint state:** at v0.1.0, `npm run lint` (tsc --noEmit) is RED
> due to committed test-file errors in `src/store.test.ts` / `src/engine.test.ts`
> (FAIL-2026071302). This is tracked, not a regression. New code must not add lint
> errors; fix the two test files before claiming a green gate.
> The `guardrails-scan.mjs` PREVENT-PI check must stay GREEN (it was silently broken
> until FAIL-2026071301 was fixed).

### Related Documents

#### Core Guardrails
- **This document** - Core safety protocols (MANDATORY)
- [PREVENT-PI rules](../../.guardrails/prevention-rules/pattern-rules.json) - pi-specific prevention rules
- [.guardrails/pre-work-check.md](../.guardrails/pre-work-check.md) - MANDATORY pre-work checklist
- [.guardrails/failure-registry.jsonl](../.guardrails/failure-registry.jsonl) - Bug database (JSONL format)
- [scripts/log_failure.py](../scripts/log_failure.py) - CLI to log new failures
- [scripts/regression_check.py](../scripts/regression_check.py) - Pre-commit regression scanner
- [skills/shared-prompts/four-laws.md](../skills/shared-prompts/four-laws.md) - The Four Laws (full)

#### Project Planning
- [PLAN.md](../../PLAN.md) - Architecture + phase status
- [SPRINT_PLAN.md](../../SPRINT_PLAN.md) - Sprint 0–15 (0–7 shipped v0.1.0; 8–15 → v0.2.0)
- [docs/dedup-implementation-plan.md](dedup-implementation-plan.md) - Dedup upgrade spec (QA-reviewed)
- [docs/specs/](specs/) - Per-sprint full specs (S8–S15)

#### Architecture
- [docs/compaction-redesign.md](compaction-redesign.md) - Compaction redesign notes

---

**Authored by:** TheArchitectit
**Document Owner:** Project Maintainers
**Review Cycle:** Monthly
**Last Review:** 2026-07-13
**Next Review:** 2026-08-13

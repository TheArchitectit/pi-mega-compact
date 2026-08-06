#!/usr/bin/env python3
"""
Regression Check Tool
Scans staged/unstaged changes against failure registry to detect potential regressions.

Usage:
    python scripts/regression_check.py              # Check staged changes
    python scripts/regression_check.py --unstaged   # Check unstaged changes
    python scripts/regression_check.py --all        # Check all changes
    python scripts/regression_check.py --pre-commit # Exit with error code if issues found

Environment Variables:
    FAILURE_REGISTRY_PATH: Path to registry file
    PREVENTION_RULES_PATH: Path to prevention rules directory
"""

import argparse
import contextlib
import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_REGISTRY_PATH = Path(".guardrails/failure-registry.jsonl")
DEFAULT_RULES_PATH = Path(".guardrails/prevention-rules")


# File-size limits (CLAUDE.md §6 + user rule: ALL non-doc well under 500).
# src/ 300 soft / 500 hard; extensions/ 400 soft / 500 hard; tests/ 600 hard.
FILE_SIZE_DIRS = ("src", "extensions")
FILE_SIZE_SKIP_PARTS = ("node_modules", "dist", ".claude", "worktrees")
FILE_SIZE_SKIP_SUFFIXES = (".d.ts",)
SRC_SOFT = 300
SRC_HARD = 500
EXT_SOFT = 400
EXT_HARD = 500
TEST_HARD = 600
# ML5-A training pipeline (not tsc/npm-managed): its own hard cap, no soft limit.
TRAIN_DIRS = (f"training{os.sep}vector-cortex",)
PY_TRAIN_HARD = 600


def _classify_file(rel_path: str) -> tuple[int | None, int | None]:
    """Return (soft, hard) line limits for a repo-relative .ts/.tsx path, or
    (None, None) if the file should be skipped."""
    parts = rel_path.split(os.sep)
    for skip in FILE_SIZE_SKIP_PARTS:
        if skip in parts:
            return (None, None)
    for suf in FILE_SIZE_SKIP_SUFFIXES:
        if rel_path.endswith(suf):
            return (None, None)
    is_test = rel_path.endswith((".test.ts", ".test.tsx"))
    if rel_path.startswith("extensions" + os.sep):
        return (EXT_SOFT, TEST_HARD if is_test else EXT_HARD)
    if rel_path.startswith("src" + os.sep):
        return (SRC_SOFT, TEST_HARD if is_test else SRC_HARD)
    for train in TRAIN_DIRS:
        if rel_path.startswith(train + os.sep) and rel_path.endswith(".py"):
            # Training python has its own hard cap only (no soft split trigger).
            return (None, PY_TRAIN_HARD)
    return (None, None)


def check_file_sizes(repo_root: Path) -> list[dict]:
    """Scan src/ and extensions/ for files over soft/hard line limits.

    Returns a list of issue dicts: {file, lines, soft, hard, severity,
    kind}. severity is 'error' (over hard) or 'warning' (over soft only).
    Sorted: hard-limit violations first (by line count desc), then warnings.
    """
    violations: list[dict] = []
    warnings: list[dict] = []

    def _size_file(abs_path: Path, rel_path: str) -> None:
        soft, hard = _classify_file(rel_path)
        if hard is None:
            return
        try:
            with open(abs_path, encoding="utf-8", errors="replace") as f:
                line_count = sum(1 for _ in f)
        except OSError:
            return
        if line_count > hard:
            violations.append(
                {
                    "file": rel_path,
                    "lines": line_count,
                    "soft": soft,
                    "hard": hard,
                    "severity": "error",
                    "kind": "hard",
                }
            )
        elif soft is not None and line_count > soft:
            warnings.append(
                {
                    "file": rel_path,
                    "lines": line_count,
                    "soft": soft,
                    "hard": hard,
                    "severity": "warning",
                    "kind": "soft",
                }
            )

    for top in FILE_SIZE_DIRS:
        base = repo_root / top
        if not base.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not (name.endswith((".ts", ".tsx"))):
                    continue
                abs_path = Path(dirpath) / name
                try:
                    rel_path = abs_path.relative_to(repo_root).as_posix()
                except ValueError:
                    continue
                _size_file(abs_path, rel_path)

    # ML5-A training pipeline: python files under training/vector-cortex get the
    # same size scan with their own hard cap (no soft split trigger).
    for train in TRAIN_DIRS:
        base = repo_root / train
        if not base.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not name.endswith(".py"):
                    continue
                abs_path = Path(dirpath) / name
                try:
                    rel_path = abs_path.relative_to(repo_root).as_posix()
                except ValueError:
                    continue
                _size_file(abs_path, rel_path)

    violations.sort(key=lambda d: d["lines"], reverse=True)
    warnings.sort(key=lambda d: d["lines"], reverse=True)
    return violations + warnings


def print_file_size_report(size_issues: list[dict]) -> None:
    """Print formatted report of file-size issues."""
    if not size_issues:
        print("✓ All source files within soft/hard line limits")
        return

    hard_count = sum(1 for i in size_issues if i["kind"] == "hard")
    soft_count = sum(1 for i in size_issues if i["kind"] == "soft")

    print("\n" + "=" * 70)
    print("FILE-SIZE CHECK")
    print("=" * 70)

    for issue in size_issues:
        severity = format_severity(issue["severity"])
        tag = "OVER HARD LIMIT" if issue["kind"] == "hard" else "over soft limit"
        print(
            f"  {severity}  {issue['file']}  ({issue['lines']} lines, "
            f"limit {issue['hard'] if issue['kind'] == 'hard' else issue['soft']})  {tag}"
        )

    print("-" * 70)
    print(
        f"  {hard_count} over hard limit (blocks commit), {soft_count} over soft limit (warning)"
    )
    print("=" * 70)


# ---------------------------------------------------------------------------
# Python compile check — every training/vector-cortex .py must byte-compile.
# ---------------------------------------------------------------------------

def check_python_compile(repo_root: Path) -> list[dict]:
    """Byte-compile every .py under the training dirs (no execution). Returns a
    list of issue dicts {file, error} for files that fail to compile."""
    issues: list[dict] = []
    for train in TRAIN_DIRS:
        base = repo_root / train
        if not base.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not name.endswith(".py"):
                    continue
                abs_path = Path(dirpath) / name
                prod = subprocess.run(
                    [sys.executable, "-m", "py_compile", str(abs_path)],
                    capture_output=True,
                    text=True,
                    cwd=str(repo_root),
                )
                if prod.returncode != 0:
                    issues.append(
                        {"file": str(abs_path.relative_to(repo_root)), "error": (prod.stderr or prod.stdout).strip()}
                    )
    return issues


def print_python_compile_report(compile_issues: list[dict]) -> None:
    if not compile_issues:
        print("✓ All training/vector-cortex python files compile")
        return
    print("\n" + "=" * 70)
    print("PYTHON COMPILE CHECK (training/vector-cortex)")
    print("=" * 70)
    for issue in compile_issues:
        print(f"  ERROR  {issue['file']}\n    {issue['error']}")
    print("-" * 70)
    print(f"  {len(compile_issues)} python file(s) failed to compile (blocks commit)")
    print("=" * 70)


# ---------------------------------------------------------------------------
# Settings coverage check — every MEGACOMPACT_* env var in config files must
# appear in the dashboard SETTINGS array or the EXCLUDED_SETTINGS set.
# (ENGINEERING_PRACTICES.md §7 — Dashboard surface rule)
# ---------------------------------------------------------------------------

# Config files that define MEGACOMPACT_* env vars.
SETTINGS_CONFIG_FILES = (
    "src/config.ts",
    "src/config/turns.ts",
    "src/config/dedup.ts",
    "src/config/vector-cortex.ts",
    "src/hyde.ts",
    "src/dedup/raptor/summarizer.ts",
    "src/costApi.ts",
    "src/httpEmbedder.ts",
)

# Regex for MEGACOMPACT_* env var names (captured group = key).
_ENV_VAR_RE = re.compile(r'"(MEGACOMPACT_[A-Z0-9_]+)"')


def _collect_env_vars(repo_root: Path) -> set:
    """Collect all MEGACOMPACT_* env var names from config files."""
    found: set = set()
    for rel in SETTINGS_CONFIG_FILES:
        path = repo_root / rel
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in _ENV_VAR_RE.finditer(text):
            found.add(m.group(1))
    return found


def _collect_settings_keys(repo_root: Path) -> set:
    """Collect env var keys from the dashboard SETTINGS array + EXCLUDED_SETTINGS
    set in routes-rag-settings.ts and its sibling group modules."""
    # The SETTINGS inventory may be split across sibling files (groups extracted
    # to keep each under the extensions/ soft limit), so glob every
    # routes-rag-settings-*.ts file rather than hardcoding a tuple that must be
    # hand-updated each time a group is extracted (which would silently drop
    # flags and false-block the deploy).
    server_dir = repo_root / "extensions" / "dashboard-server"
    text = ""
    if server_dir.is_dir():
        for path in sorted(server_dir.glob("routes-rag-settings*.ts")):
            with contextlib.suppress(OSError):
                text += path.read_text(encoding="utf-8", errors="replace") + "\n"
    if not text:
        return set()
    keys: set = set()
    # Match both `key: "MEGACOMPACT_..."` (SETTINGS array entries) and
    # string literals inside the EXCLUDED_SETTINGS set/array.
    for m in re.finditer(r'"(MEGACOMPACT_[A-Z0-9_]+)"', text):
        keys.add(m.group(1))
    return keys


def _npm_audit_available() -> bool:
    """True if `npm audit --json` is available in PATH."""
    try:
        result = subprocess.run(
            ["npm", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _npm_audit_title(info: dict) -> str:
    """Extract a short human-readable advisory title from an npm audit vuln entry."""
    via = info.get("via") or []
    for v in via:
        if isinstance(v, dict) and v.get("title"):
            return str(v["title"])
    if isinstance(via, list) and via:
        return str(via[0])
    return "(no advisory title)"


def check_npm_audit(repo_root: Path) -> tuple[int, int, list[dict]]:
    """Run `npm audit` and classify vulnerabilities by severity × scope.

    Returns ``(blocking_count, warning_count, issues)`` where ``issues`` is a
    list of dicts: ``{name, severity, is_runtime, advisory, fix_available,
    effects}``.

    Runtime vulnerabilities (reachable from ``package.json`` ``dependencies``,
    i.e. shipped to users via ``npm install``) at HIGH or CRITICAL severity are
    the only BLOCKING findings — they ship to every downstream device. Dev-only
    / moderate / low findings (reachable solely from devDependencies or
    peerDependencies, e.g. the openclaw plugin host + its transitive deps) are
    returned as non-blocking warnings: they live in the build toolchain and
    often can't be fixed without a breaking peer upgrade.

    Tooling failures (npm missing, JSON unparseable, npm audit errored) are
    themselves BLOCKING — a deploy gate must not silently skip the audit
    because ``npm audit`` errored. Callers can skip deliberately via
    ``--no-audit``.
    """
    if not _npm_audit_available():
        return (
            1,
            0,
            [
                {
                    "name": "(npm)",
                    "severity": "critical",
                    "is_runtime": True,
                    "advisory": "npm not found in PATH — cannot run `npm audit`",
                    "fix_available": False,
                    "effects": [],
                }
            ],
        )
    try:
        result = subprocess.run(
            ["npm", "audit", "--json"],
            capture_output=True,
            text=True,
            cwd=str(repo_root),
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return (
            1,
            0,
            [
                {
                    "name": "(npm)",
                    "severity": "critical",
                    "is_runtime": True,
                    "advisory": "`npm audit --json` timed out after 120s",
                    "fix_available": False,
                    "effects": [],
                }
            ],
        )
    # npm audit exits 0 when clean, 1 when vulns are found, >1 on tool error.
    raw = result.stdout.strip()
    if not raw:
        msg = (
            result.stderr.strip()
            or f"npm audit exited {result.returncode} with no JSON output"
        )
        return (
            1,
            0,
            [
                {
                    "name": "(npm)",
                    "severity": "critical",
                    "is_runtime": True,
                    "advisory": msg,
                    "fix_available": False,
                    "effects": [],
                }
            ],
        )
    try:
        audit = json.loads(raw)
    except json.JSONDecodeError as exc:
        return (
            1,
            0,
            [
                {
                    "name": "(npm)",
                    "severity": "critical",
                    "is_runtime": True,
                    "advisory": f"npm audit JSON unparseable: {exc}",
                    "fix_available": False,
                    "effects": [],
                }
            ],
        )

    # Load package.json to classify runtime vs dev scope. A vulnerable package
    # is RUNTIME if any of its `effects` (direct deps that pull it in) is in
    # package.json `dependencies`; otherwise it is dev-only (reachable only
    # via devDependencies / peerDependencies / optionalDependencies).
    pkg_path = repo_root / "package.json"
    runtime_deps: set[str] | None = set()
    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        runtime_deps = set((pkg.get("dependencies") or {}).keys())
    except (OSError, json.JSONDecodeError):
        # If package.json is unreadable, treat ALL findings as runtime so we
        # fail safe (never silently downgrade a real vuln to a warning).
        runtime_deps = None

    vuln_map = audit.get("vulnerabilities") or {}
    issues: list[dict] = []
    for name, info in vuln_map.items():
        severity = str(info.get("severity", "unknown")).lower()
        effects = info.get("effects") or []
        if runtime_deps is None:
            is_runtime = True
        else:
            is_runtime = any(eff in runtime_deps for eff in effects)
        issues.append(
            {
                "name": name,
                "severity": severity,
                "is_runtime": is_runtime,
                "advisory": _npm_audit_title(info),
                "fix_available": bool(info.get("fixAvailable")),
                "effects": effects,
            }
        )
    blocking = [
        i for i in issues if i["is_runtime"] and i["severity"] in ("high", "critical")
    ]
    warning = [
        i
        for i in issues
        if not (i["is_runtime"] and i["severity"] in ("high", "critical"))
    ]
    return len(blocking), len(warning), issues


def print_npm_audit_report(blocking: int, warnings: int, issues: list[dict]) -> None:
    """Print formatted report of npm audit findings."""
    if not issues:
        print("✓ npm audit clean — no vulnerabilities")
        return
    print("\n" + "=" * 70)
    print("NPM AUDIT (runtime HIGH/CRITICAL = blocking; dev-only = warning)")
    print("=" * 70)
    for i in sorted(issues, key=lambda x: (not x["is_runtime"], x["severity"])):
        scope = "RUNTIME" if i["is_runtime"] else "dev-only"
        fix = "fix available" if i["fix_available"] else "NO fix"
        print(f"  {i['severity'].upper():8s} {scope:8s} {i['name']:<32s} {fix}")
        if i["advisory"]:
            print(f"           → {i['advisory']}")
    print("-" * 70)
    print(
        f"  {blocking} blocking (runtime high/critical) | {warnings} warning(s) (dev-only/moderate/low)"
    )
    if blocking:
        print(
            "  ❌ resolve blocking vulns before deploy: `npm audit fix` (non-breaking)"
        )
    else:
        print("  ⓘ  no blocking vulns; warnings are dev-toolchain-only")
    print("=" * 70)


def check_settings_coverage(repo_root: Path) -> list[dict]:
    """Verify every MEGACOMPACT_* env var in config files has a dashboard
    settings entry or is explicitly excluded.

    Returns a list of issue dicts: {var, message}. Empty = pass.
    """
    config_vars = _collect_env_vars(repo_root)
    settings_keys = _collect_settings_keys(repo_root)
    missing = sorted(config_vars - settings_keys)
    return [
        {
            "var": v,
            "message": f"{v} not in dashboard SETTINGS array or EXCLUDED_SETTINGS",
        }
        for v in missing
    ]


def print_settings_report(settings_issues: list[dict]) -> None:
    """Print formatted report of settings coverage issues."""
    if not settings_issues:
        print("✓ All MEGACOMPACT_* env vars have dashboard settings entries")
        return

    count = len(settings_issues)
    print("\n" + "=" * 70)
    print("SETTINGS COVERAGE CHECK")
    print("=" * 70)

    for issue in settings_issues:
        print(f"  ⚠️  MISSING  {issue['var']}")
        print(f"      {issue['message']}")

    print("-" * 70)
    print(f"  {count} setting(s) missing from dashboard (blocks commit)")
    print("=" * 70)


def run_git_command(args: list[str]) -> tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            ["git"] + args, capture_output=True, text=True, cwd=Path.cwd()
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return 1, "", "git command not found"


def get_changed_files(staged: bool = True, unstaged: bool = False) -> list[str]:
    """Get list of changed files from git."""
    files = []

    if staged:
        rc, stdout, _ = run_git_command(["diff", "--cached", "--name-only"])
        if rc == 0:
            files.extend(stdout.strip().split("\n") if stdout.strip() else [])

    if unstaged:
        rc, stdout, _ = run_git_command(["diff", "--name-only"])
        if rc == 0:
            files.extend(stdout.strip().split("\n") if stdout.strip() else [])

    return list({f for f in files if f})


def get_diff_content(file_path: str, staged: bool = True) -> str:
    """Get diff content for a specific file."""
    cmd = ["diff", "--cached"] if staged else ["diff"]
    rc, stdout, _ = run_git_command(cmd + ["--", file_path])
    return stdout if rc in (0, 1) else ""


def load_failure_registry(registry_path: Path) -> list[dict]:
    """Load failure entries from registry."""
    if not registry_path.exists():
        return []

    entries = []
    with open(registry_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                try:
                    entry = json.loads(line)
                    if entry.get("status") == "active":
                        entries.append(entry)
                except json.JSONDecodeError:
                    continue
    return entries


def validate_rule_regex(rule: dict) -> bool:
    """Validate regex patterns in a rule."""
    pattern = rule.get("pattern", "")
    if pattern:
        try:
            re.compile(pattern)
        except re.error as e:
            print(f"Warning: Invalid regex in rule {rule.get('rule_id')}: {e}")
            return False

    forbidden = rule.get("forbidden_context", "")
    if forbidden:
        try:
            re.compile(forbidden)
        except re.error as e:
            print(
                f"Warning: Invalid forbidden_context in rule {rule.get('rule_id')}: {e}"
            )
            return False

    return True


def load_prevention_rules(rules_path: Path) -> list[dict]:
    """Load prevention rules from rules directory."""
    rules = []

    pattern_rules_file = rules_path / "pattern-rules.json"
    if pattern_rules_file.exists():
        try:
            with open(pattern_rules_file) as f:
                data = json.load(f)
                for rule in data.get("rules", []):
                    if rule.get("enabled", True) and validate_rule_regex(rule):
                        rule["rule_type"] = "pattern"
                        rules.append(rule)
        except (OSError, json.JSONDecodeError):
            pass

    semantic_rules_file = rules_path / "semantic-rules.json"
    if semantic_rules_file.exists():
        try:
            with open(semantic_rules_file) as f:
                data = json.load(f)
                for rule in data.get("rules", []):
                    if rule.get("enabled", True):
                        rule["rule_type"] = "semantic"
                        rules.append(rule)
        except (OSError, json.JSONDecodeError):
            pass

    return rules


def check_file_against_failures(file_path: str, failures: list[dict]) -> list[dict]:
    """Check if file is in affected_files of any active failure."""
    matching_failures = []

    for failure in failures:
        affected_files = failure.get("affected_files", [])
        for affected in affected_files:
            # Use fnmatch for proper glob pattern matching
            if fnmatch.fnmatch(file_path, affected):
                matching_failures.append(failure)
                break

    return matching_failures


def check_diff_against_patterns(diff_content: str, rules: list[dict]) -> list[dict]:
    """Check diff content against pattern rules."""
    violations = []

    # Extract added lines only (lines starting with +)
    added_lines = []
    for line in diff_content.split("\n"):
        if line.startswith("+") and not line.startswith("+++"):
            added_lines.append(line[1:])  # Remove the + prefix

    added_content = "\n".join(added_lines)

    for rule in rules:
        if rule.get("rule_type") != "pattern":
            continue

        pattern = rule.get("pattern")
        if not pattern:
            continue

        try:
            if re.search(pattern, added_content, re.MULTILINE):
                # Check forbidden context if specified
                forbidden = rule.get("forbidden_context")
                if forbidden and re.search(forbidden, added_content, re.MULTILINE):
                    continue  # Context suggests this is OK

                violations.append(
                    {
                        "rule_id": rule.get("rule_id"),
                        "name": rule.get("name"),
                        "message": rule.get("message"),
                        "severity": rule.get("severity", "warning"),
                        "suggestion": rule.get("suggestion"),
                        "failure_id": rule.get("failure_id"),
                    }
                )
        except re.error:
            continue  # Invalid regex, skip

    return violations


def format_severity(severity: str) -> str:
    """Format severity with color codes (if terminal supports it)."""
    colors = {
        "critical": "\033[91m",  # Red
        "high": "\033[93m",  # Yellow
        "medium": "\033[94m",  # Blue
        "low": "\033[90m",  # Gray
        "error": "\033[91m",
        "warning": "\033[93m",
    }
    reset = "\033[0m"

    if sys.stdout.isatty():
        return f"{colors.get(severity.lower(), '')}{severity.upper()}{reset}"
    return severity.upper()


def run_regression_check(
    registry_path: Path,
    rules_path: Path,
    staged: bool = True,
    unstaged: bool = False,
    verbose: bool = False,
) -> tuple[int, list[dict]]:
    """
    Run full regression check.
    Returns (issue_count, issues_details).
    """
    issues = []

    # Load data
    failures = load_failure_registry(registry_path)
    rules = load_prevention_rules(rules_path)

    if verbose:
        print(f"Loaded {len(failures)} active failures, {len(rules)} enabled rules")

    # Get changed files
    changed_files = get_changed_files(staged=staged, unstaged=unstaged)

    if not changed_files:
        if verbose:
            print("No changed files to check")
        return 0, []

    if verbose:
        print(f"Checking {len(changed_files)} changed file(s)...")

    # Check each file
    for file_path in changed_files:
        file_issues = {
            "file": file_path,
            "failures": [],
            "violations": [],
        }

        # Check against failure registry
        matching_failures = check_file_against_failures(file_path, failures)
        if matching_failures:
            file_issues["failures"] = matching_failures

        # Check diff against pattern rules
        diff = get_diff_content(file_path, staged=staged)
        if diff:
            violations = check_diff_against_patterns(diff, rules)
            if violations:
                file_issues["violations"] = violations

        if file_issues["failures"] or file_issues["violations"]:
            issues.append(file_issues)

    return len(issues), issues


def print_report(issues: list[dict], verbose: bool = False):
    """Print formatted report of issues."""
    if not issues:
        print("\n✓ No potential regressions detected")
        return

    print("\n" + "=" * 70)
    print("REGRESSION CHECK REPORT")
    print("=" * 70)

    for issue in issues:
        file_path = issue["file"]
        print(f"\n📄 {file_path}")
        print("-" * 70)

        # Print matching failures
        for failure in issue["failures"]:
            severity = format_severity(failure.get("severity", "medium"))
            print(f"\n  ⚠️  {severity} - Known Bug History")
            print(f"      Failure ID: {failure['failure_id']}")
            print(f"      Category: {failure.get('category', 'unknown')}")
            print(
                f"      Previous Error: {failure.get('error_message', 'N/A')[:80]}..."
            )
            print(f"      Prevention: {failure.get('prevention_rule', 'N/A')}")

        # Print pattern violations
        for violation in issue["violations"]:
            severity = format_severity(violation.get("severity", "warning"))
            print(f"\n  🚫 {severity} - Pattern Violation")
            print(f"      Rule: {violation.get('name', 'Unknown')}")
            print(f"      Message: {violation.get('message', 'N/A')}")
            if violation.get("failure_id"):
                print(f"      Related Failure: {violation['failure_id']}")
            if violation.get("suggestion"):
                print(f"      Suggestion: {violation['suggestion']}")

    print("\n" + "=" * 70)
    print(f"Total files with potential issues: {len(issues)}")
    print("=" * 70)
    print("\nReview the above carefully before committing.")


def main():
    parser = argparse.ArgumentParser(
        description="Check for potential regressions in changed code",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s                    # Check staged changes
    %(prog)s --unstaged         # Check unstaged changes
    %(prog)s --all              # Check all changes
    %(prog)s --pre-commit       # Exit with error if issues found
        """,
    )

    parser.add_argument(
        "--registry",
        "-r",
        type=Path,
        default=Path(os.getenv("FAILURE_REGISTRY_PATH", DEFAULT_REGISTRY_PATH)),
        help="Path to failure registry",
    )
    parser.add_argument(
        "--rules",
        type=Path,
        default=Path(os.getenv("PREVENTION_RULES_PATH", DEFAULT_RULES_PATH)),
        help="Path to prevention rules directory",
    )

    # What to check
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--staged",
        action="store_true",
        default=True,
        help="Check staged changes (default)",
    )
    group.add_argument(
        "--unstaged", "-u", action="store_true", help="Check unstaged changes"
    )
    group.add_argument(
        "--all",
        "-a",
        action="store_true",
        help="Check both staged and unstaged changes",
    )

    # Output options
    parser.add_argument(
        "--pre-commit",
        action="store_true",
        help="Exit with non-zero code if issues found (for pre-commit hooks)",
    )
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    parser.add_argument(
        "--no-file-sizes",
        action="store_true",
        help="Skip the file-size scan of src/ and extensions/",
    )
    parser.add_argument(
        "--no-settings", action="store_true", help="Skip the settings coverage check"
    )
    parser.add_argument(
        "--no-audit",
        action="store_true",
        help="Skip the npm audit (runtime HIGH/CRITICAL vuln) check",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument(
        "--quiet", "-q", action="store_true", help="Only output on issues found"
    )
    parser.add_argument(
        "--soft-as-hard",
        action="store_true",
        help=(
            "Promote soft-limit file-size warnings to BLOCKING, but only for files "
            "changed since a base ref (see --soft-as-hard-base, default the working "
            "tree: staged+unstaged). Forces headroom: an agent that grows a src/ "
            "file past 300 or an extensions/ file past 400 must split it "
            "(delegate-shell) rather than squeeze it toward the 500 hard limit. "
            "Pre-existing violators NOT touched by the current change are unaffected "
            "(tech debt, tracked separately)."
        ),
    )
    parser.add_argument(
        "--soft-as-hard-base",
        default=None,
        help=(
            "Base git ref for --soft-as-hard. Files changed since this ref "
            "(git diff <base>...HEAD, plus working-tree edits) are subject to the "
            "headroom gate. For deploy.sh use the prior release tag "
            "(e.g. v0.20.5). If unset, defaults to the working-tree diff "
            "(staged+unstaged) — correct for pre-commit (uncommitted agent work)."
        ),
    )

    args = parser.parse_args()

    # Determine what to check
    staged = args.staged and not args.unstaged and not args.all
    unstaged = args.unstaged or args.all
    if args.all:
        staged = True

    # Run check
    count, issues = run_regression_check(
        registry_path=args.registry,
        rules_path=args.rules,
        staged=staged,
        unstaged=unstaged,
        verbose=args.verbose and not args.quiet,
    )

    # File-size check (always on unless --no-file-sizes).
    size_issues: list[dict] = []
    size_hard_count = 0
    if not args.no_file_sizes:
        size_issues = check_file_sizes(Path.cwd())
        size_hard_count = sum(1 for i in size_issues if i["kind"] == "hard")

    # Soft-as-hard: promote soft-limit violations to BLOCKING, but ONLY for
    # files changed in the working tree. This is the headroom gate — it stops an
    # agent from squeezing a src/ file toward the 500 hard ceiling (or a test
    # toward 600) by forcing a split at the soft limit (300 src / 400 ext) when
    # the file is being grown. Pre-existing violators the current change did not
    # touch stay as non-blocking warnings (tech debt). Intersected with the
    # changed-file set so this never retroactively blocks on historical files.
    soft_as_hard_count = 0
    soft_as_hard_files: list[dict] = []
    if args.soft_as_hard and not args.no_file_sizes:
        if args.soft_as_hard_base:
            # Release-gate mode: files changed since the base ref (committed),
            # plus any working-tree edits. git diff <base>...HEAD gives the
            # committed-since-base set; add staged+unstaged for in-flight edits.
            rc, stdout, _ = run_git_command(
                ["diff", "--name-only", f"{args.soft_as_hard_base}...HEAD"]
            )
            changed: set[str] = set()
            if rc == 0 and stdout.strip():
                changed.update(stdout.strip().split("\n"))
            changed.update(get_changed_files(staged=True, unstaged=True))
        else:
            # Pre-commit mode: only uncommitted working-tree edits.
            changed = set(get_changed_files(staged=True, unstaged=True))
        for issue in size_issues:
            if issue["kind"] != "soft":
                continue
            rel = issue["file"]
            if rel in changed or rel.replace("/", os.sep) in changed:
                soft_as_hard_count += 1
                soft_as_hard_files.append(issue)

    # Settings coverage check (always on unless --no-settings).
    settings_issues: list[dict] = []
    settings_count = 0
    if not args.no_settings:
        settings_issues = check_settings_coverage(Path.cwd())
        settings_count = len(settings_issues)

    # npm audit check (always on unless --no-audit). Blocks on runtime
    # HIGH/CRITICAL vulnerabilities that ship to users via `npm install`;
    # warns on dev-only / moderate / low. This is the deploy gate's defense
    # against shipping known-vulnerable runtime deps.
    audit_blocking = 0
    audit_warnings = 0
    audit_issues: list[dict] = []
    if not args.no_audit:
        audit_blocking, audit_warnings, audit_issues = check_npm_audit(Path.cwd())

    # Python compile check (training/vector-cortex) — a syntax error in the
    # training pipeline would otherwise pass the tsc-only build gate.
    python_compile = check_python_compile(Path.cwd())
    py_compile_count = len(python_compile)

    # Output results
    if args.json:
        print(
            json.dumps(
                {
                    "issue_count": count,
                    "size_violations_hard": size_hard_count,
                    "soft_as_hard_blocked": soft_as_hard_count,
                    "settings_missing": settings_count,
                    "npm_audit_blocking": audit_blocking,
                    "npm_audit_warnings": audit_warnings,
                    "python_compile": python_compile,
                    "python_compile_count": py_compile_count,
                    "issues": issues,
                    "file_sizes": size_issues,
                    "settings_coverage": settings_issues,
                    "npm_audit": audit_issues,
                },
                indent=2,
            )
        )
    else:
        if not args.quiet or count > 0:
            print_report(issues, verbose=args.verbose)
        if (
            size_issues
            and (not args.quiet or size_hard_count > 0)
            or not args.quiet
            and not size_issues
            and not args.json
        ):
            print_file_size_report(size_issues)
        if (
            settings_issues
            and (not args.quiet or settings_count > 0)
            or not args.no_settings
            and not args.quiet
            and not settings_issues
            and not args.json
        ):
            print_settings_report(settings_issues)
        if not args.no_audit and (
            not args.quiet or audit_blocking > 0 or not audit_issues
        ):
            print_npm_audit_report(audit_blocking, audit_warnings, audit_issues)
        if not args.quiet or py_compile_count > 0:
            print_python_compile_report(python_compile)
        if args.soft_as_hard and soft_as_hard_count > 0:
            print("\n" + "=" * 70)
            print(
                "SOFT-AS-HARD HEADROOM GATE (--soft-as-hard)"
            )
            print("=" * 70)
            print(
                "  These changed files exceeded the SOFT limit — split them (delegate-shell"
            )
            print("  + impl) rather than squeezing toward the hard limit:")
            for issue in soft_as_hard_files:
                print(
                    f"    {issue['file']}  ({issue['lines']} lines, soft {issue['soft']})"
                )
            print("=" * 70)

    # Exit code: pre-commit fails on ANY failure-registry issue, file over
    # hard size limit, soft-limit headroom violation on a changed file
    # (--soft-as-hard), missing settings coverage, OR a runtime HIGH/CRITICAL
    # npm vulnerability.
    if args.pre_commit and (
        count > 0
        or size_hard_count > 0
        or soft_as_hard_count > 0
        or settings_count > 0
        or audit_blocking > 0
        or py_compile_count > 0
    ):
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()

/**
 * vector-cortex-evidence-claims.mjs — pure claim EXTRACTION for evidence records.
 *
 * Separated from the checker so the parsing rules are unit-testable without
 * touching the filesystem or spawning test runners. Every export here is a
 * pure function: (markdown text) -> claim objects.
 *
 * LOCAL ONLY: no I/O in this module at all (PREVENT-PI-004).
 */

/**
 * Extract the body of a `## <name>` section (up to the next `## ` heading).
 * Returns "" when the section is absent.
 */
export function section(md, heading) {
  const lines = md.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("## ") && l.slice(3).trim().toLowerCase().startsWith(heading.toLowerCase()),
  );
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Line-count claims.
 *
 * Parsed ONLY from the "File sizes and baseline exceptions" section, which the
 * EVIDENCE_TEMPLATE defines as the authoritative place for final file sizes.
 * Elsewhere in a record a bare `(N)` after a filename routinely means a TEST
 * count (e.g. "`sqlite.test.js` (12)"), so a document-wide regex would be
 * wrong. Scoping is what makes this check trustworthy.
 *
 * Both shapes are recognised:
 *   `path/to/file.ts` (265)   /  `path/to/file.ts` (265 lines)
 *   path/to/file.ts 265       (comma/paren/period terminated prose lists)
 */
export function parseLineClaims(md) {
  const body = section(md, "File sizes");
  if (!body) return [];
  const claims = [];
  const seen = new Set();
  const push = (path, lines, raw) => {
    const key = `${path}::${lines}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ path, lines, raw: raw.trim() });
  };

  // Shape A: `file` (N) or `file` (N lines)
  const backticked = /`([A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs|cjs|js|jsx|json|sh|py|md))`\s*\((\d{1,5})(?:\s*lines?)?\)/g;
  for (const m of body.matchAll(backticked)) push(m[1], Number(m[2]), m[0]);

  // Shape B: bare `file NNN` in a prose list ("types.ts 145, cut.ts 162").
  // Requires a following delimiter so version-ish text cannot match.
  const bare = /([A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs|cjs|js|jsx))`?\s+(\d{1,5})(?=\s*(?:lines?\b|[,.);]|$))/gm;
  for (const m of body.matchAll(bare)) push(m[1], Number(m[2]), m[0]);

  return claims;
}

/**
 * Acceptance test-count claims of the mandated form:
 *   `node --test dist/vector-cortex/vc1b-acceptance.test.js` → `ℹ tests 25 ... pass 25`
 *
 * Returns {file, tests, pass, flagOff, flagVar, raw}. `flagOff` marks the
 * `MEGACOMPACT_X=0 node --test ...` parity invocation.
 */
export function parseTestClaims(md) {
  const claims = [];
  const seen = new Set();
  // A command and the counts reported for it, on the same line or the next few.
  const re =
    /(?:(MEGACOMPACT_[A-Z0-9_]+)=0\s+)?node --test\s+(dist\/[A-Za-z0-9_./-]+\.test\.js)([^\n]*)\n?([^\n]*)/g;
  for (const m of md.matchAll(re)) {
    const [, flagVar, file, tail, next] = m;
    const counts = extractCounts(resultWindow(tail, next));
    if (counts === null) continue;
    const key = `${flagVar ?? "on"}::${file}::${counts.tests}::${counts.pass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({
      file,
      tests: counts.tests,
      pass: counts.pass,
      flagOff: Boolean(flagVar),
      flagVar: flagVar ?? null,
      raw: `${flagVar ? `${flagVar}=0 ` : ""}node --test ${file}`,
    });
  }
  return claims;
}

/**
 * Narrow the text searched for counts to the result that BELONGS to this
 * command. Evidence paragraphs often mention several commands plus a
 * whole-suite total ("Full `npm test` gate: TOTAL: 1701 passed"), and a greedy
 * window would attribute that total to the last-named unit test. So the window
 * stops at the first sentence end, the next command, or a second backticked
 * result — whichever comes first.
 */
function resultWindow(tail, next) {
  let text = tail ?? "";
  // Only extend onto the following line for a fenced block, where the reported
  // summary conventionally sits on its own line under the command.
  if (!/\d/.test(text) && next) text = `${text}\n${next}`;
  const stops = [/\bnode --test\b/, /\.\s+[A-Z(]/, /;\s/, /Full\s+`?npm test/i, /\bTOTAL:/];
  let end = text.length;
  for (const s of stops) {
    const m = s.exec(text);
    if (m && m.index > 0 && m.index < end) end = m.index;
  }
  return text.slice(0, end);
}

/**
 * Pull the reported counts out of a result blob. Ordered most-specific first:
 * the corpus writes "N pass / N fail" as well as "tests N / pass N", and the
 * bare `N/N` ratio must be tried LAST or it would read "11 pass / 0 fail" as
 * 0-of-fail.
 */
function extractCounts(text) {
  const tests = /tests\s+(\d{1,5})/.exec(text);
  const pass = /pass\s+(\d{1,5})/.exec(text);
  if (tests && pass) return { tests: Number(tests[1]), pass: Number(pass[1]) };

  // "11 pass / 0 fail" — pass + fail sum to the total.
  const passFail = /(\d{1,5})\s*pass(?:ed)?\s*\/\s*(\d{1,5})\s*fail/i.exec(text);
  if (passFail) {
    const p = Number(passFail[1]);
    return { tests: p + Number(passFail[2]), pass: p };
  }

  // "25/25" — pass/total.
  const ratio = /(\d{1,5})\s*\/\s*(\d{1,5})(?!\s*fail)\b/.exec(text);
  if (ratio) return { tests: Number(ratio[2]), pass: Number(ratio[1]) };

  const passed = /(\d{1,5})\s+pass(?:ed)?\b/.exec(text);
  if (passed) return { tests: Number(passed[1]), pass: Number(passed[1]) };
  return null;
}

/**
 * Conformance fixture-count claims: "NN fixtures canonical (NN files)" or
 * "manifest: NN". Each carries the raw text so a report can quote it.
 */
export function parseFixtureClaims(md) {
  const claims = [];
  const seen = new Set();
  const canonical = /(\d{1,6})\s+fixtures?\s+canonical/g;
  for (const m of md.matchAll(canonical)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      claims.push({ count: n, raw: m[0] });
    }
  }
  const manifest = /manifest:\s*(\d{1,6})\b/g;
  for (const m of md.matchAll(manifest)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      claims.push({ count: n, raw: m[0] });
    }
  }
  return claims;
}

/** `Status: implementer-complete` (first Status line wins). */
export function parseStatus(md) {
  const m = /^Status:\s*(.+)$/m.exec(md);
  return m ? m[1].trim() : null;
}

/**
 * Reviewer attestation is "present" only when the section exists AND says
 * something other than an explicit not-yet marker.
 */
export function parseAttestation(md) {
  const body = section(md, "Reviewer attestation").trim();
  if (!body) return { present: false, text: "" };
  const notYet = /\b(not yet|pending|none|tbd|n\/a)\b/i.test(body);
  return { present: !notYet, text: body };
}

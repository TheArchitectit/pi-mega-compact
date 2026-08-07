// guardrails-allow PREVENT-PI-004: pure local docs verifier (fs reads only, no network)

// DOC-0a doc-drift verifier. Asserts the shipped tree no longer carries the stale
// evidence-stamp / spec-header / default-OFF wording the June-audit sweep reconciled.
// Pure local file reads; exits nonzero on any failure so a later sprint that
// reintroduces drift fails fast at the gate.

import { readFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  process.stderr.write(`FAIL: ${msg}\n`);
};
const ok = () => process.stderr.write('.\n');

// Read a tracked repo file. A missing/renamed file is a loud, actionable failure
// (reported via fail(), counted, non-zero exit) rather than a raw ENOENT crash.
// Returns null on error so callers skip content checks for the missing file.
const read = async (p) => {
  try {
    return await readFile(new URL(p, ROOT), 'utf8');
  } catch (err) {
    fail(`${p}: file not found — was it renamed or deleted? (${err.code ?? 'read error'})`);
    return null;
  }
};

// (a) evidence stamps — file -> [shipped version, impl short-SHA]
const STAMPS = {
  'docs/vector-cortex/evidence/VC9A.md': ['v0.20.27', 'ab1e223'],
  'docs/vector-cortex/evidence/VC9B.md': ['v0.20.28', '1063ee8'],
  'docs/vector-cortex/evidence/VC9C.md': ['v0.20.28', 'bc64af4'],
  'docs/vector-cortex/evidence/VC9D.md': ['v0.20.30', '1f34a08'],
  'docs/vector-cortex/evidence/ML5-A.md': ['v0.20.36', '816ed10'],
  'docs/vector-cortex/evidence/PC-A.md': ['v0.20.31', '6df47f3'],
  'docs/vector-cortex/evidence/PC-B.md': ['v0.20.32', '34d0a35'],
  'docs/vector-cortex/evidence/PC-C.md': ['v0.20.33', '9333e64'],
  'docs/vector-cortex/evidence/PC-D.md': ['v0.20.34', 'e728dcc'],
};

await checkEvidenceStamps();

// (b) PC spec headers -> expected shipped version
await checkSpecHeaders();

// (c) PLAN_V2 stale markers + no default-OFF pairing
await checkPlanV2();

// (d) README default-ON wording
await checkReadme();

// (e) ADOPTION rows default ON
await checkAdoption();

if (failures > 0) {
  process.stderr.write(`\nDOC-DRIFT: ${failures} check(s) FAILED — tree carries stale doc drift.\n`);
  process.exit(1);
}
process.stderr.write('\nDOC-DRIFT: all checks passed — tree is free of the reconciled drift.\n');
process.exit(0);

async function checkEvidenceStamps() {
  process.stderr.write('(a) evidence stamps ...');
  for (const [file, [version, sha]] of Object.entries(STAMPS)) {
    const body = await read(file);
    if (body === null) continue; // missing-file failure already reported by read()
    const stamp = `PUBLISHED as ${version}`;
    if (!body.includes(stamp)) {
      fail(`${file}: missing stamp "${stamp}"`);
      continue;
    }
    if (!body.includes(`\`${sha}\``)) {
      fail(`${file}: missing impl SHA backtick \`${sha}\``);
    }
  }
  ok();
}

async function checkSpecHeaders() {
  process.stderr.write('(b) PC spec headers ...');
  const PC = {
    'docs/vector-cortex/sprints/PC-B-cache-striping-default-on.md': 'v0.20.32',
    'docs/vector-cortex/sprints/PC-C-dashboard-cache-visibility.md': 'v0.20.33',
    'docs/vector-cortex/sprints/PC-D-benchmark-validation-rollup.md': 'v0.20.34',
  };
  for (const [file, version] of Object.entries(PC)) {
    const body = await read(file);
    if (body === null) continue; // missing-file failure already reported by read()
    const statusLine = body.split('\n').find((l) => l.startsWith('**Status:**'));
    if (!statusLine || !statusLine.startsWith('**Status:** shipped')) {
      fail(`${file}: Status line is not "**Status:** shipped" (found: ${JSON.stringify(statusLine ?? 'no Status line')})`);
    }
    const shipped = `**Shipped:** ${version}`;
    if (!body.includes(shipped)) {
      fail(`${file}: missing "${shipped}"`);
    }
  }
  ok();
}

async function checkPlanV2() {
  process.stderr.write('(c) PLAN_V2 stale markers ...');
  const planv2 = await read('docs/PROMPTCACHE_PLAN_V2.md');
  if (planv2 !== null && planv2.includes('**Status**: Draft')) {
    fail('docs/PROMPTCACHE_PLAN_V2.md: still contains stale header "**Status**: Draft"');
  }
  if (planv2 !== null && planv2.includes('Phase 3 is opt-in')) {
    fail('docs/PROMPTCACHE_PLAN_V2.md: still contains stale "Phase 3 is opt-in"');
  }

  // none of PLAN_V2 / README / ADOPTION may pair "default OFF" with the flags
  const defaultsOff = await checkNoStaleDefaultOffPairing();
  if (defaultsOff.length > 0) {
    for (const [file, line] of defaultsOff) {
      fail(`${file}: stale default-OFF pairing on line -> "${line}"`);
    }
  }
  ok();
}

async function checkNoStaleDefaultOffPairing() {
  const files = [
    'docs/PROMPTCACHE_PLAN_V2.md',
    'README.md',
    'docs/ADOPTION.md',
  ];
  const hits = [];
  for (const file of files) {
    const content = await read(file);
    if (content === null) continue; // missing-file failure already reported by read()
    content.split('\n').forEach((line, i) => {
      const off = /default OFF/i.test(line);
      const flags = /message separation|cache striping/i.test(line);
      if (off && flags) hits.push([file, `L${i + 1}: ${line.trim()}`]);
    });
  }
  return hits;
}

async function checkReadme() {
  process.stderr.write('(d) README default-ON ...');
  const content = await read('README.md');
  if (content === null) return; // missing-file failure already reported by read()
  const lines = content.split('\n');
  const target = lines.find((l) => l.includes('message separation + cache striping'));
  if (!target) {
    fail('README.md: no line mentions "message separation + cache striping"');
    return;
  }
  if (!/default ON/i.test(target)) {
    fail(`README.md: expected default-ON wording, got -> "${target.trim()}"`);
  }
  if (!target.includes('MEGACOMPACT_MESSAGE_SEPARATION=0') || !target.includes('MEGACOMPACT_CACHE_STRIPING=0')) {
    fail(`README.md: expected disable-with-=0 flags, got -> "${target.trim()}"`);
  }
  ok();
}

async function checkAdoption() {
  process.stderr.write('(e) ADOPTION rows default ON ...');
  const content = await read('docs/ADOPTION.md');
  if (content === null) return; // missing-file failure already reported by read()
  const lines = content.split('\n');
  const row = (flag) => {
    const line = lines.find((l) => l.includes(`\`${flag}\``) && l.includes('|'));
    if (!line) return { found: false, line: '' };
    return { found: true, line };
  };
  for (const flag of ['MEGACOMPACT_MESSAGE_SEPARATION', 'MEGACOMPACT_CACHE_STRIPING']) {
    const { found, line } = row(flag);
    if (!found) {
      fail(`docs/ADOPTION.md: no row for ${flag}`);
      continue;
    }
    const defaultCell = line.split('|').map((c) => c.trim());
    if (!defaultCell.some((c) => /^ON$/.test(c))) {
      fail(`docs/ADOPTION.md: ${flag} row default is not ON -> "${line.trim()}"`);
    }
  }
  ok();
}

/**
 * cache/_diagnostics-fixture.ts — VC7C acceptance-test fixture helpers.
 *
 * Reads conformance fixtures from the v2 `cache-diagnostics/` domain and provides
 * a flag-toggling wrapper for VC7C parity tests. Mirrors `_economics-fixture.ts`.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const V2 = join(here, "..", "..", "..", "conformance", "vector-cortex", "v2");
const DIR = join(V2, "cache-diagnostics");

/** Read + parse one conformance fixture by ID. */
export function diagnosticsFixture(id: string): Record<string, unknown> {
  const raw = readFileSync(join(DIR, `${id}.json`), "utf8");
  return JSON.parse(raw);
}

/** Run `fn` with MEGACOMPACT_VC7C set to `value`, restoring the prior value after. */
export function withVc7cFlag<T>(value: string, fn: () => T): T {
  const prior = process.env.MEGACOMPACT_VC7C;
  process.env.MEGACOMPACT_VC7C = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.MEGACOMPACT_VC7C;
    else process.env.MEGACOMPACT_VC7C = prior;
  }
}

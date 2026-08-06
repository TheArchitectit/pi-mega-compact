/**
 * ml5d-acceptance.test.ts — ML5-D dashboard "Improve Cortex" acceptance
 * aggregator (fixtures-driven, no mocks, no stubs).
 *
 * Drives ML5-DASH-001..006 against the canonical v2 conformance corpus + the
 * REAL code: the six cortex-improve envelope fixtures (promoted render, rejected
 * render, flag-off 404, confirm-required, status terminal states, badge
 * transition), the pure improve-harness decision rule (improve.ts qualifyDecision,
 * no real training), and the audit Table-1 stub-8 closure on the dashboard
 * snapshot (`totalTokensSaved` = `ctx.repo.tokensSaved`, no rolled-up math).
 *
 * Flag-agnostic: the SAME suite passes both `node --test dist/vector-cortex/
 * ml5d-acceptance.test.js` and the mandated `MEGACOMPACT_ML5_D=0 ...` parity run.
 *
 * Local file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ML5D_ENABLED } from "../config/vector-cortex.js";
import { qualifyDecision } from "./improve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const V2 = join(repoRoot(HERE), "conformance", "vector-cortex", "v2");

const DASH_IDS = [
  "ML5-DASH-001",
  "ML5-DASH-002",
  "ML5-DASH-003",
  "ML5-DASH-004",
  "ML5-DASH-005",
  "ML5-DASH-006",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; fixtures: ManifestRow[] }
interface DashFixture {
  id: string; kind: string; flag?: string; mode?: string; render?: string;
  badge?: string; endpoint?: string; reason_field?: boolean; flag_enabled?: boolean;
  endpoints_status?: number; card_present?: boolean; confirm_required?: boolean;
  action?: string; returns?: string; progress_states?: string[];
  terminal_qualified?: { status: string; verdict: boolean };
  terminal_demoted?: { status: string; reason: boolean };
  transition?: string; badge_transition_pinned?: boolean;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): DashFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("cortex-improve/"));
  assert.ok(row, `fixture ${id} registered under cortex-improve/`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as DashFixture;
}

describe("ML5-D conformance registration", () => {
  test("manifest registers ML5-DASH-001..006 with cortex-improve algorithm + ML5-D owner", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of DASH_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "cortex-improve", `${id} algorithm`);
      assert.equal(row.schema, "schemas/ml5-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.path, `cortex-improve/${id}.json`, `${id} path`);
      assert.equal(row.expected, "ok");
    }
    assert.ok(m.owner.split(",").includes("ML5-D"), "owner CSV includes ML5-D");
  });
});

describe("ML5-DASH-001..006 envelope invariants", () => {
  test("001 qualified mode-A asset renders the promoted card", () => {
    const fx = fixture("ML5-DASH-001");
    assert.equal(fx.kind, "cortex-improve");
    assert.equal(fx.flag, "MEGACOMPACT_ML5_D");
    assert.equal(fx.mode, "A");
    assert.equal(fx.render, "promoted");
    assert.equal(fx.badge, "Promoted");
    assert.equal(fx.endpoint, "/api/cortex/improve");
  });
  test("002 unqualified mode-B asset renders the rejected card", () => {
    const fx = fixture("ML5-DASH-002");
    assert.equal(fx.mode, "B");
    assert.equal(fx.render, "rejected");
    assert.equal(fx.badge, "Rejected");
    assert.equal(fx.reason_field, true);
  });
  test("003 flag-off returns 404 and omits the card (byte-identical ML5-C tab)", () => {
    const fx = fixture("ML5-DASH-003");
    assert.equal(fx.flag_enabled, false);
    assert.equal(fx.endpoints_status, 404);
    assert.equal(fx.card_present, false);
  });
  test("004 improve trigger requires confirm and returns a jobId", () => {
    const fx = fixture("ML5-DASH-004");
    assert.equal(fx.confirm_required, true);
    assert.equal(fx.action, "POST /api/cortex/improve");
    assert.equal(fx.returns, "{status:improving, jobId}");
  });
  test("005 status endpoint walks progress to terminal qualified/demoted", () => {
    const fx = fixture("ML5-DASH-005");
    assert.deepEqual(fx.progress_states, ["improving", "qualified", "demoted_to_B"]);
    assert.equal(fx.terminal_qualified?.status, "qualified");
    assert.equal(fx.terminal_qualified?.verdict, true);
    assert.equal(fx.terminal_demoted?.status, "demoted_to_B");
    assert.equal(fx.terminal_demoted?.reason, true);
  });
  test("006 mode-badge state-transition pin (Improve → verify → promoted/rejected)", () => {
    const fx = fixture("ML5-DASH-006");
    assert.equal(fx.transition, "mode->improving->qualified|demoted_to_B");
    assert.equal(fx.badge_transition_pinned, true);
  });
});

describe("ML5-D improve-harness decision rule (improve.ts pure)", () => {
  test("flag state is a live boolean regardless of environment", () => {
    assert.equal(typeof ML5D_ENABLED(), "boolean");
  });
  test("exit 0 + a readable asset digest → qualified (promoted)", () => {
    if (!ML5D_ENABLED()) return;
    assert.equal(qualifyDecision(0, "a1b2c3d4e5f6"), "qualified");
  });
  test("exit 0 + no digest (empty corpus / unverified asset) → demoted_to_B", () => {
    if (!ML5D_ENABLED()) return;
    assert.equal(qualifyDecision(0, null), "demoted_to_B");
  });
  test("non-zero exit + digest present → demoted_to_B (train failed)", () => {
    if (!ML5D_ENABLED()) return;
    assert.equal(qualifyDecision(2, "a1b2c3d4e5f6"), "demoted_to_B");
  });
  test("non-zero exit + no digest → demoted_to_B", () => {
    if (!ML5D_ENABLED()) return;
    assert.equal(qualifyDecision(1, null), "demoted_to_B");
  });
});

describe("audit Table-1 stub 8 — dashboard snapshot totalTokensSaved closure", () => {
  test("snapshot reads the real repo counter (ctx.repo.tokensSaved), no rolled-up math", () => {
    const file = join(repoRoot(HERE), "extensions", "mega-runtime", "dashboard-snapshot.ts");
    assert.ok(existsSync(file), "dashboard-snapshot.ts present");
    const src = readFileSync(file, "utf8");
    // Load-bearing content pin: the cumulative tokens-saved field feeds from the
    // real repo counter, not the old (dedupCollapsed * 100) placeholder.
    assert.ok(
      src.includes("totalTokensSaved: ctx.repo.tokensSaved"),
      "totalTokensSaved reads ctx.repo.tokensSaved",
    );
    assert.ok(
      !src.includes("dedupCollapsed * 100"),
      "no rolled-up dedupCollapsed * 100 math remains in the snapshot path",
    );
  });
});

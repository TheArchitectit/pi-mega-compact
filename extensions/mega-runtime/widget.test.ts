/**
 * widget.test.ts — S31 buildWidgetLines render snapshot matrix.
 *
 * buildWidgetLines is a free function (no pi runtime needed), so we drive it
 * directly with a fake WidgetData across the full matrix:
 *   6 themes × {full,minimal} × {gameMode on/off} × {cachePct<100, >=100}
 * and assert the S31 invariants:
 *  (a) transparent theme → no '\x1b[48;' bg fill on any line
 *  (b) non-transparent themes → at least one line carries '\x1b[48;'
 *  (c) minimal mode → exactly one content line (between the two panel bars)
 *  (d) gameMode off → no 'LVL' + no 'MEGA CACHE'
 *  (e) megaCacheFlare + gameMode on + megaCacheFlarePct>=100 → 'MEGA CACHE' text present
 *      (S53-C/D5: gate reads megaCacheFlarePct — the dedup rate that armed the
 *      flare — not cachePct, which after S53-C is the bounded 0–100 provider
 *      prompt-cache pct and would silently kill the flare.)
 *  (f) every line visibleWidth <= the terminal width passed in
 *
 * Uses MEGACOMPACT_STATE_DIR + mkdtemp (G7). No pi runtime.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildWidgetLines, type WidgetData } from "./widget.js";
import { THEME_IDS, DEFAULT_THEME, getTheme } from "../../src/config/themes.js";

/** A minimal but complete WidgetData (all required fields populated). The S31
 *  game-mode fields are overridden per-case. */
function baseWd(overrides: Partial<WidgetData> = {}): WidgetData {
	return {
		version: "0.0.0-test",
		tierLabel: "low",
		triggerLabel: "idle",
		pctStr: "42%",
		tokStr: "10k",
		maxStr: "200k",
		ctxPct: 0.42,
		chk: 3,
		agentStr: "",
		turnStr: "",
		dedupStr: "12%",
		sessIn: 1000,
		sessKept: 800,
		sTxt: "20",
		repoIn: 5000,
		repoKept: 4000,
		rTxt: "20",
		repoChk: 9,
		repoSess: 2,
		modelStr: "test-model",
		sinceCompact: null,
		embedderName: "Trigram",
		compStr: "1.2x",
		driftStatus: "ok",
		agentsActive: false,
		fresh: false,
		ticker: [],
		lastWhy: undefined,
		tierTrace: undefined,
		pulsing: false,
		...overrides,
	};
}

const WIDTH = 120;

function contentLines(lines: string[]): string[] {
	// Strip the top + bottom panel bars; what's left is the content body.
	return lines.slice(1, lines.length - 1);
}

describe("buildWidgetLines (S31)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "mc-widget-"));
		process.env.MEGACOMPACT_STATE_DIR = dir;
	});
	after(() => {
		delete process.env.MEGACOMPACT_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("null wd → warm-up panel (3 lines, all width-safe)", () => {
		const lines = buildWidgetLines(null, WIDTH, 0);
		assert.equal(lines.length, 3);
		for (const l of lines) assert.ok(visibleWidth(l) <= WIDTH, "width safe");
	});

	for (const theme of THEME_IDS) {
		for (const tuiMode of ["full", "minimal"] as const) {
			for (const gameMode of [false, true] as const) {
				for (const cachePct of [42, 150] as const) {
					const flare = cachePct >= 100;
					const label = `theme=${theme} tui=${tuiMode} game=${gameMode} cache=${cachePct}`;
					it(label, () => {
						const wd = baseWd({
							theme,
							tuiMode,
							gameMode,
							level: 1,
							cachePct,
							megaCacheFlare: flare,
							// S53-C/D5: the flare gate reads megaCacheFlarePct (the dedup
							// hit rate that armed it — can legitimately exceed 100%), not
							// cachePct (now the bounded 0–100 provider prompt-cache pct).
							// The fixture arms the flare from the same dedup rate it sets as
							// cachePct, so the gate fires identically to pre-D5 behavior.
							megaCacheFlarePct: cachePct,
						});
						const lines = buildWidgetLines(wd, WIDTH, 0);
						const body = contentLines(lines);
						const joined = lines.join("\n");

						// (f) every line width <= terminal (truncateToWidth respected)
						for (const l of lines) {
							assert.ok(
								visibleWidth(l) <= WIDTH,
								`width safe: ${visibleWidth(l)} > ${WIDTH}`,
							);
						}

						// (a) transparent theme → no '\x1b[48;' bg fill anywhere
						if (theme === DEFAULT_THEME) {
							assert.ok(
								!joined.includes("\x1b[48;"),
								`transparent has no 48; bg fill: ${label}`,
							);
						} else {
							// (b) non-transparent themes → their bg SGR appears on some line.
							// (Themes may use 3-bit bg like \x1b[40m, not just 48;5; form.)
							const bgParams = getTheme(theme)!.ansi.bg!;
							const bgEsc = `\x1b[${bgParams}m`;
							assert.ok(
								joined.includes(bgEsc),
								`themed has bg fill ${bgEsc}: ${label}`,
							);
						}

						// (c) minimal mode → exactly one content line
						if (tuiMode === "minimal") {
							assert.equal(body.length, 1, `minimal one line: ${label}`);
						}

						// (d) gameMode off → no LVL + no MEGA CACHE
						if (!gameMode) {
							assert.ok(!joined.includes("LVL"), `no LVL when off: ${label}`);
							assert.ok(
								!joined.includes("MEGA CACHE"),
								`no MEGA CACHE when off: ${label}`,
							);
						} else {
							// gameMode on → LVL shown (in full mode header, or minimal line)
							assert.ok(joined.includes("LVL"), `LVL shown when on: ${label}`);
						}

						// (e) MEGA CACHE flare text appears only when flare + gameMode on
						const expectMega = flare && gameMode;
						const hasMega = joined.includes("MEGA CACHE");
						assert.equal(
							hasMega,
							expectMega,
							`MEGA CACHE flare: ${label} (got ${hasMega}, want ${expectMega})`,
						);
					});
				}
			}
		}
	}
});


describe("buildWidgetLines ambient border effect (v0.8.3)", () => {
  const effBase = (overrides: Partial<WidgetData> = {}): WidgetData => baseWd({
    theme: DEFAULT_THEME, tuiMode: "full", gameMode: true, level: 1, cachePct: 42, ...overrides,
  });
  const isBorder = (l: string): boolean => l.includes("─");

  it("activeEffect (pulse, mid-window) -> border lines carry a 256-color fg SGR", () => {
    const ae = { type: "pulse" as const, role: "accent" as const, startedAt: Date.now() - 250, durationMs: 2000 };
    const lines = buildWidgetLines(effBase({ activeEffect: ae }), WIDTH, 0);
    const borders = lines.filter(isBorder);
    assert.ok(borders.length >= 2, "has top + bottom borders");
    for (const b of borders) {
      assert.ok(b.includes("\x1b[38;5;"), `border carries 256-color fg: ${JSON.stringify(b)}`);
    }
  });

  it("activeEffect null -> plain borders, no 38;5 fg SGR on border lines", () => {
    const lines = buildWidgetLines(effBase({ activeEffect: null }), WIDTH, 0);
    const borders = lines.filter(isBorder);
    for (const b of borders) {
      assert.ok(!b.includes("\x1b[38;5;"), `no effect SGR on plain border: ${JSON.stringify(b)}`);
    }
  });

  it("expired activeEffect -> plain borders (per-frame expiry enforced)", () => {
    const ae = { type: "pulse" as const, role: "accent" as const, startedAt: Date.now() - 5000, durationMs: 1000 };
    const lines = buildWidgetLines(effBase({ activeEffect: ae }), WIDTH, 0);
    const borders = lines.filter(isBorder);
    for (const b of borders) {
      assert.ok(!b.includes("\x1b[38;5;"), `expired effect -> plain border: ${JSON.stringify(b)}`);
    }
  });

  it("activeEffect border lines are width-safe (pulse, minimal + full)", () => {
    for (const tuiMode of ["minimal", "full"] as const) {
      const ae = { type: "pulse" as const, role: "mega" as const, startedAt: Date.now() - 100, durationMs: 2000 };
      const lines = buildWidgetLines(effBase({ activeEffect: ae, tuiMode }), 60, 0);
      for (const l of lines) assert.ok(visibleWidth(l) <= 60, `width safe (${tuiMode}): ${visibleWidth(l)}`);
    }
  });

  it("flash effect mid-window border carries the full base index SGR", () => {
    // Force an 'on' phase of the 120ms alternate by starting just now.
    const ae = { type: "flash" as const, role: "red" as const, startedAt: Date.now(), durationMs: 1200 };
    const lines = buildWidgetLines(effBase({ activeEffect: ae }), WIDTH, 0);
    const borders = lines.filter(isBorder);
    assert.ok(borders.some((b) => b.includes("\x1b[38;5;203m")), `flash-on phase uses red base 203`);
  });
});

describe("buildWidgetLines footer stability (P1 — no 250ms rotation)", () => {
  // P1: the L5 ticker branch used to re-pick the head text every 250ms via
  // `step = floor(Date.now()/250)`, flipping the footer line on a 250·N ms
  // cycle. After the fix it pins to the most-recent entry, so two renders of
  // the SAME WidgetData at t and t+500ms (well past one rotation slot) must
  // produce byte-identical footer lines. Proves the metronome is gone.
  const stabBase = (overrides: Partial<WidgetData> = {}): WidgetData => baseWd({
    theme: DEFAULT_THEME, tuiMode: "full", gameMode: false, level: 1, cachePct: 42, ...overrides,
  });

  it("ticker footer is byte-identical across simulated frames 500ms apart", () => {
    const wd = stabBase({
      ticker: [
        { text: "first", at: 1000 },
        { text: "second", at: 2000 },
        { text: "third", at: 3000 },
      ],
      lastWhy: "because",
    });
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000; // t
      const a = buildWidgetLines(wd, WIDTH, 0);
      Date.now = () => 1_000_500; // t+500ms (would have rotated twice under the old code)
      const b = buildWidgetLines(wd, WIDTH, 0);
      assert.deepEqual(a, b, "footer byte-identical across 500ms with no state change");
      // And the pinned head is the most-recent entry (third), not a rotation:
      assert.ok(a.some((l) => l.includes("third")), "shows most-recent ticker entry");
      assert.ok(a.some((l) => l.includes("(+2 more)")), "(+N more) suffix preserved");
      assert.ok(a.some((l) => l.includes("because")), "lastWhy preserved");
    } finally {
      Date.now = realNow;
    }
  });

  it("footer still flips when the ticker actually changes (new pushTicker)", () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const before = buildWidgetLines(stabBase({ ticker: [{ text: "a", at: 1 }] }), WIDTH, 0);
      const after = buildWidgetLines(stabBase({ ticker: [{ text: "a", at: 1 }, { text: "b", at: 2 }] }), WIDTH, 0);
      assert.notDeepEqual(before, after, "footer changes when ticker grows");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("buildWidgetLines achievement flare (S35)", () => {
  const achBase = (overrides: Partial<WidgetData> = {}): WidgetData => baseWd({
    theme: DEFAULT_THEME, tuiMode: "full", gameMode: true, level: 1, cachePct: 42, ...overrides,
  });
  it("achievementFlare + titles -> renders the unlock toast line", () => {
    const lines = buildWidgetLines(achBase({ achievementFlare: true, achievementFlareTitles: ["First Compact"] }), WIDTH, 0);
    assert.ok(lines.some((l) => l.includes("Achievement unlocked: First Compact")), "toast line present");
  });
  it("achievementFlare off -> no toast line", () => {
    const lines = buildWidgetLines(achBase({ achievementFlare: false, achievementFlareTitles: ["First Compact"] }), WIDTH, 0);
    assert.ok(!lines.some((l) => l.includes("Achievement unlocked")), "no toast when flare off");
  });
  it("gameMode off -> no toast even if flare set", () => {
    const lines = buildWidgetLines(achBase({ gameMode: false, achievementFlare: true, achievementFlareTitles: ["X"] }), WIDTH, 0);
    assert.ok(!lines.some((l) => l.includes("Achievement unlocked")), "no toast when game off");
  });
  it("achievement toast is width-safe", () => {
    const lines = buildWidgetLines(achBase({ achievementFlare: true, achievementFlareTitles: ["First Compact", "Turn Veteran"] }), 60, 0);
    for (const l of lines) assert.ok(visibleWidth(l) <= 60, "width safe");
  });
});

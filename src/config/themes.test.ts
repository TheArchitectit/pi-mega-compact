/**
 * themes.test.ts — S30 theme palette source-of-truth tests.
 * Pi-agnostic: no pi runtime imports.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THEMES,
  THEME_IDS,
  DEFAULT_THEME,
  getTheme,
  isValidTheme,
  nextTheme,
} from "./themes.js";

describe("themes (S30)", () => {
  it("defines exactly 6 themes", () => {
    assert.equal(THEMES.length, 6);
    assert.equal(THEME_IDS.length, 6);
  });

  it("has unique ids", () => {
    assert.equal(new Set(THEME_IDS).size, 6);
  });

  it("default theme is transparent", () => {
    assert.equal(DEFAULT_THEME, "transparent");
    assert.ok(isValidTheme(DEFAULT_THEME));
  });

  it("includes retro, orange-bold, cyan-neon, amber-mono, grayscale", () => {
    for (const id of ["retro", "orange-bold", "cyan-neon", "amber-mono", "grayscale"]) {
      assert.ok(isValidTheme(id), `missing ${id}`);
    }
  });

  it("transparent theme has null bg (CSS + ANSI)", () => {
    const t = getTheme("transparent");
    assert.ok(t);
    assert.equal(t!.css.bg, null);
    assert.equal(t!.ansi.bg, null);
  });

  it("every non-transparent theme has a non-null bg", () => {
    for (const t of THEMES) {
      if (t.id === "transparent") continue;
      assert.ok(t.css.bg, `${t.id} css.bg`);
      assert.ok(t.ansi.bg, `${t.id} ansi.bg`);
    }
  });

  it("every theme has css + ansi {fg,accent,mega} strings", () => {
    for (const t of THEMES) {
      assert.ok(typeof t.css.fg === "string" && t.css.fg.startsWith("#"));
      assert.ok(typeof t.css.accent === "string");
      assert.ok(typeof t.css.mega === "string");
      assert.ok(typeof t.ansi.fg === "string");
      assert.ok(typeof t.ansi.accent === "string");
      assert.ok(typeof t.ansi.mega === "string");
    }
  });

  it("getTheme returns undefined for unknown id", () => {
    assert.equal(getTheme("nope"), undefined);
  });

  it("isValidTheme is false for unknown", () => {
    assert.equal(isValidTheme("nope"), false);
  });

  it("nextTheme cycles through all themes and wraps", () => {
    const seen: string[] = [];
    let cur = DEFAULT_THEME;
    for (let i = 0; i < THEME_IDS.length; i++) {
      cur = nextTheme(cur);
      seen.push(cur);
    }
    // after N steps we've visited every theme once
    assert.equal(new Set(seen).size, THEME_IDS.length);
    // wraps: one more step from the last returns to the first
    const first = nextTheme(THEME_IDS[THEME_IDS.length - 1]!);
    assert.equal(first, THEME_IDS[0]);
  });

  it("nextTheme falls back to DEFAULT_THEME for unknown current", () => {
    assert.equal(nextTheme("garbage"), DEFAULT_THEME);
  });
});

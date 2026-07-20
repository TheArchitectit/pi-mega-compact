/**
 * html.test.ts — S34 Game Mode tab presence in the dashboard HTML template.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dashboardHtml } from "./html.js";

describe("S34 dashboard HTML Game Mode", () => {
  const html = dashboardHtml("custom");
  test("Game Mode tab button + panel-game exist", () => {
    assert.ok(
      html.includes('<button class="tab" data-tab="game">Game Mode</button>'),
      "game tab button present",
    );
    assert.ok(html.includes('<div class="tab-panel" id="panel-game">'), "panel-game present");
  });
  test("level-up-pulse + mega-flash keyframes present", () => {
    assert.ok(html.includes("@keyframes level-up-pulse"), "level-up-pulse keyframe present");
    assert.ok(html.includes("@keyframes mega-flash"), "mega-flash keyframe present");
  });
  test("empty-state string present", () => {
    assert.ok(
      html.includes("No scores yet — run a session with game mode on."),
      "empty-state string present",
    );
  });
});


describe("S35 dashboard HTML achievements", () => {
  const html = dashboardHtml("custom");
  test("Achievements heading + ach-tiles/ach-toast containers present", () => {
    assert.ok(html.includes(">Achievements</h3>"), "Achievements heading present");
    assert.ok(html.includes('id="ach-tiles"'), "ach-tiles container present");
    assert.ok(html.includes('id="ach-toast"'), "ach-toast element present");
  });
  test("ach-unlock-pulse keyframe + ach-tile classes present", () => {
    assert.ok(html.includes("@keyframes ach-unlock-pulse"), "ach-unlock-pulse keyframe present");
    assert.ok(html.includes(".ach-tile"), "ach-tile class present");
    assert.ok(html.includes(".ach-tile.unlocked"), "unlocked class present");
    assert.ok(html.includes(".ach-tile.locked"), "locked class present");
  });
  test("renderAchievements fn + GET /api/achievements fetch present", () => {
    assert.ok(html.includes("function renderAchievements"), "renderAchievements fn present");
    assert.ok(html.includes("fetch('/api/achievements')"), "achievements fetch present");
  });
  test("visible-but-locked teaser string present", () => {
    assert.ok(html.includes("??? "), "??? teaser present");
  });
});

describe("S35 dashboard HTML achievements escaping (v0.8.4 fix)", () => {
  const html = dashboardHtml("custom");
  test("Opie's Wild Ride JS string is backslash-escaped (no bare apostrophe)", () => {
    // The served <script> uses single-quoted JS strings: '🏆 Opie\'s Wild Ride...'.
    // A bare apostrophe (Opie's) would terminate the string and halt the script,
    // breaking .tab click bindings. The served HTML MUST contain the escaped
    // form Opie\'s and MUST NOT contain the bare form '🏆 Opie's'.
    assert.ok(html.includes("🏆 Opie\\'s Wild Ride"), "served JS contains Opie\\'s (escaped)");
    assert.ok(!html.includes("🏆 Opie's Wild Ride"), "no bare Opie's in served JS");
  });
});

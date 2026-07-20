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

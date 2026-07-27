/**
 * dashboard-client.ts — thin concatenator for the dashboard's embedded client JS.
 *
 * The actual JS lives in three sibling files — dashboard-client-core.ts
 * (snapshot + SSE), dashboard-client-repos.ts (multi-repo index), and
 * dashboard-client-game.ts (game-mode + achievements + perf + tabs). Each
 * exports its JS as a verbatim string; this file wraps them in the shared IIFE.
 *
 * Split from html.ts (PR0) — ZERO behavior change. The JS is one closure, so
 * the chunks must concatenate in order: core → repos → game.
 */

import { dashboardClientCoreJs } from "./dashboard-client-core.js";
import { dashboardClientReposJs } from "./dashboard-client-repos.js";
import { dashboardClientGameJs } from "./dashboard-client-game.js";

/** The full embedded client JS — an IIFE wrapping the three chunks in order. */
export function dashboardClientJs(): string {
  return `(function() {
${dashboardClientCoreJs()}${dashboardClientReposJs()}${dashboardClientGameJs()}`;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertRepoRegistry } from "./store/sqlite.js";
import { detectCrossRepoDrift } from "./driftDetection.js";

const NOW = Math.floor(Date.now() / 1000);
const D = 86_400;

test("driftDetection: empty registry returns ok report", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-empty-"));
  try {
    const report = detectCrossRepoDrift(dir);
    assert.equal(report.totals.ok, 0);
    assert.equal(report.totals.warn, 0);
    assert.equal(report.repos.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driftDetection: flags stale repos older than 30 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-stale-"));
  try {
    upsertRepoRegistry(
      { repoRoot: "/r/old", displayName: "old", stateDir: "/r/old", checkpointCount: 1, tokensSaved: 0, compressedOriginalBytes: 0, lastSeen: NOW - 45 * D },
      dir,
    );
    const report = detectCrossRepoDrift(dir);
    assert.equal(report.repos.length, 1);
    assert.ok(report.repos[0].signals.some((s) => s.kind === "stale"), "stale signal present");
    assert.equal(report.repos[0].status, "ok", "stale alone is info, not warn");
    assert.equal(report.totals.stale, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driftDetection: active repo with no compaction flagged as warn", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-lag-"));
  try {
    upsertRepoRegistry(
      { repoRoot: "/r/active", displayName: "active", stateDir: "/r/active", checkpointCount: 1, tokensSaved: 0, compressedOriginalBytes: 0, lastSeen: NOW - 1 * D },
      dir,
    );
    const report = detectCrossRepoDrift(dir);
    const r = report.repos[0];
    assert.ok(r.signals.some((s) => s.kind === "compaction_lag"), "lag signal present");
    assert.equal(r.status, "warn", "compaction lag is warn-level");
    assert.equal(report.totals.warn, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driftDetection: active repo with recent compaction is ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-ok-"));
  try {
    upsertRepoRegistry(
      { repoRoot: "/r/healthy", displayName: "healthy", stateDir: "/r/healthy", checkpointCount: 1, tokensSaved: 0, compressedOriginalBytes: 0, lastSeen: NOW, lastCompactedAt: NOW },
      dir,
    );
    const report = detectCrossRepoDrift(dir);
    const r = report.repos[0];
    assert.equal(r.status, "ok");
    assert.equal(r.signals.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driftDetection: recent model churn flagged as info", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-model-"));
  try {
    upsertRepoRegistry(
      {
        repoRoot: "/r/swap",
        displayName: "swap",
        stateDir: "/r/swap",
        checkpointCount: 1,
        tokensSaved: 0,
        compressedOriginalBytes: 0,
        lastSeen: NOW,
        lastCompactedAt: NOW,
        provider: "anthropic",
        providerName: "Anthropic",
        modelName: "sonnet-4.6",
        modelCapturedAt: NOW - 1 * D,
      },
      dir,
    );
    const report = detectCrossRepoDrift(dir);
    assert.ok(report.repos[0].signals.some((s) => s.kind === "model_churn"), "model churn detected");
    assert.equal(report.totals.modelChurn, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
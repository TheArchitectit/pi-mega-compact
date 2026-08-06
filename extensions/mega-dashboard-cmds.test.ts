/**
 * VC0F — dashboard restart-on-upgrade (session_start auto-restart).
 *
 * Unit tests for `bounceStaleRunnerIfAny`: version-mismatch bounce (C1),
 * never-throws on fetch failure (C1), the once-per-process gate (C2), the
 * port.pid marker-version shortcut (B2) that skips the HTTP probe, and
 * multi-repo isolation (C3) — a stale server in repo A is killed while a live
 * current-version server in repo B is untouched.
 *
 * No network (PREVENT-PI-004): every primitive is a stubbed dependency, so no
 * real localhost probe ever runs in these tests.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bounceStaleRunnerIfAny,
  resetStalenessGateForTests,
  type BounceStaleDeps,
} from "./mega-dashboard-cmds.js";

interface StubResult {
  deps: BounceStaleDeps;
  killed: { port: number }[];
  notified: string[];
  versionProbes: number[];
  /** Set the version the live HTTP probe reports (records it in versionProbes). */
  setRunning: (v: string) => void;
}

/**
 * Build a stubbed, healthy dependency set. The HTTP `serverVersion` reads a
 * mutable `running` value into the shared `versionProbes` array so tests can
 * assert BOTH the probe was attempted AND the version it returned. Other
 * primitives are overridable via `overrides`.
 */
function stub(overrides: Partial<BounceStaleDeps> = {}): StubResult {
  const killed: { port: number }[] = [];
  const notified: string[] = [];
  const versionProbes: number[] = [];
  let running = "0.20.25";
  const deps: BounceStaleDeps = {
    isServerRunning: async () => ({ port: 9320, url: "http://localhost:9320", hasPidFile: true }), // guardrails-allow PREVENT-PI-004: localhost dashboard URL literal in a stubbed dependency — this test makes no network call
    serverVersion: async (port) => {
      versionProbes.push(port);
      return running;
    },
    markerVersion: () => null, // pre-B2 marker → default exercises the HTTP path
    ownVersion: () => "0.20.25",
    killServerOnPort: (port) => {
      killed.push({ port });
    },
    notify: (msg) => {
      notified.push(msg);
    },
    ...overrides,
  };
  return { deps, killed, notified, versionProbes, setRunning: (v) => { running = v; } };
}

describe("bounceStaleRunnerIfAny (VC0F)", () => {
  // Each test starts with a clean once-per-process gate.
  beforeEach(() => resetStalenessGateForTests());

  it("C1: bounces (kill + notify) when the running version differs from own (HTTP path)", async () => {
    const s = stub();
    s.setRunning("0.20.24"); // stale
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: true });
    assert.equal(s.killed.length, 1);
    assert.equal(s.killed[0].port, 9320);
    assert.equal(s.notified.length, 1);
    assert.deepEqual(s.versionProbes, [9320]); // marker-less → HTTP probe used
  });

  it("C1: does NOT bounce when versions match (HTTP path)", async () => {
    const s = stub(); // running defaults to "0.20.25" == own
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: false });
    assert.equal(s.killed.length, 0);
    assert.equal(s.notified.length, 0);
  });

  it("C1: never throws on a fetch/version failure — returns bounced:false", async () => {
    const s = stub({
      serverVersion: async () => {
        throw new Error("fetch failed");
      },
    });
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: false });
    assert.equal(s.killed.length, 0);
  });

  it("C1: is fatal-free when isServerRunning itself throws", async () => {
    const s = stub({
      isServerRunning: async () => {
        throw new Error("probe failed");
      },
    });
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: false });
    assert.equal(s.killed.length, 0);
  });

  it("C1: an orphan (live server with no marker) is always bounced", async () => {
    const s = stub({
      isServerRunning: async () => ({ port: 9320, url: "http://localhost:9320", hasPidFile: false }), // guardrails-allow PREVENT-PI-004: localhost dashboard URL literal in a stubbed dependency — this test makes no network call
    });
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: true });
    assert.equal(s.killed.length, 1);
    assert.equal(s.versionProbes.length, 0); // orphan → no HTTP probe needed
  });

  it("C1: does nothing when no server is running", async () => {
    const s = stub({ isServerRunning: async () => null });
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: false });
    assert.equal(s.killed.length, 0);
  });

  it("B2: marker-version mismatch bounces WITHOUT an HTTP probe", async () => {
    const s = stub({
      markerVersion: () => "0.20.24", // stamped marker is old
    });
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: true });
    assert.equal(s.killed.length, 1);
    assert.equal(s.versionProbes.length, 0); // marker shortcut skipped the HTTP probe
  });

  it("B2: matching marker-version reuses the live server WITHOUT an HTTP probe", async () => {
    const s = stub({
      markerVersion: () => "0.20.25",
    });
    const r = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(r, { bounced: false });
    assert.equal(s.killed.length, 0);
    assert.equal(s.versionProbes.length, 0);
  });

  it("C2: once-per-process gate — a second call short-circuits (no repeated kill)", async () => {
    const s = stub();
    s.setRunning("0.20.24"); // stale
    const first = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(first, { bounced: true });
    assert.equal(s.killed.length, 1);

    // Same deps, SAME process gate (not reset) → the second call must skip
    // the probe entirely and not kill again.
    const second = await bounceStaleRunnerIfAny(s.deps);
    assert.deepEqual(second, { bounced: false });
    assert.equal(s.killed.length, 1);
  });

  it("C3: multi-repo isolation — a stale repo-A server is killed but repo B's live current server is untouched", async () => {
    const repoA = stub({
      isServerRunning: async () => ({ port: 9320, url: "http://localhost:9320", hasPidFile: true }), // guardrails-allow PREVENT-PI-004: localhost dashboard URL literal in a stubbed dependency — this test makes no network call
    });
    repoA.setRunning("0.20.24"); // stale
    const repoB = stub({
      isServerRunning: async () => ({ port: 9321, url: "http://localhost:9321", hasPidFile: true }), // guardrails-allow PREVENT-PI-004: localhost dashboard URL literal in a stubbed dependency — this test makes no network call
    });
    // repoB.running stays "0.20.25" == own → current

    resetStalenessGateForTests();
    const ra = await bounceStaleRunnerIfAny(repoA.deps);
    assert.deepEqual(ra, { bounced: true });
    assert.equal(repoA.killed.length, 1);
    assert.equal(repoA.killed[0].port, 9320);

    resetStalenessGateForTests();
    const rb = await bounceStaleRunnerIfAny(repoB.deps);
    assert.deepEqual(rb, { bounced: false });
    assert.equal(repoB.killed.length, 0); // different repo, different port → not touched
  });
});

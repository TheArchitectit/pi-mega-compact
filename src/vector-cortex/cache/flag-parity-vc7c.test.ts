/**
 * cache/flag-parity-vc7c.test.ts — VC7C feature-flag parity contract.
 *
 * The flag `MEGACOMPACT_VC7C` gates ONLY the reporter/dashboard seam. The
 * classifier arithmetic in `./diagnostics.ts` and the blocked-serve DECISION
 * in `./breaker.ts` / `./diagnostics-emit.ts` are PURE and flag-independent:
 * flag-off is byte-identical to the predecessor (VC7B), so the same class a
 * user sees today, they see tomorrow.
 *
 * This suite pins that contract:
 *   - flag ON  -> the emitter receives BOTH events (classified + serve-blocked).
 *   - flag OFF -> the emitter receives NEITHER (the dashboard is never touched).
 *   - the payload is never payload-bearing: no request digest, no covered range,
 *     no profile id leaks into the emitted record (SECURITY_PRIVACY: payload-free
 *     by construction).
 *   - a throwing emitter is non-fatal; an absent emitter is a silent no-op.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyMiss, isTransientMiss } from "./diagnostics.js";
import { reportCacheMissClassified, reportCacheServeBlocked } from "./diagnostics-emit.js";
import { deriveRequestHashV2 } from "../migrations/request-hash-v2.js";

/** Run `fn` with `MEGACOMPACT_VC7C` set to `value`, then restore the env. */
function withVc7cFlag(value: "0" | "1", fn: () => void): void {
  const prev = process.env["MEGACOMPACT_VC7C"];
  process.env["MEGACOMPACT_VC7C"] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["MEGACOMPACT_VC7C"];
    else process.env["MEGACOMPACT_VC7C"] = prev;
  }
}

type Emitted = { name: string; payload: unknown };

function recorder(): { emit: (name: string, payload: unknown) => void; seen: Emitted[] } {
  const seen: Emitted[] = [];
  return { emit: (name, payload) => seen.push({ name, payload }), seen };
}

/**
 * A canonical "what would an operator see" string over ALL six classes plus the
 * cold key. It is computed entirely from the pure classifier, so it is identical
 * under either flag value — flag parity is about the EMITTER, not this function.
 */
function summary(): string {
  const rows: Array<[string, ReturnType<typeof classifyMiss>]> = [
    ["profile", classifyMiss({ requestProfileId: "p", cachedProfileId: "q", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false })],
    ["range", classifyMiss({ requestProfileId: "p", cachedProfileId: "p", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:b", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false })],
    ["dependency", classifyMiss({ requestProfileId: "p", cachedProfileId: "p", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 5n, cachedDependencyHighWater: 1n, generationInvalidated: false })],
    ["request", classifyMiss({ requestProfileId: "p", cachedProfileId: "p", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "s", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false })],
    ["generation", classifyMiss({ requestProfileId: "p", cachedProfileId: "p", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: true })],
    ["unknown", classifyMiss({ requestProfileId: "p", cachedProfileId: "p", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false })],
    ["cold", classifyMiss({ requestProfileId: "p", cachedProfileId: null, requestProfileVersion: "v1", cachedProfileVersion: null, requestCoveredDigest: "sha256:a", cachedCoveredDigest: null, requestedRangeCount: 1, cachedRangeCount: null, requestDigest: "r", cachedRequestDigest: null, requestDependencyHighWater: 1n, cachedDependencyHighWater: null, generationInvalidated: false })],
  ];
  return rows
    .map(([label, d]) => `${label}:${d.missClass}:transient=${isTransientMiss(d)}`)
    .join("|");
}

test("VC7C parity: the classifier result is identical with the flag ON or OFF", () => {
  let on = "";
  let off = "";
  withVc7cFlag("1", () => (on = summary()));
  withVc7cFlag("0", () => (off = summary()));
  assert.equal(on, off, "the arithmetic must not depend on the reporter flag");
});

test("VC7C parity: flag ON emits both the classified and the serve-blocked events", () => {
  withVc7cFlag("1", () => {
    const { emit, seen } = recorder();
    const diag = classifyMiss({ requestProfileId: "p", cachedProfileId: "q", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false });
    reportCacheMissClassified(emit, diag);
    reportCacheServeBlocked(emit, { missClass: diag.missClass, triadState: "OPEN_B", reason: "profile-mismatch" });
    const names = seen.map((s) => s.name);
    assert.ok(names.includes("vector_cortex_cache_miss_classified"), JSON.stringify(names));
    assert.ok(names.includes("vector_cortex_cache_serve_blocked"), JSON.stringify(names));
  });
});

test("VC7C parity: flag OFF emits NEITHER event (dashboard is untouched)", () => {
  withVc7cFlag("0", () => {
    const { emit, seen } = recorder();
    const diag = classifyMiss({ requestProfileId: "p", cachedProfileId: "q", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false });
    reportCacheMissClassified(emit, diag);
    reportCacheServeBlocked(emit, { missClass: diag.missClass, triadState: "OPEN_B", reason: "profile-mismatch" });
    assert.deepEqual(seen, [], "flag OFF must be byte-identical to the pre-VC7C dashboard seam");
  });
});

test("VC7C parity: the emitted payload is payload-free (no digest, range, or profile id)", () => {
  withVc7cFlag("1", () => {
    const { emit, seen } = recorder();
    const diag = classifyMiss({ requestProfileId: "anthropic-claude-opus", cachedProfileId: "anthropic-claude-sonnet", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:deadbeef", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "reqdigest0123", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false });
    reportCacheMissClassified(emit, diag);
    for (const { payload } of seen) {
      const flat = JSON.stringify(payload).toLowerCase();
      assert.ok(!flat.includes("deadbeef"), "covered range must never leak");
      assert.ok(!flat.includes("reqdigest0123"), "request digest must never leak");
      assert.ok(!flat.includes("anthropic-claude"), "profile id must never leak");
    }
  });
});

test("VC7C parity: a throwing emitter is non-fatal (the agent loop must not break)", () => {
  withVc7cFlag("1", () => {
    const boom = () => {
      throw new Error("dashboard down");
    };
    const diag = classifyMiss({ requestProfileId: "p", cachedProfileId: "q", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false });
    assert.doesNotThrow(() => reportCacheMissClassified(boom, diag), "emit failures are swallowed");
    assert.doesNotThrow(() => reportCacheServeBlocked(boom, { missClass: diag.missClass, triadState: "OPEN_B", reason: "x" }));
  });
});

test("VC7C parity: an absent emitter (undefined) is a silent no-op", () => {
  withVc7cFlag("1", () => {
    const diag = classifyMiss({ requestProfileId: "p", cachedProfileId: "q", requestProfileVersion: "v1", cachedProfileVersion: "v1", requestCoveredDigest: "sha256:a", cachedCoveredDigest: "sha256:a", requestedRangeCount: 1, cachedRangeCount: 1, requestDigest: "r", cachedRequestDigest: "r", requestDependencyHighWater: 1n, cachedDependencyHighWater: 1n, generationInvalidated: false });
    assert.doesNotThrow(() => reportCacheMissClassified(undefined, diag), "undefined emit is the default prod path");
  });
});

test("VC7C parity: deriveRequestHashV2 is unaffected by the reporter flag", () => {
  const a = hashWithFlag("1");
  const b = hashWithFlag("0");
  assert.equal(a, b, "the M5 identity derivation is part of the PURE arithmetic");
  assert.match(a, /^[0-9a-f]+$/, "production returns BARE lowercase hex (no prefix)");
  assert.ok(a.length >= 64, "a SHA-256 hex digest is 64 chars");
});

function hashWithFlag(value: "0" | "1"): string {
  const prev = process.env["MEGACOMPACT_VC7C"];
  process.env["MEGACOMPACT_VC7C"] = value;
  try {
    return deriveRequestHashV2("profile-x", "reqdigest0123", "2026-08");
  } finally {
    if (prev === undefined) delete process.env["MEGACOMPACT_VC7C"];
    else process.env["MEGACOMPACT_VC7C"] = prev;
  }
}

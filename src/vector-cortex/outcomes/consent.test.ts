/**
 * outcomes/consent.test.ts — VC8A consent grant/revoke tests.
 *
 * Tests grant/revoke sequence, effective consent at time T, and consent
 * high-water evaluation. Uses the real production modules — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  appendGrant,
  appendRevoke,
  hasActiveConsent,
  consentHighWater,
} from "./consent.js";
import { CONSENT_SCHEMA_V1, type ConsentV1 } from "./types.js";

describe("VC8A consent", () => {
  test("a grant gives active consent at its effective sequence", () => {
    const records: ConsentV1[] = [
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
    ];
    assert.equal(hasActiveConsent(records, "sess-a", 1), true);
  });

  test("no records means no active consent", () => {
    assert.equal(hasActiveConsent([], "sess-a", 1), false);
  });

  test("a grant at seq 5 is not active before seq 5", () => {
    const records: ConsentV1[] = [
      appendGrant("sess-a", 5, "2026-01-01T00:00:00Z"),
    ];
    assert.equal(hasActiveConsent(records, "sess-a", 4), false);
  });

  test("grant then revoke — revoke wins at its effective sequence", () => {
    const records: ConsentV1[] = [
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
      appendRevoke("sess-a", 2, "2026-01-02T00:00:00Z"),
    ];
    assert.equal(hasActiveConsent(records, "sess-a", 1), true);
    assert.equal(hasActiveConsent(records, "sess-a", 2), false);
    assert.equal(hasActiveConsent(records, "sess-a", 3), false);
  });

  test("grant, revoke, re-grant — re-grant wins after its effective sequence", () => {
    const records: ConsentV1[] = [
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
      appendRevoke("sess-a", 2, "2026-01-02T00:00:00Z"),
      appendGrant("sess-a", 3, "2026-01-03T00:00:00Z"),
    ];
    assert.equal(hasActiveConsent(records, "sess-a", 2), false);
    assert.equal(hasActiveConsent(records, "sess-a", 3), true);
    assert.equal(hasActiveConsent(records, "sess-a", 10), true);
  });

  test("consent is session-scoped — grant on sess-a does not affect sess-b", () => {
    const records: ConsentV1[] = [
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
    ];
    assert.equal(hasActiveConsent(records, "sess-a", 1), true);
    assert.equal(hasActiveConsent(records, "sess-b", 1), false);
  });

  test("consentHighWater returns the max effectiveSeq for a session", () => {
    const records: ConsentV1[] = [
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
      appendRevoke("sess-a", 5, "2026-01-05T00:00:00Z"),
      appendGrant("sess-a", 10, "2026-01-10T00:00:00Z"),
    ];
    assert.equal(consentHighWater(records, "sess-a"), 10);
    assert.equal(consentHighWater(records, "sess-b"), 0);
  });

  test("appendGrant returns a ConsentV1 with schema and correct fields", () => {
    const record = appendGrant("sess-x", 7, "2026-01-01T00:00:00Z");
    assert.equal(record.schema, CONSENT_SCHEMA_V1);
    assert.equal(record.sessionId, "sess-x");
    assert.equal(record.action, "grant");
    assert.equal(record.effectiveSeq, 7);
  });

  test("appendRevoke returns a ConsentV1 with action revoke", () => {
    const record = appendRevoke("sess-x", 3, "2026-01-01T00:00:00Z");
    assert.equal(record.action, "revoke");
    assert.equal(record.effectiveSeq, 3);
  });

  test("records are sorted by effectiveSeq when evaluating", () => {
    const records: ConsentV1[] = [
      appendRevoke("sess-a", 10, "2026-01-10T00:00:00Z"),
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
      appendGrant("sess-a", 20, "2026-01-20T00:00:00Z"),
    ];
    assert.equal(hasActiveConsent(records, "sess-a", 15), false);
    assert.equal(hasActiveConsent(records, "sess-a", 20), true);
  });
});

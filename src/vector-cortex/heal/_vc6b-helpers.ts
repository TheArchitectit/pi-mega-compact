/**
 * heal/_vc6b-helpers.ts — shared decode/run helpers for VC6B acceptance tests.
 *
 * Extracted from vc6b-acceptance.test.ts so no single test file crosses the
 * 300-line soft limit (soft-as-hard gate). Each sibling test file imports from
 * here rather than duplicating the decode/runReal logic.
 */

import { createHash } from "node:crypto";

import type {
  RestoreReader,
  RestoreRequestV1,
  RestoreResultV1,
} from "./restore-types.js";
import { restoreSources } from "./restore.js";
import { verifyRestored } from "./verify.js";
import type { RestoreFx } from "./_restore-fixture.js";
import { decodeRange, decodeShard, decodeEvent } from "./_restore-fixture.js";

export const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));
export const hex = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

export function decodeFx(fx: RestoreFx): {
  request: RestoreRequestV1;
  reader: RestoreReader;
} {
  return {
    request: {
      schema: "restore-request-v1",
      sessionId: fx.input.sessionId,
      spans: fx.input.request.spans.map((s) => ({
        nodeId: s.nodeId,
        range: decodeRange(s.range),
        digest: s.digest,
      })),
    },
    reader: {
      exactShards: fx.input.exactShards.map(decodeShard),
      ledgerEvents: fx.input.ledgerEvents.map(decodeEvent),
    },
  };
}

export function runReal(fx: RestoreFx): {
  request: RestoreRequestV1;
  reader: RestoreReader;
  result: RestoreResultV1;
  verification: ReturnType<typeof verifyRestored>;
} {
  const { request, reader } = decodeFx(fx);
  const result = restoreSources(request, reader);
  return { request, reader, result, verification: verifyRestored(result, request) };
}

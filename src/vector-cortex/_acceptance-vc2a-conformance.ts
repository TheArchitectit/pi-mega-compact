/**
 * _acceptance-vc2a-conformance.ts — ENC-001..008 conformance rows + the named
 * assertions (ENC-ASSET-001 / ENC-DIGEST-002 / ENC-PLATFORM-003), each driven
 * through the REAL encoder asset/runtime (no mocks). Extracted from
 * vc2a-acceptance.test.ts so the aggregator stays under the tests/ soft limit.
 *
 * The aggregator passes its shared imports/helpers as a context object, so this
 * sibling never imports the aggregator (no import cycle at module load).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EncoderLoadResult } from "./encoder/types.js";

/** Context from the aggregator — only domain-specific helpers, not node:test/assert. */
export interface Vc2aConformanceCtx {
  ENC_IDS: readonly string[];
  ENC_FAIL: typeof import("./encoder/types.js").ENC_FAIL;
  fixture: (id: string) => {
    id: string;
    input: { scenario: string };
    expected: { ok: boolean; code?: string; mode?: string };
  };
  buildDir: (scenario: string) => Built;
  rmBuilt: (b: Built) => void;
  optionsFor: (scenario: string) => import("./encoder/runtime.js").CreateEncoderRuntimeOptions;
  createEncoderRuntime: typeof import("./encoder/runtime.js").createEncoderRuntime;
  verifyEncoderAsset: typeof import("./encoder/asset.js").verifyEncoderAsset;
  readEncoderManifest: typeof import("./encoder/asset.js").readEncoderManifest;
}

/* Structural stand-in for the aggregator's local `Built` (dir + scenario). */
interface Built {
  dir: string;
  scenario: string;
}

export function registerVc2aConformance(ctx: Vc2aConformanceCtx): void {
  const {
    ENC_IDS,
    ENC_FAIL,
    fixture,
    buildDir,
    rmBuilt,
    optionsFor,
    createEncoderRuntime,
    verifyEncoderAsset,
    readEncoderManifest,
  } = ctx;

  // -------------------------------------------------------------------------
  // ENC-001..008 conformance rows through the real runtime
  // -------------------------------------------------------------------------
  describe("ENC-001..008 conformance rows", () => {
    for (const id of ENC_IDS) {
      test(`${id}: resolves through the real runtime to the documented result`, () => {
        const fx = fixture(id);
        const built = buildDir(fx.input.scenario);
        try {
          const rt = createEncoderRuntime(optionsFor(fx.input.scenario));
          const load: EncoderLoadResult = rt.load(built.dir);
          assert.equal(load.ok, fx.expected.ok, `${id} ok`);
          if (!load.ok) {
            assert.equal(load.code, fx.expected.code, `${id} exact failure code`);
            if (fx.expected.mode) assert.equal(load.mode, fx.expected.mode, `${id} mode`);
          } else {
            assert.equal(load.mode, "A", `${id} should be mode A`);
          }
        } finally {
          rmBuilt(built);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // VC2A named assertions
  // -------------------------------------------------------------------------
  describe("VC2A named assertions", () => {
    test("ENC-ASSET-001: opset21 manifest + matching digests load as mode A", () => {
      const fx = fixture("ENC-ASSET-001");
      assert.equal(fx.expected.ok, true);
      const built = buildDir("valid");
      try {
        const load = createEncoderRuntime().load(built.dir);
        assert.equal(load.ok, true);
        if (load.ok) assert.equal(load.mode, "A");
      } finally {
        rmBuilt(built);
      }
    });
    test("ENC-DIGEST-002: one-byte model mutation demotes before load", () => {
      const fx = fixture("ENC-DIGEST-002");
      assert.equal(fx.expected.code, ENC_FAIL.DIGEST_MISMATCH);
      const built = buildDir("mutate-onnx");
      try {
        const res = verifyEncoderAsset(built.dir, readEncoderManifest(built.dir));
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.code, ENC_FAIL.DIGEST_MISMATCH);
      } finally {
        rmBuilt(built);
      }
    });
    test("ENC-PLATFORM-003: unsupported architecture selects trigram B", () => {
      const fx = fixture("ENC-PLATFORM-003");
      assert.equal(fx.expected.mode, "B");
      const built = buildDir("valid");
      try {
        const load = createEncoderRuntime({ platform: () => null }).load(built.dir);
        assert.equal(load.ok, false);
        if (!load.ok) {
          assert.equal(load.mode, "B", "trigram B selected");
          assert.equal(load.code, ENC_FAIL.PLATFORM_UNSUPPORTED);
        }
      } finally {
        rmBuilt(built);
      }
    });
  });
}

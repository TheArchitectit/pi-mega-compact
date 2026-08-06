/** ENC-0a buildDecision contract constructor suite — extracted from
 *  enc0a-acceptance.test.ts for soft-limit compliance. Receives the contract
 *  constructor + constants from the aggregator (no import cycle).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EncoderPlatformRow } from "./encoder/decision.js";

export interface Enc0aContractCtx {
  buildDecision: typeof import("./encoder/decision.js").buildDecision;
  PLATFORMS: readonly ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
}

export function registerEnc0aContract(ctx: Enc0aContractCtx): void {
  const { buildDecision, PLATFORMS } = ctx;

  describe("buildDecision contract constructor", () => {
    test("rejects an incomplete platform matrix", () => {
      const matrix = {
        "linux-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "linux-arm64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "darwin-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "wasm" },
        "darwin-arm64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        // win32-x64 omitted
      } as Record<(typeof PLATFORMS)[number], EncoderPlatformRow>;
      assert.throws(() =>
        buildDecision({
          backend: "wasm",
          budgetOk: true,
          p95Ms: 18.2,
          platformMatrix: matrix,
          modelPath: "model.onnx",
          modelBytes: 1,
          modelSha256: "a".repeat(64),
          tokenizerPath: "tokenizer.json",
          tokenizerBytes: 1,
          tokenizerSha256: "b".repeat(64),
          blockedBy: [],
        }),
      );
    });

    test("builds a valid decision with opset 21 + MIT license for a complete matrix", () => {
      const matrix = {
        "linux-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "linux-arm64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "darwin-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "wasm" },
        "darwin-arm64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "win32-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
      } as Record<(typeof PLATFORMS)[number], EncoderPlatformRow>;
      const d = buildDecision({
        backend: "wasm",
        budgetOk: true,
        p95Ms: 18.2,
        platformMatrix: matrix,
        modelPath: "model.onnx",
        modelBytes: 24117248,
        modelSha256: "a".repeat(64),
        tokenizerPath: "tokenizer.json",
        tokenizerBytes: 50000,
        tokenizerSha256: "b".repeat(64),
        blockedBy: [],
      });
      assert.equal(d.schema, "encoder-backend-decision-v1");
      assert.equal(d.opset, 21);
      assert.equal(d.backend, "wasm");
      assert.deepEqual(d.license, { spdx: "MIT", redistribution: true });
      assert.equal(d.platformMatrix["darwin-x64"].demotion, "wasm");
    });
  });
}

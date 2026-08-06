/**
 * ml5a-acceptance.test.ts — ML5-A five-head training + calibration acceptance
 * aggregator (fixtures-driven, no mocks, no stubs).
 *
 * Drives ML5-TRAIN-001..006 against the canonical v2 conformance corpus + the
 * REAL code: the six fixture envelopes (corpus/splits, deterministic export,
 * loss weights, seeding, calibration shape + head dims), the normative constants
 * (seed 1729, dims 384/128/128/64/32, losses), and the real production loaders
 * (`loadHeadProjections`, `projectHeadFromTrunk`, `loadCalibrationV1`) against
 * fixture-format artifacts, plus the deterministic corpus digest recomputed in JS.
 *
 * Flag-off parity: no fixed runtime flag is asserted. The loader/export cases
 * self-pin MEGACOMPACT_ML5_A=1 (mirroring vc2b) and 003 pins the flag-off demotion
 * as FIXTURE data, so the SAME file passes both `node --test
 * dist/vector-cortex/ml5a-acceptance.test.js` and the mandated
 * `MEGACOMPACT_ML5_A=0 ...` parity run.
 *
 * Local file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ENCODER_HEAD_DIMS,
	ENCODER_HEAD_ORDER,
	ENCODER_HEAD_LOSS_WEIGHTS,
	ENCODER_HEAD_LOSS_SUM,
	ENCODER_SEED,
	type EncoderHeadName,
} from "./encoder/types.js";
import { headLossWeights, headsShapeValid, loadHeadProjections, projectHeadFromTrunk, l2Norm } from "./encoder/heads.js";
import { loadCalibrationV1 } from "./encoder/calibrate.js";
import { ML5A_ENABLED } from "../config/vector-cortex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
	let dir = from;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
		const next = dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	throw new Error("conformance corpus not found above " + from);
}
const V2 = join(repoRoot(HERE), "conformance", "vector-cortex", "v2");

const TRAIN_IDS = ["ML5-TRAIN-001", "ML5-TRAIN-002", "ML5-TRAIN-003", "ML5-TRAIN-004", "ML5-TRAIN-005", "ML5-TRAIN-006"] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; fixtures: ManifestRow[] }
interface Ml5Fixture {
	id: string; kind: string; flag?: string; flag_enabled?: boolean;
	corpus_source?: string[]; redacted_only?: boolean; session_never_split?: boolean;
	splits?: { train?: string; calibration?: string; test?: string };
	seed?: number; opset?: number; quantized?: string; sha256_stable_across_runs?: boolean;
	heads_placeholder?: boolean; calibrate_placeholder?: boolean; mode?: string;
	loss_weights?: Record<string, number>; loss_sum?: number;
	python_seed?: boolean; numpy_seed?: boolean; torch_seed?: boolean; export_seed?: boolean;
	calibration_shape?: string; corpus_digest_sha256?: string; head_dims?: Record<string, number>;
}

function fixture(id: string): Ml5Fixture {
	const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("trained-heads/"));
	assert.ok(row, `fixture ${id} registered under trained-heads/`);
	return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as Ml5Fixture;
}
function readManifest(): Manifest {
	return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}

function canonicalValue(value: unknown): string {
	if (value === null || typeof value !== "object") return typeof value === "number" ? String(value) : JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).map((k) => k.normalize("NFC")).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
function sha256Hex(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

const GROUPS = [
	{ repo_id: "repo-a", session_key: "s1", n: 3, redacted: true },
	{ repo_id: "repo-a", session_key: "s2", n: 3, redacted: true },
	{ repo_id: "repo-b", session_key: "s3", n: 3, redacted: true },
	{ repo_id: "repo-b", session_key: "s4", n: 3, redacted: true },
	{ repo_id: "repo-c", session_key: "s5", n: 2, redacted: true },
	{ repo_id: "repo-c", session_key: "s6", n: 2, redacted: true },
];
const EXPECTED_CORPUS_DIGEST = sha256Hex(canonicalValue({ groups: GROUPS }) + "\n");

let tmpSeq = ENCODER_SEED;
function tmpDir(tag: string): string {
	tmpSeq = (tmpSeq * 1664525 + 1013904223) >>> 0;
	return join(tmpdir(), `${tag}-${process.pid}-${tmpSeq.toString(36)}`);
}
function withFlagsOn(fn: () => void): void {
	const saved = process.env.MEGACOMPACT_ML5_A;
	process.env.MEGACOMPACT_ML5_A = "1";
	try { fn(); } finally {
		if (saved === undefined) delete process.env.MEGACOMPACT_ML5_A;
		else process.env.MEGACOMPACT_ML5_A = saved;
	}
}

describe("ML5-A conformance registration", () => {
	test("manifest registers ML5-TRAIN-001..006 + the ml5 schema + ML5-A owner", () => {
		const m = readManifest();
		const ids = new Set(m.fixtures.map((f) => f.id));
		for (const id of TRAIN_IDS) {
			assert.ok(ids.has(id), `missing ${id}`);
			const row = m.fixtures.find((f) => f.id === id)!;
			assert.equal(row.algorithm, "ml5-train", `${id} algorithm`);
			assert.equal(row.schema, "schemas/ml5-fixture.schema.json", `${id} schema ref`);
			assert.equal(row.path, `trained-heads/${id}.json`, `${id} path`);
			assert.equal(row.expected, "ok");
		}
		assert.ok(m.fixtures.some((f) => f.path === "schemas/ml5-fixture.schema.json" && f.algorithm === "json-schema"), "ml5 schema registered");
		assert.ok(m.owner.split(",").includes("ML5-A"), "owner CSV includes ML5-A");
		assert.ok(m.schemaVersion.split(";").includes("ml5-fixture"), "schemaVersion includes ml5-fixture");
	});
});

describe("ML5-TRAIN-001..006 envelope invariants", () => {
	test("001 corpus sourcing + split policy", () => {
		const fx = fixture("ML5-TRAIN-001");
		assert.equal(fx.flag, "MEGACOMPACT_ML5_A");
		assert.equal(fx.flag_enabled, true);
		assert.deepEqual([...(fx.corpus_source ?? [])].sort(), ["context_chunks", "conversations", "turns"]);
		assert.equal(fx.redacted_only, true);
		assert.equal(fx.session_never_split, true);
		assert.ok((fx.splits?.train ?? "").length > 0 && (fx.splits?.calibration ?? "").length > 0);
		assert.equal(fx.splits?.test, "0");
	});
	test("002 deterministic export (seed 1729, opset 17, int8, stable SHA-256)", () => {
		const fx = fixture("ML5-TRAIN-002");
		assert.equal(fx.seed, ENCODER_SEED);
		assert.equal(fx.opset, 17);
		assert.equal(fx.quantized, "int8");
		assert.equal(fx.sha256_stable_across_runs, true);
	});
	test("003 flag-off demotion + empty-corpus no-op", () => {
		const fx = fixture("ML5-TRAIN-003");
		assert.equal(fx.flag_enabled, false);
		assert.equal(fx.heads_placeholder, true);
		assert.equal(fx.calibrate_placeholder, true);
		assert.equal(fx.mode, "B");
		assert.deepEqual(fx.corpus_source ?? [], []);
	});
	test("004 loss weights sum to 1.0", () => {
		const fx = fixture("ML5-TRAIN-004");
		const sum = Object.values(fx.loss_weights ?? {}).reduce((a, b) => a + b, 0);
		assert.equal(Math.round(sum * 100) / 100, fx.loss_sum);
		assert.equal(fx.loss_sum, ENCODER_HEAD_LOSS_SUM);
		assert.deepEqual(fx.loss_weights, { ...ENCODER_HEAD_LOSS_WEIGHTS });
	});
	test("005 single seed 1729 across python/numpy/torch/export", () => {
		const fx = fixture("ML5-TRAIN-005");
		assert.equal(fx.seed, ENCODER_SEED);
		for (const k of ["python_seed", "numpy_seed", "torch_seed", "export_seed"] as const) assert.equal(fx[k], true, k);
	});
	test("006 CalibrationV1 shape + corpus digest + head dims", () => {
		const fx = fixture("ML5-TRAIN-006");
		assert.equal(fx.calibration_shape, "CalibrationV1");
		assert.equal(fx.corpus_digest_sha256, EXPECTED_CORPUS_DIGEST, "recomputed corpus digest matches");
		assert.deepEqual(fx.head_dims, { ...ENCODER_HEAD_DIMS }, "head dims 384/128/128/64/32");
	});
});

describe("ML5-A real training/calibration code", () => {
	test("normative constants match fixtures + losses sum to 1.0", () => {
		assert.equal(ENCODER_SEED, 1729);
		assert.deepEqual([...ENCODER_HEAD_ORDER], ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"]);
		assert.deepEqual({ ...ENCODER_HEAD_DIMS }, { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 });
		const w = headLossWeights();
		assert.equal(Math.round(Object.values(w).reduce((a, b) => a + b, 0) * 100) / 100, 1.0);
		assert.equal(w.semantic, 0.35);
		assert.equal(w.payloadRouting, 0.1);
	});
	test("the flag exports a live boolean regardless of env state", () => {
		assert.equal(typeof ML5A_ENABLED(), "boolean");
	});
	test("loadHeadProjections + projectHeadFromTrunk give real L2-normalized heads", () => {
		withFlagsOn(() => {
			const trunkDim = 384;
			const dims: Record<EncoderHeadName, number> = { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 };
			let c = 0;
			const heads: Record<string, unknown> = {};
			for (const h of ENCODER_HEAD_ORDER) {
				const w: number[] = [];
				for (let i = 0; i < dims[h]! * trunkDim; i++) { c = (c * 1664525 + 1013904223) >>> 0; w.push((c / 4294967296) * 2 - 1); }
				heads[h] = { dim: dims[h], temperature: 1.0, weights: w };
			}
			const artifact = { schema: "trained-heads-v1", seed: ENCODER_SEED, trunkDim, dims: { ...dims }, heads };
			const dir = tmpDir("ml5a-heads");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "trained-heads.json");
			writeFileSync(path, JSON.stringify(artifact));
			try {
				const table = loadHeadProjections(path);
				assert.ok(table, "loadHeadProjections returns a table");
				assert.equal(table!.seed, ENCODER_SEED);
				assert.equal(table!.trunkDim, trunkDim);
				assert.ok(headsShapeValid(table!), "all head dims/shapes normative");
				for (const h of ENCODER_HEAD_ORDER) {
					assert.equal(table!.dims[h], ENCODER_HEAD_DIMS[h], `${h} dim`);
					assert.equal(table!.weights[h]!.length, dims[h]! * trunkDim);
					assert.ok(Number.isFinite(table!.temperatures[h]), `${h} temp`);
				}
				const trunk = new Float32Array(trunkDim).map((_, i) => Math.sin(i + 1) / 1000);
				for (const h of ENCODER_HEAD_ORDER) {
					const v = projectHeadFromTrunk(h, trunk, table!);
					assert.equal(v.head, h);
					assert.equal(v.dim, ENCODER_HEAD_DIMS[h]);
					const norm = l2Norm(v.values);
					assert.ok(norm === 0 || Math.abs(norm - 1) < 1e-5, `${h} L2-normalized (norm=${norm})`);
				}
				assert.ok(loadHeadProjections(path)!.seed === table!.seed, "reload stable");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
	test("loadHeadProjections rejects malformed / wrong-seed / gone assets (non-fatal)", () => {
		withFlagsOn(() => {
			const dir = tmpDir("ml5a-bad");
			mkdirSync(dir, { recursive: true });
			try {
				assert.equal(loadHeadProjections(join(dir, "missing.json")), null);
				const badSchema = join(dir, "bad.json");
				writeFileSync(badSchema, JSON.stringify({ schema: "other-v1", seed: ENCODER_SEED, dims: {}, heads: {} }));
				assert.equal(loadHeadProjections(badSchema), null, "wrong schema -> null");
				const good = { dim: 384, temperature: 1.0, weights: new Array(384 * 384).fill(0) };
				const wrongSeed = join(dir, "wrong-seed.json");
				writeFileSync(wrongSeed, JSON.stringify({ schema: "trained-heads-v1", seed: 42, dims: { semantic: 384, dependency: 384, contradiction: 384, cacheStability: 384, payloadRouting: 384 }, heads: { semantic: good, dependency: { ...good, dim: 128 }, contradiction: { ...good, dim: 128 }, cacheStability: { ...good, dim: 64 }, payloadRouting: { ...good, dim: 32 } } }));
				assert.equal(loadHeadProjections(wrongSeed), null, "wrong seed -> null");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
	test("loadCalibrationV1 loads a valid CalibrationV1 and rejects malformed (non-fatal)", () => {
		withFlagsOn(() => {
			const dir = tmpDir("ml5a-cal");
			mkdirSync(dir, { recursive: true });
			try {
				const valid = join(dir, "calibration.json");
				writeFileSync(valid, JSON.stringify({
					schema: "calibration-v1", headOrder: [...ENCODER_HEAD_ORDER],
					calibrationSplitDigest: "ab".repeat(32), fittedOnCalibrationOnly: true,
					temperatures: { semantic: 1.1, dependency: 1.05, contradiction: 0.95, cacheStability: 1.0, payloadRouting: 0.9 },
					thresholds: { semantic: 0.5, dependency: 0.5, contradiction: 0.5, cacheStability: 0.5, payloadRouting: 0.5 },
					seed: ENCODER_SEED,
				}));
				const cal = loadCalibrationV1(valid);
				assert.ok(cal, "loadCalibrationV1 loads a valid artifact");
				assert.equal(cal!.schema, "calibration-v1");
				assert.deepEqual([...cal!.headOrder], [...ENCODER_HEAD_ORDER]);
				assert.equal(cal!.seed, ENCODER_SEED);
				assert.ok(Object.values(cal!.temperatures).every((t) => Number.isFinite(t)), "temps finite");
				assert.ok(Object.values(cal!.thresholds).every((t) => Number.isFinite(t)), "thresholds finite");
				assert.equal(loadCalibrationV1(join(dir, "missing.json")), null);
				const bad = join(dir, "bad.json");
				writeFileSync(bad, JSON.stringify({ schema: "calibration-v1", headOrder: ["semantic"], temperatures: {}, thresholds: {}, seed: ENCODER_SEED }));
				assert.equal(loadCalibrationV1(bad), null, "wrong head order -> null");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

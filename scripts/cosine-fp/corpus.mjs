// guardrails-allow PREVENT-PI-004: local-only synthetic corpus generator — pure fs read/write + in-memory RNG, no network.
/**
 * scripts/cosine-fp/corpus.mjs — deterministic synthetic-corpus generator for
 * the L2 cosine FP harness (COS-FP-A).
 *
 * Produces a synthetic corpus with three content types — code, prose, mixed —
 * each carrying a ground-truth label: `dup` (exact or template-permutation
 * duplicate of a canon), `near` (controlled perturbation — comment/identifier/
 * word changes), or `clean` (unique singleton). This is the bench's ground
 * truth (item labels + canonId), so FP/FN can be measured against it.
 *
 * The generator is fully deterministic for a fixed seed (mulberry32). Default
 * seed 20260806, overridable via MEGACOMPACT_COSINE_FP_SEED. Template text is
 * synthetic only — it never reads, embeds, or ships real session/ledger bytes
 * (EVAL-REDACT-002); reports emit counts + fractions + digests only.
 */

// mulberry32 — tiny seeded PRNG (deterministic across platforms).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve the corpus seed from env (default 20260806). */
export function corpusSeed() {
  const raw = process.env.MEGACOMPACT_COSINE_FP_SEED;
  if (raw === undefined) return 20260806;
  const n = Number(raw);
  return Number.isFinite(n) && Number(n) >= 0 ? Math.floor(n) : 20260806;
}

const CODE_IDENTIFIERS = [
  "threshold", "computeCosine", "dedupe", "embed", "normalize", "fragment",
  "annotate", "residual", "canonicalize", "projection", "recall", "invert",
  "quantize", "reconstruct", "topology", "orchestrate", "validate", "prune",
  "l2norm", "pairwise", "spool", "merge",
];

const PROSE_TERMS = [
  "the", "context", "window", "compression", "retention", "anchor", "floor",
  "recall", "embedding", "cosine", "similarity", "deduplication", "threshold",
  "synthetic", "corpus", "harness", "false", "positive", "rate", "calibration",
];

/** Deterministic text from a fixed template parameterized by a seeded index. */
function codeSample(rng, idx) {
  const v = CODE_IDENTIFIERS[idx % CODE_IDENTIFIERS.length];
  const v2 = CODE_IDENTIFIERS[(idx + 7) % CODE_IDENTIFIERS.length];
  const fn = rng() < 0.5 ? "export function" : "function";
  return [
    "// spatial gate for " + v + " over the " + v2 + " slice",
    fn + " " + v + "Score(inputs, opts) {",
    "  const sim = " + v2 + "(inputs, opts);",
    "  if (sim >= opts.ceiling) return { hit: recall(" + v + "), meta: frag };",
    "  return { hit: null, meta: { reason: 'below " + v2 + "' } };",
    "}",
  ].join("\n");
}

function proseSample(rng, idx) {
  const t = PROSE_TERMS[idx % PROSE_TERMS.length];
  const t2 = PROSE_TERMS[(idx + 3) % PROSE_TERMS.length];
  const lead = rng() < 0.5 ? "This document describes" : "Overview:";
  return (
    lead +
    " how " + t + " interacts with " + t2 + " during " + PROSE_TERMS[(idx + 5) % PROSE_TERMS.length] +
    ". " + t2.charAt(0).toUpperCase() + t2.slice(1) +
    " is measured by the " + t + " ratio, and the " + PROSE_TERMS[(idx + 9) % PROSE_TERMS.length] +
    " gate keeps " + t2 + " within budget."
  );
}

function mixedSample(rng, idx) {
  const c = codeSample(rng, idx);
  const p = proseSample(rng, (idx + 1) % PROSE_TERMS.length);
  return c + "\n\n" + p;
}

/** A template-permutation duplicate: shuffle stable comment/order, same tokens. */
function permuteDup(rng, text) {
  // Deterministic permutation keyed by rng; reorders template lines so the
  // token multiset is preserved but the byte text differs (a true dup that is
  // not byte-identical).
  const lines = text.split("\n");
  const indices = lines.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.map((i) => lines[i]).join("\n");
}

/** A controlled near-dup: swap one identifier/word + alter one comment line. */
function nearDup(rng, text, idx) {
  const altA = CODE_IDENTIFIERS[(idx + 1) % CODE_IDENTIFIERS.length];
  const altB = CODE_IDENTIFIERS[(idx + 2) % CODE_IDENTIFIERS.length];
  const tAlt = PROSE_TERMS[(idx + 2) % PROSE_TERMS.length];
  return text
    .replace(/(function|export function) \w+/, (m, p) => m.replace(/\w+$/, altA))
    .replace(/recall\(\w+\)/, "recall(" + altB + ")")
    .replace(new RegExp("\\b" + PROSE_TERMS[(idx) % PROSE_TERMS.length] + "\\b"), tAlt);
}

/** Build the synthetic corpus. Returns {seed, manifest, items, counts}. */
export function buildCorpus(seed = corpusSeed()) {
  const rng = mulberry32(seed);
  const manifests = [];
  const items = [];

  /** Generate one canon per content type and add its 3 ground-truth items. */
  function addCanon(contentType, canonIdx, ctor) {
    const canonId = `${contentType}-${canonIdx}`;
    const base = ctor(rng, canonIdx);
    const perm = permuteDup(rng, base);
    const near = nearDup(rng, base, canonIdx);
    // Item ordering must be stable for a given seed.
    const rows = [
      { id: `${contentType}-${canonIdx}-orig`, contentType, label: "clean", text: base },
      { id: `${contentType}-${canonIdx}-dup`, contentType, label: "dup", text: perm },
      { id: `${contentType}-${canonIdx}-near`, contentType, label: "near", text: near },
    ];
    for (const r of rows) {
      items.push({ id: r.id, contentType, label: r.label, text: r.text });
      manifests.push({ id: r.id, contentType, label: r.label, canonId });
    }
  }

  const CANONS = 8;
  for (let i = 0; i < CANONS; i++) addCanon("code", i, codeSample);
  for (let i = 0; i < CANONS; i++) addCanon("prose", i, proseSample);
  for (let i = 0; i < CANONS; i++) addCanon("mixed", i, mixedSample);

  const counts = {};
  for (const ct of ["code", "prose", "mixed"]) {
    counts[ct] = {
      items: items.filter((x) => x.contentType === ct).length,
      dup: items.filter((x) => x.contentType === ct && x.label === "dup").length,
      near: items.filter((x) => x.contentType === ct && x.label === "near").length,
      clean: items.filter((x) => x.contentType === ct && x.label === "clean").length,
    };
  }

  return { seed, manifest: manifests, items, counts };
}

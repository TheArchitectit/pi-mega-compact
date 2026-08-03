# Residual Payload Codec V1

Semantic vectors are never claimed to recover exact text. Exact bytes come only from exact payload shards or this reversible payload codec. Numeric erasure parity protects codec bytes; semantic redundancy improves meaning under omission; neither substitutes for exact payload.

## Byte scope and transform

Input is exactly `EventV2.originalBytes` for one half-open source span, including invalid UTF-8. Header canonical bytes are: magic `VCR1`, u32 LE original length, 32-byte SHA-256, u16 block size (4096), u16 data shard count `k`, u16 parity count `m`. Split payload into 4096-byte blocks, zero-pad only the final block, and retain original length.

Map each byte to `x=(byte-127.5)/127.5` in R^4096. Basis V1 is the orthonormal DCT-II matrix generated analytically (`alpha(0)=sqrt(1/n)`, else `sqrt(2/n)`), dimension 4096; it is never learned or stored. Coefficients are the dot product (orthonormal least-squares solve). Quantize signed coefficients to int16 with per-block float32 LE scale `max(abs(c))/32767` (zero block scale 0); ties use round-to-nearest-even and saturation rejects encoding. Inverse dequantizes, applies inverse DCT, maps with round-to-nearest-even and clamps 0..255.

Because quantization may not reproduce bytes, encoder MUST compare reconstructed SHA-256. If unequal, append a block-scoped exact correction stream. For each block in ascending `u32 LE blockIndex`, encode a varint correction count followed by sorted `(u16 offsetWithinBlock,u8 original)` entries; offsets are 0..4095, duplicate offsets are rejected, and omitted blocks have count zero. Apply corrections, truncate to original length, then verify the payload digest. Thus post-quantization byte error is exactly zero for admitted artifacts; experiments also report pre-correction RMSE/max error and correction density.

## Erasure parity

Serialize header + all block scales/coefficient arrays/corrections into the **protected stream**. Split it into `k=6` equal data shards (zero-pad, store stream length); construct `m=3` Reed–Solomon shards over GF(2^8), primitive polynomial `0x11d`, with field elements represented as polynomial-basis bytes. Build a 9×6 Vandermonde matrix `V[r,c] = α_r^c` using distinct evaluation points `α_r = r+1` for rows `r=0..8` and columns `c=0..5`. Convert it to a systematic generator `G = V × inverse(V[0..5,0..5])`; rows 0..5 are therefore the identity and rows 6..8 produce parity shards in that order. Matrix inversion and recovery use deterministic left-to-right pivot search and GF Gaussian elimination. Any 6 of 9 shards recover. Reject duplicate indices, bad per-shard SHA-256, singular matrix, wrong length, or final payload digest mismatch. Corruption model: up to 3 known erasures recover; unknown corruptions are detected by shard digest but not corrected until marked erased; >3 erasures fail closed to exact source/C.

## Admission and experiments

Encoded size is every persisted byte: header, scales, coefficients, corrections, shard index/length metadata, all 9 shards, and digests. Admit residual only when `encodedSize <= floor(0.95 * exactCompressedSize)` and full decode/digest succeeds; otherwise store exact compressed payload. Never compare only coefficient bytes.

VC4B owns `src/vector-cortex/residual/{types,dct,quantize,parity,codec}.ts`; fixture schemas and `RES-001..050` under `conformance/vector-cortex/v2/residual/`; tests `codec.test.ts`, `parity.test.ts`, `property.test.ts`. VC4C runs `scripts/vector-cortex-residual-benchmark.mjs` on binary, valid/invalid UTF-8, source, JSON, random, sparse, and adversarial coefficient corpora, reporting admission rate, all byte overhead, pre-correction error, recovery by erasure count, p50/p95 time, and zero post-decode digest mismatches. Exact compiled command: `node --test dist/vector-cortex/residual/codec.test.js dist/vector-cortex/residual/parity.test.js dist/vector-cortex/residual/property.test.js`.

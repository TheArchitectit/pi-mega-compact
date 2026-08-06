/**
 * config/vector-cortex-ml5c.ts — ML5-C runtime decision + packaging flag.
 *
 * Sibling extract mirroring vector-cortex-ml5a.ts / vector-cortex-ml5b.ts, so
 * vector-cortex.ts stays under its 300-line soft limit (soft-as-hard gate).
 * This is the ONNX Runtime backend selection + packaging sprint flag.
 * vector-cortex.ts re-exports the ENUM below and root src/config.ts re-exports
 * it, so no consumer import path changes.
 *
 * ML5-C selects the ONNX runtime backend (WASM vs native) based on the ML5-B
 * bench record and platform support. The flag gates the runtime-selection
 * dispatch only; when OFF the encoder serves mode B trigram exactly as before
 * (byte-identical to the ML5-B survivor — no `vector_cortex_runtime_selected`
 * event is emitted, no session-selection dispatch runs).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ML5-C — runtime decision + packaging (WASM vs native). Default ON.
 * `MEGACOMPACT_ML5_C=0` disables and is byte-identical to the ML5-B survivor:
 * no runtime selection runs — the encoder continues to serve mode B trigram,
 * exactly as before, with no `vector_cortex_runtime_selected` event emitted.
 * The flag gates the runtime-selection dispatch only; it does not gate the
 * underlying WASM/native backends (which are exercised by ML5-B's bench
 * harness and ML5-A's trained asset independently).
 */
export const ML5C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ML5_C");

/**
 * vc6c-impl-acceptance.test.ts — VC6C-IMPL acceptance aggregator (delegate-shell).
 *
 * The actual VC6C-IMPL-001..006 suite lives in `heal/vc6c-impl-acceptance.test.ts`
 * (named `-acceptance.test.ts` so the publish-acceptance mirror copies it to
 * `dist/vector-cortex/heal/`, where its `./...` and `../reconstruct/...` imports
 * resolve at the correct relative depth). This flat file is the doc-mandated
 * registration entry-point:
 *
 *   npm run build
 *   node --test dist/vector-cortex/vc6c-impl-acceptance.test.js
 *
 * which publishes both this shell and the heal suite, and runs the full
 * VC6C-IMPL fixture corpus against the real production modules.
 */

import "./heal/vc6c-impl-acceptance.test.js";

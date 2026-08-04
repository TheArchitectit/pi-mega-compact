/**
 * mega-context/vector-cortex.ts — VC5B delegation seam (the sprint's production
 * ownership: `extensions/mega-context/vector-cortex.ts`).
 *
 * This is the ONLY extension-side surface VC5B owns. It delegates to the pi-
 * agnostic `src/vector-cortex/render` + `src/vector-cortex/provider` logic and
 * wires the two structured events the sprint emits:
 *   - `vector_cortex_render_validated`  — a render passed validation and will be
 *     prepended via the host `before_agent_start` systemPrompt seam.
 *   - `vector_cortex_provider_bypassed` — an unknown provider/profile forced a
 *     clean bypass (triad C, the predecessor prompt path).
 *
 * GUARDRAIL PREVENT-PI-003 (critical): the rendered compacted context is placed
 * via the host `before_agent_start` systemPrompt PREPEND seam — it is NEVER
 * emitted as a `role:"system"` conversation message. The renderer returns a
 * `RenderManifestV1`, not a raw system-role payload; this seam composes the
 * manifest's prepend into `event.systemPrompt`.
 *
 * The context handler (extensions/mega-events/context-handler.ts) is 228 lines
 * (already a delegate shell) and under the extension hard limit, so NO split was
 * required — VC5B delegates from here rather than modifying that handler.
 *
 * Pi runtime adapter: imports only pi runtime types + the VC5B logic. Flag-gated
 * on `VC5B_ENABLED()`; flag OFF is byte-identical to the predecessor (VC5A state
 * — the DAG/plan path), so this seam returns the host's unmodified systemPrompt.
 */

import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

import { VC5B_ENABLED } from "../../src/config/vector-cortex.js";
import { resolveProviderProfile } from "../../src/vector-cortex/provider/registry.js";
import { renderPrompt } from "../../src/vector-cortex/render/renderer.js";
import { validateRender } from "../../src/vector-cortex/render/validator.js";
import type { RenderInput, RenderManifestV1, CanonicalOutboundRequest } from "../../src/vector-cortex/render/types.js";
import type { ProviderProfileBundle } from "../../src/vector-cortex/provider/types.js";

/** An injected emit callback — the same (event, fields) shape as the src seams. */
export type VectorCortexEmit = (event: string, fields: Record<string, unknown>) => void;

/** The VC5B seam result handed back to the before_agent_start handler. */
export interface VectorCortexRenderOutcome {
  readonly validated: boolean;
  readonly bypassed: boolean;
  readonly manifest: RenderManifestV1 | null;
  /** The text to prepend to the host systemPrompt (empty when not VC5B). */
  readonly systemPromptPrepend: string;
  readonly triad: "A" | "B" | "C";
}

/**
 * Run the full VC5B render+validate pipeline. Returns a structured outcome the
 * `before_agent_start` handler composes into the host systemPrompt. On a clean
 * bypass (unknown profile) it emits `vector_cortex_provider_bypassed` and the
 * host uses the predecessor prompt path (triad C). On a validated render it
 * emits `vector_cortex_render_validated` (triad A).
 *
 * All emits are best-effort and non-fatal; the flag gates zero observability
 * writes when OFF (byte-identical to predecessor).
 */
export function runVectorCortexRender(
  input: RenderInput,
  emit?: VectorCortexEmit,
): VectorCortexRenderOutcome {
  const fire = (event: string, fields: Record<string, unknown>): void => {
    try {
      if (VC5B_ENABLED()) emit?.(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };

  const rendered = renderPrompt(input);
  if (!rendered.ok) {
    // Clean bypass (unknown profile) or a hard order mismatch. Bypass emits the
    // provider-bypassed event and defers to the predecessor prompt path.
    fire("vector_cortex_provider_bypassed", {
      code: rendered.code,
      triad: rendered.triad,
    });
    return {
      validated: false,
      bypassed: true,
      manifest: null,
      systemPromptPrepend: "",
      triad: rendered.triad,
    };
  }

  // Validate the canonical request BEFORE invocation. The profile at validation
  // time must match the manifest profile (the UNIQUE injection swaps it → C).
  const sourceToolBytes = new Map<string, string>();
  for (const t of rendered.request.tools) sourceToolBytes.set(t.id, t.bytes);
  const pinnedToolLengths = new Map<string, number>();
  for (const t of rendered.request.tools) {
    pinnedToolLengths.set(t.id, Buffer.byteLength(t.bytes, "utf8"));
  }
  const check = validateRender(
    rendered.manifest,
    rendered.request,
    input.profile,
    sourceToolBytes,
    pinnedToolLengths,
  );

  if (!check.ok) {
    fire("vector_cortex_provider_bypassed", {
      code: check.code,
      triad: check.triad,
    });
    return {
      validated: false,
      bypassed: true,
      manifest: rendered.manifest,
      systemPromptPrepend: "",
      triad: check.triad,
    };
  }

  fire("vector_cortex_render_validated", {
    profileId: rendered.manifest.profileId,
    requestDigest: rendered.manifest.requestDigest,
    nodeCount: rendered.manifest.nodeOrder.length,
    triad: "A",
  });
  return {
    validated: true,
    bypassed: false,
    manifest: rendered.manifest,
    systemPromptPrepend: rendered.request.systemPromptPrepend,
    triad: "A",
  };
}

/**
 * Register the VC5B `before_agent_start` prepend seam on the host. Flag OFF →
 * byte-identical to the predecessor (returns the host's unmodified systemPrompt).
 * The composed prepend is placed on the HOST systemPrompt, never as role:system.
 */
export function registerVectorCortexRender(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  emit?: VectorCortexEmit,
): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (!VC5B_ENABLED()) return; // byte-identical predecessor behavior
    // The host supplies the active (provider, model) so the seam can resolve the
    // profile. Until the host passes a render input, the seam stays inert.
    const pending = (ctx as unknown as { megaCompactVectorCortexRender?: RenderInput }).megaCompactVectorCortexRender;
    if (pending === undefined) return;
    const outcome = runVectorCortexRender(pending, emit);
    if (!outcome.validated) return; // bypass / mismatch → predecessor path
    return { systemPrompt: `${event.systemPrompt}\n\n${outcome.systemPromptPrepend}` };
  });
}

/** Resolve a provider profile by (provider, model) for the host to pass in. */
export function resolveProfile(provider: string, model: string): ProviderProfileBundle | null {
  const res = resolveProviderProfile(provider, model);
  return res.ok ? res.bundle : null;
}

/** Re-export the core types the host adapter consumes (contract-first). */
export type { RenderInput, RenderManifestV1, CanonicalOutboundRequest };

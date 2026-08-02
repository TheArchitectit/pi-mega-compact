/**
 * mega-commands/setupCommand.ts — the local embedding setup wizard command.
 *
 * Extracted from mega-commands.ts (delegate-shell split). Registers
 * /mega-setup: detects available local embedders and writes the chosen
 * configuration to .mega-compact.env.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: local subprocess detection only (no network)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { checkRecallQuality } from "./helpers.js";

/** Register the /mega-setup embedder wizard command. */
export function registerSetupCommand(
	pi: ExtensionAPI,
): void {
	pi.registerCommand("mega-setup", {
		description:
			"Local embedding setup wizard — detect available embedders and configure mega-compact.",
		handler: async (_args: string, ctx: ExtensionContext) => {
		 try {
		  const log = (msg: string) => ctx.ui.notify(msg);

		  // --- 1. Current config ---
		  const embeddingUrl = process.env["MEGACOMPACT_EMBEDDING_URL"];
		  const minilm = process.env["MEGACOMPACT_MINILM"];

		  let currentEmbedder = "TrigramEmbedder (heuristic, default)";
		  if (embeddingUrl) currentEmbedder = `httpEmbedder → ${embeddingUrl}`;
		  else if (minilm) currentEmbedder = "MiniLM (experimental)";

		  // --- 2. Detection ---
		  let ollamaDetected = false;
		  let ollamaModels: string[] = [];
		  let ollamaRunning = false;
		  let llamaDetected = false;
		  let onnxDetected = false;

		  try {
		    const ollamaVer = spawnSync("ollama", ["--version"], {
		      timeout: 5000,
		      encoding: "utf-8",
		      stdio: ["ignore", "pipe", "pipe"],
		    }); // guardrails-allow PREVENT-PI-004: local subprocess detection only
		    if (ollamaVer.status === 0) {
		      ollamaDetected = true;
		      try {
		        const listResult = spawnSync("ollama", ["list"], {
		          timeout: 5000,
		          encoding: "utf-8",
		          stdio: ["ignore", "pipe", "pipe"],
		        }); // guardrails-allow PREVENT-PI-004: local subprocess detection only
		        if (listResult.status === 0) {
		          ollamaRunning = true;
		          const lines = listResult.stdout?.split("\n") ?? [];
		          for (const line of lines) {
		            const name = line.split(/\s+/)[0];
		            if (name && name !== "NAME") ollamaModels.push(name);
		          }
		        }
		      } catch {
		        // ollama list fails if server not running — that's fine
		      }
		    }
		  } catch {
		    // ollama not found
		  }

		  try {
		    const whichLlama = spawnSync("which", ["llama-server"], {
		      timeout: 3000,
		      encoding: "utf-8",
		      stdio: ["ignore", "pipe", "pipe"],
		    }); // guardrails-allow PREVENT-PI-004: local subprocess detection only
		    llamaDetected = whichLlama.status === 0;
		  } catch {
		    // not found
		  }

		  try {
		    const req = createRequire(import.meta.url);
		    try {
		      req.resolve("onnxruntime-node");
		      onnxDetected = true;
		    } catch {
		      // not in node_modules
		    }
		  } catch {
		    // require error
		  }

		  // --- 2.5 Quality check ---
		  // Scan recent events for low recall quality (best-effort, non-fatal)
		  const stateDir = process.env["MEGACOMPACT_STATE_DIR"] ?? path.join(os.homedir(), ".pi", "mega-compact");
		  const lowRecallQuality = checkRecallQuality(stateDir);

		  // --- 3. Build choices ---
		  interface Choice {
		    label: string;
		    value: string;
		  }
		  const choices: Choice[] = [];

		  if (ollamaDetected && ollamaRunning) {
		    const model = ollamaModels.find(
		      (m) =>
		        m.includes("nomic-embed") ||
		        m.includes("embed") ||
		        m.includes("mxbai"),
		    );
		    const suggestedModel = model ?? "nomic-embed-text";
		    choices.push({
		      label: `Use Ollama (${suggestedModel}) at localhost:11434`,
		      value: `ollama:${suggestedModel}`,
		    });
		  } else if (ollamaDetected && !ollamaRunning) {
		    choices.push({
		      label: "Ollama detected but server is not running — start it first",
		      value: "ollama:offline",
		    });
		  }

		  if (llamaDetected) {
		    choices.push({
		      label: "Use llama.cpp server at localhost:8080",
		      value: "llama:default",
		    });
		  }

		  if (onnxDetected) {
		    choices.push({
		      label: "Use ONNX Runtime (experimental, requires config)",
		      value: "onnx:default",
		    });
		  }

		  choices.push({
		    label: "Keep TrigramEmbedder (default, no setup)",
		    value: "trigram",
		  });

		  // --- 4. Prompt user ---
		  log(`Current embedder: ${currentEmbedder}`);
		  if (lowRecallQuality) {
		    log(
		      "Tap: recent recall quality is low. Consider switching to Ollama or llama.cpp for better results.",
		    );
		  }
		  let selected = "trigram";
		  if (choices.length > 1) {
		    try {
		      const labels = choices.map((c) => c.label);
		      const picked = await ctx.ui.select("Select an embedder to configure:", labels);
		      if (picked === undefined) {
		        log("Setup cancelled by user.");
		        return;
		      }
		      const match = choices.find((c) => c.label === picked);
		      selected = match?.value ?? "trigram";
		    } catch {
		      log("Setup cancelled by user.");
		      return;
		    }
		  } else {
		    log("No local embedders detected. Keeping TrigramEmbedder default.");
		  }

		  // --- 5. Apply selection ---
		  if (selected.startsWith("ollama:")) {
		    const model = selected.split(":")[1];
		    const url = `http://localhost:11434/api/embeddings`; // guardrails-allow PREVENT-PI-004: localhost-only config string, not a runtime fetch
		    const lines = [
		      `# Mega-Compact Embedder Configuration — Ollama`,
		      `# Generated by /megasetup at ${new Date().toISOString()}`,
		      `export MEGACOMPACT_EMBEDDING_URL="${url}"`,
		      `# Optional: uncomment to set cache size (default 1000)`,
		      `# export MEGACOMPACT_EMBED_CACHE=1000`,
		    ];
		    const envContent = lines.join("\n") + "\n";

		    // Write .mega-compact.env to state dir
		    try {
		      mkdirSync(stateDir, { recursive: true });
		      writeFileSync(path.join(stateDir, ".mega-compact.env"), envContent, "utf-8");
		    } catch {
		      // non-fatal
		    }

		    log(
		      `Configured for Ollama (${model}).\n\nAdd to your shell profile (~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish):\n\n  source "${path.join(
		        stateDir,
		        ".mega-compact.env",
		      )}"\n\nOr export manually:\n\n  export MEGACOMPACT_EMBEDDING_URL="${url}"\n\nThen restart pi to activate the http embedder.`,
		    );
		  } else if (selected.startsWith("llama:")) {
		    const url = "http://localhost:8080/v1/embeddings"; // guardrails-allow PREVENT-PI-004: localhost-only config string, not a runtime fetch
		    const lines = [
		      `# Mega-Compact Embedder Configuration — llama.cpp`,
		      `# Generated by /megasetup at ${new Date().toISOString()}`,
		      `export MEGACOMPACT_EMBEDDING_URL="${url}"`,
		    ];
		    const envContent = lines.join("\n") + "\n";
		    try {
		      mkdirSync(stateDir, { recursive: true });
		      writeFileSync(path.join(stateDir, ".mega-compact.env"), envContent, "utf-8");
		    } catch {
		      // non-fatal
		    }

		    log(
		      `Configured for llama.cpp server.\n\nAdd to your shell profile:\n\n  source "${path.join(
		        stateDir,
		        ".mega-compact.env",
		      )}"\n\nOr export manually:\n\n  export MEGACOMPACT_EMBEDDING_URL="${url}"\n\nThen restart pi to activate the http embedder.`,
		    );
		  } else if (selected.startsWith("onnx:")) {
		    log(
		      "ONNX Runtime configuration is experimental.\n\nSet MEGACOMPACT_EMBEDDING_URL to your local ONNX server URL, or see docs for manual setup.\nKeeping TrigramEmbedder for now.",
		    );
		  } else {
		    const qualityTip =
		      lowRecallQuality
		        ? " Recent recall quality is low — consider running /mega-setup again to switch to Ollama or llama.cpp for better results."
		        : "";
		    log(`Keeping TrigramEmbedder (default). No configuration needed.${qualityTip}`);
		  }
		 } catch (e) {
		   ctx.ui.notify(`[mega-compact] /mega-setup failed: ${String(e)}`);
		 }
		},
	});
}

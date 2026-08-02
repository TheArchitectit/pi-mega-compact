/**
 * hash.ts — region hashing for the dedup sentinel (extracted from vectorStore.ts).
 */
import { createHash } from "node:crypto";

/** Stable hash of a compacted region, the dedup sentinel key. */
export function computeRegionHash(regionText: string): string {
	// Normalize whitespace before hashing so "foo  bar" and "foo bar" dedup.
	const normalized = regionText.replace(/\s+/g, " ").trim();
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

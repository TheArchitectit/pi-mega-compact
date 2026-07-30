/**
 * dashboard-client/src/utils/format.ts — shared formatting helpers.
 *
 * Mirrors the format functions from the old static dashboard (html.ts)
 * so the React rewrite shows identical values.
 */

/** Format bytes as KiB/MiB/B (matches html.ts fmtBytes). */
export function fmtBytes(b: number | null | undefined): string {
	const n = b ?? 0;
	if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MiB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
	return `${n} B`;
}

/** Format seconds as h/m/s/ms (matches html.ts fmtSec). */
export function fmtSec(s: number | null | undefined): string {
	const n = s ?? 0;
	if (n >= 3600) return `${(n / 3600).toFixed(1)}h`;
	if (n >= 60) return `${Math.round(n / 60)}m`;
	if (n >= 1) return `${n.toFixed(1)}s`;
	return `${Math.round(n * 1000)}ms`;
}

/**
 * Display a 0–1 fraction as a percentage string.
 * Uses one decimal place below 10%, rounded above (matches html.ts pct logic).
 */
export function fmtPctFromFraction(
	v: number | null | undefined,
): string {
	const n = v ?? 0;
	const pct = n * 100;
	if (pct >= 10) return `${Math.round(pct)}%`;
	return `${pct.toFixed(1)}%`;
}

/** Round a 0–1 fraction to a one-decimal percentage (for trophy values). */
export function fmtPct(v: number | null | undefined): string {
	const n = v ?? 0;
	return `${Math.round(n * 10) / 10}%`;
}

/** Format milliseconds (matches html.ts fmtMs). */
export function fmtMs(v: number | null | undefined): string {
	if (v == null) return "\u2014";
	return v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`;
}

/** Format a number with fixed decimals or em-dash for null (matches fmtNum). */
export function fmtNum(
	v: number | null | undefined,
	dec: number,
): string {
	if (v == null || typeof v !== "number") return "\u2014";
	return v.toFixed(dec);
}

/** Collapse an array of numbers into a range string or single value. */
export function collapseNum(samples: number[]): string {
	if (samples.length === 0) return "\u2014";
	const lo = Math.min(...samples);
	const hi = Math.max(...samples);
	if (lo === hi) return lo.toLocaleString();
	return `${lo.toLocaleString()}\u2013${hi.toLocaleString()}`;
}

/** Collapse an array of rates into a range string or single value. */
export function collapseRate(samples: number[]): string {
	if (samples.length === 0) return "\u2014";
	const lo = Math.min(...samples);
	const hi = Math.max(...samples);
	if (lo === hi) return `$${lo.toFixed(6)}`;
	return `$${lo.toFixed(6)}\u2013$${hi.toFixed(6)}`;
}

/** Format a date string or null as locale string or em-dash. */
export function fmtDate(ts: string | number | null | undefined): string {
	if (!ts) return "\u2014";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return "\u2014";
	}
}

/** Format tokens as human-readable (1.2M / 340K / 890 / —). */
export function fmtTokens(v: number | null | undefined): string {
	if (v == null) return "\u2014";
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${Math.round(v / 1000)}K`;
	return v.toLocaleString();
}

/** Format USD savings (always 4 decimals, null → em-dash). */
export function fmtDollars(v: number | null | undefined): string {
	if (v == null) return "\u2014";
	return `$${v.toFixed(4)}`;
}

/**
 * Format an ISO timestamp as relative time ("2m ago", "3h ago", "just now").
 * Falls back to locale date for times >24h or unparseable input.
 */
export function fmtRelativeTime(
	ts: string | number | null | undefined,
): string {
	if (!ts) return "\u2014";
	let date: Date;
	try {
		date = new Date(ts);
		if (isNaN(date.getTime())) return "\u2014";
	} catch {
		return "\u2014";
	}
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 0) return "just now";
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hrs = Math.floor(min / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return date.toLocaleDateString();
}

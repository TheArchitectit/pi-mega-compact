/**
 * themes.ts — SINGLE SOURCE OF TRUTH for game-mode visual-effect themes (S30).
 *
 * Each theme defines BOTH an HTML/CSS palette (dashboard) AND an ANSI accent
 * mapping (TUI widget), since the TUI is ANSI and the dashboard is HTML.
 *
 * Theme scope (QA1 correction): themes restyle the mega-compact statusbar
 * widget + the whole dashboard HTML page. We do NOT theme pi's chrome.
 *
 * `transparent` (default) semantics: no background fill, colored accents only —
 * so game-mode stays visible against any terminal background.
 *
 * PREVENT-PI-004: pure config, no network. Pi-agnostic: no pi runtime types.
 */

/** HTML/CSS palette for the dashboard (hex strings, or `null` for "no bg"). */
export interface ThemeCss {
  /** Page/cell background hex, or `null` for transparent (no bg fill). */
  bg: string | null;
  /** Default foreground (text) hex. */
  fg: string;
  /** Accent hex (bars, highlights, level numbers). */
  accent: string;
  /** MEGA CACHE highlight hex (fires at cache >= 100%). */
  mega: string;
}

/** ANSI accent mapping for the TUI widget (SGR parameter strings, no `\x1b[`).
 *  `bg` is `null` for transparent themes (no background fill). */
export interface ThemeAnsi {
  /** Background SGR params (e.g. "48;5;23"), or `null` for no bg fill. */
  bg: string | null;
  /** Foreground SGR params (e.g. "39" for default, "92" for bright green). */
  fg: string;
  /** Accent SGR params. */
  accent: string;
  /** MEGA CACHE SGR params (fires at cache >= 100%). */
  mega: string;
}

/** A complete theme = CSS palette + ANSI mapping + display metadata. */
export interface Theme {
  id: string;
  label: string;
  css: ThemeCss;
  ansi: ThemeAnsi;
}

export const DEFAULT_THEME = "transparent";

export const THEMES: readonly Theme[] = [
  {
    id: "transparent",
    label: "Transparent (accents only)",
    css: { bg: null, fg: "#c9d1d9", accent: "#3fb950", mega: "#f0883e" },
    ansi: { bg: null, fg: "39", accent: "32", mega: "33" },
  },
  {
    id: "retro",
    label: "Retro 8-bit green",
    css: { bg: "#003300", fg: "#33ff33", accent: "#00ff41", mega: "#39ff14" },
    ansi: { bg: "40", fg: "92", accent: "92", mega: "1;92" },
  },
  {
    id: "orange-bold",
    label: "Orange bold",
    css: { bg: "#1a0f00", fg: "#ff8c00", accent: "#ff6b00", mega: "#ff4500" },
    ansi: { bg: "48;5;52", fg: "38;5;208", accent: "38;5;208", mega: "1;38;5;202" },
  },
  {
    id: "cyan-neon",
    label: "Cyan neon",
    css: { bg: "#001a1a", fg: "#00ffff", accent: "#22d3ee", mega: "#7df9ff" },
    ansi: { bg: "48;5;23", fg: "38;5;51", accent: "38;5;51", mega: "1;38;5;51" },
  },
  {
    id: "amber-mono",
    label: "Amber phosphor",
    css: { bg: "#1a1200", fg: "#ffb000", accent: "#ff8c00", mega: "#ff5500" },
    ansi: { bg: "48;5;58", fg: "38;5;214", accent: "38;5;214", mega: "1;38;5;208" },
  },
  {
    id: "grayscale",
    label: "Grayscale minimal",
    css: { bg: "#161616", fg: "#b0b0b0", accent: "#8b949e", mega: "#e6edf3" },
    ansi: { bg: "48;5;235", fg: "38;5;249", accent: "38;5;249", mega: "1;38;5;255" },
  },
] as const;

/** All valid theme ids, in definition order (used for `theme next` cycling). */
export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

/** Look up a theme by id; returns `undefined` for an unknown id (caller
 *  validates + falls back to DEFAULT_THEME). */
export function getTheme(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** True if `id` is a known theme id. */
export function isValidTheme(id: string): boolean {
  return THEME_IDS.includes(id);
}

/** Cycle to the next theme id (wraps at the end). Falls back to DEFAULT_THEME
 *  if `current` is unknown (defensive — the stored id should always be valid). */
export function nextTheme(current: string): string {
  const i = THEME_IDS.indexOf(current);
  if (i < 0) return DEFAULT_THEME;
  return THEME_IDS[(i + 1) % THEME_IDS.length]!;
}

/** CSS variable declarations for a theme's CSS palette. `bg` is `null` for the
 *  transparent theme → `--bg: transparent` (no page fill, accents only). Pure,
 *  no pi types. */
export function themeCssVars(theme: Theme): string {
  const bg = theme.css.bg ?? "transparent";
  return `--bg: ${bg}; --fg: ${theme.css.fg}; --accent: ${theme.css.accent}; --mega: ${theme.css.mega};`;
}

/** A `:root[data-theme="<id>"]` override block carrying the theme's CSS vars,
 *  for client-side instant theme switching. Pure, no pi types. */
export function themeDataBlock(theme: Theme): string {
  return `:root[data-theme="${theme.id}"]{ ${themeCssVars(theme)} }`;
}

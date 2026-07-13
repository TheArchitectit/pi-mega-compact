/**
 * normalize.ts — text normalization for content-addressable dedup (Sprint 9).
 *
 * The L0 dedup key is `sha256(normalize(text))`, so normalization decides which
 * surface variants collapse to the same checkpoint. Pure, synchronous, no deps.
 *
 * Steps (order matters):
 *   1. strip ANSI escape sequences (terminal color codes leak into tool output)
 *   2. Unicode NFC (canonical composition — "e" + combining accent == "é")
 *   3. case-fold (NFKC Cf + toLowerCase) so "Foo"/"foo"/"FOO" collapse (Sprint 10 L0 upgrade)
 *   4. normalize newlines (CRLF/CR → LF)
 *   5. collapse runs of whitespace to a single space, trim ends
 *   6. cap at 32K chars (bounds hashing cost on pathological inputs — QA #7/#15)
 */

const MAX_CHARS = 32_768;

// ANSI/VT100 escape sequence: ESC (0x1B) [ ...params... [ -/]* final-byte.
// Built from the code point so the source file contains no literal escape byte.
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(ESC + "\\[[0-?]*[ -/]*[@-~]", "g");

/** Strip ANSI/VT100 escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Normalize text to its canonical dedup form. Deterministic and idempotent:
 * `normalize(normalize(x)) === normalize(x)`.
 */
export function normalize(text: string): string {
  if (!text) return "";
  let out = stripAnsi(text);
  out = out.normalize("NFC");
  out = out.toLocaleLowerCase(); // case-fold so "Foo"/"FOO" collapse to one key
  out = out.replace(/\r\n?/g, "\n"); // CRLF / CR → LF
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
  return out;
}

/**
 * Token estimation — rough, deterministic, no LLM.
 *
 * Ported from claw-code rusty-claude-cli compact.rs estimate_message_tokens
 * (len/4 + 1 per content block). Good enough to gate compaction and to report
 * tokens-saved; NOT a substitute for a real tokenizer.
 */

/** Estimate tokens for a single text/tool block already as a string. */
export function estimateBlockTokens(text: string): number {
  return Math.floor(text.length / 4) + 1;
}

/**
 * Estimate tokens for an EngineMessage. Tool-use/result blocks carry name +
 * input/output strings, mirrored from the claw-code block accounting.
 */
export function estimateMessageTokens(msg: {
  text?: string;
  toolName?: string;
  input?: string;
  output?: string;
}): number {
  let t = 0;
  if (msg.text) t += estimateBlockTokens(msg.text);
  if (msg.toolName) t += estimateBlockTokens(msg.toolName);
  if (msg.input) t += estimateBlockTokens(msg.input);
  if (msg.output) t += estimateBlockTokens(msg.output);
  return t;
}

/** Sum tokens over a list of messages. */
export function estimateSessionTokens(messages: Array<{ text?: string; toolName?: string; input?: string; output?: string }>): number {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}

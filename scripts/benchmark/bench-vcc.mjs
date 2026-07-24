// pi-vcc benchmark: algorithmic compaction, no LLM calls
// Reads files from a repo, sends real API calls, compacts at checkpoints

import { readFileSync, readdirSync, writeFileSync, appendFileSync } from 'fs';
import { join, relative } from 'path';
import { parseArgs } from 'util';

const { values, positionals } = parseArgs({
  options: {
    'provider-url': { type: 'string' },
    'api-key': { type: 'string' },
    'max-tokens': { type: 'string', default: '1000000' },
    'checkpoint-interval': { type: 'string', default: '50000' },
    output: { type: 'string', default: 'vcc-results.jsonl' },
  },
  allowPositionals: true,
});

const REPOS = positionals;
const PROVIDER_URL = values['provider-url'];
const API_KEY = values['api-key'];
const MAX_TOKENS = parseInt(values['max-tokens']);
const CHECKPOINT_INTERVAL = parseInt(values['checkpoint-interval']);
const OUTPUT_FILE = values.output;

if (!REPOS.length || !PROVIDER_URL || !API_KEY) {
  console.error('Usage: node bench-ucs03.mjs --provider-url URL --api-key KEY repo1 [repo2 ...]');
  process.exit(1);
}

function walkRepo(dir, base = dir) {
  const results = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.claude', '.playwright-mcp']);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { results.push(...walkRepo(full, base)); continue; }
    if (/\.(ts|tsx|js|jsx|go|py|rs|md|json|yaml|yml|toml|sql|css|html)$/.test(entry.name)) {
      try {
        const content = readFileSync(full, 'utf-8');
        results.push({ path: relative(base, full), content, size: content.length });
      } catch {}
    }
  }
  return results;
}

function estimateTokens(text) { return Math.ceil(text.length / 4); }

// --- VCC Algorithm (ported from pi-vcc source) ---
const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;
const BLOCKER_RE = /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

function filterNoise(messages) {
  return messages.filter(m => {
    if (m.role === 'system') return false;
    if (m.role === 'assistant' && !m.content?.trim()) return false;
    return true;
  });
}

function extractGoals(messages) {
  const goals = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = m.content.replace(XML_WRAPPER_RE, '').trim();
    for (const line of text.split('\n')) {
      const clean = line.replace(/^[-*+]\s*/, '').trim();
      if (clean.length > 10 && clean.length < 200 && !clean.startsWith('[')) {
        goals.push(clean);
        break;
      }
    }
  }
  return [...new Set(goals)].slice(-8);
}

function extractFileActivity(messages) {
  const modified = new Set(), created = new Set(), read = new Set();
  for (const m of messages) {
    const text = m.content || '';
    const fileMatches = text.match(/[\w./-]+\.(ts|tsx|js|jsx|go|py|rs|md|json|yaml|yml|toml|sql|css|html)/g) || [];
    for (const f of fileMatches) {
      if (m.role === 'user') read.add(f);
      else if (/write|create|edit|fix|implement|update/i.test(text.slice(0, 200))) modified.add(f);
      else read.add(f);
    }
  }
  for (const p of modified) created.delete(p);
  return { modified, created, read };
}

function extractOutstandingContext(messages) {
  const items = [];
  const tail = messages.slice(-10);
  for (const m of tail) {
    for (const line of (m.content || '').split('\n')) {
      if (BLOCKER_RE.test(line) && line.length > 15 && /^[A-Z`"']/.test(line.trim())) {
        items.push(line.trim().slice(0, 150));
        if (items.length >= 5) return items;
      }
    }
  }
  return items;
}

function buildBriefTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool';
    const text = (m.content || '').replace(XML_WRAPPER_RE, '').trim();
    if (!text) continue;
    const preview = text.split('\n').slice(0, 5).join(' ').slice(0, 300);
    lines.push(`[${role}] ${preview}`);
  }
  return lines.slice(-60).join('\n');
}

function vccCompact(messages, previousSummary) {
  const filtered = filterNoise(messages);
  const goals = extractGoals(filtered);
  const fileActivity = extractFileActivity(filtered);
  const outstanding = extractOutstandingContext(filtered);
  const brief = buildBriefTranscript(filtered);

  const sections = [];
  if (goals.length) sections.push(`[Session Goal]\n${goals.map(g => `- ${g}`).join('\n')}`);
  const fileLines = [];
  const cap = (set, n) => { const a = [...set]; return a.length <= n ? a.join(', ') : a.slice(0, n).join(', ') + ` (+${a.length - n} more)`; };
  if (fileActivity.modified.size) fileLines.push(`- Modified: ${cap(fileActivity.modified, 10)}`);
  if (fileActivity.created.size) fileLines.push(`- Created: ${cap(fileActivity.created, 10)}`);
  if (fileActivity.read.size) fileLines.push(`- Read: ${cap(fileActivity.read, 10)}`);
  if (fileLines.length) sections.push(`[Files And Changes]\n${fileLines.join('\n')}`);
  if (outstanding.length) sections.push(`[Outstanding Context]\n${outstanding.map(o => `- ${o}`).join('\n')}`);

  let summary = sections.join('\n\n');
  if (brief) summary += `\n\n---\n\n${brief}`;
  summary += '\n\n---\n\nUse `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.';

  // Merge with previous summary
  if (previousSummary) {
    const prevBrief = previousSummary.includes('---\n\n') ? previousSummary.split('---\n\n').slice(1).join('---\n\n') : '';
    if (prevBrief) {
      const briefIdx = summary.lastIndexOf('---\n\n');
      if (briefIdx > 0) {
        const headerPart = summary.slice(0, briefIdx);
        const currentBrief = summary.slice(briefIdx);
        summary = headerPart + '\n\n---\n\n' + prevBrief.slice(0, 2000) + '\n\n' + currentBrief;
      }
    }
  }

  return summary;
}

// --- API call ---
async function apiCall(messages, maxTokens = 2048) {
  const resp = await fetch(`${PROVIDER_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages,
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// --- Main ---
async function run() {
  console.log(`\n=== VCC Benchmark ===`);
  console.log(`Repos: ${REPOS.join(', ')}`);
  console.log(`Max tokens per repo: ${MAX_TOKENS.toLocaleString()}, checkpoint every: ${CHECKPOINT_INTERVAL.toLocaleString()}`);

  const allResults = [];

  for (const repo of REPOS) {
    const repoName = repo.split('/').pop();
    console.log(`\n--- ${repoName} ---`);

    const files = walkRepo(repo);
    console.log(`Found ${files.length} source files`);
    files.sort((a, b) => a.size - b.size);

    const conversation = [];
    let totalInputTokens = 0, totalOutputTokens = 0;
    let totalCompactTokens = 0;
    let fileIndex = 0, checkpoint = 0;
    let previousSummary = '';

    while (totalInputTokens + totalOutputTokens < MAX_TOKENS) {
      const file = files[fileIndex % files.length];
      fileIndex++;

      const messages = [
        { role: 'system', content: `You are a senior developer working on ${repoName}. Review code, suggest improvements, be concise.` },
      ];
      const recent = conversation.slice(-20);
      for (const msg of recent) messages.push({ role: msg.role, content: msg.content.slice(0, 2000) });

      const fileContent = file.content.slice(0, 8000);
      messages.push({ role: 'user', content: `Review: ${file.path}\n\`\`\`\n${fileContent}\n\`\`\`\nSummarize and suggest improvements.` });

      try {
        const resp = await apiCall(messages);
        const usage = resp.usage || {};
        const inputTok = usage.prompt_tokens || 0;
        const outputTok = usage.completion_tokens || 0;
        const reply = resp.choices?.[0]?.message?.content || '';

        totalInputTokens += inputTok;
        totalOutputTokens += outputTok;

        conversation.push({ role: 'user', content: `[Read ${file.path}]\n${fileContent.slice(0, 1000)}` });
        conversation.push({ role: 'assistant', content: reply });

        const total = totalInputTokens + totalOutputTokens;
        if (fileIndex % 5 === 0 || total >= (checkpoint + 1) * CHECKPOINT_INTERVAL) {
          const ts = new Date().toISOString().slice(11, 19);
          console.log(`[${ts}] File ${fileIndex}: ${file.path} | ${inputTok}in +${outputTok}out = ${total.toLocaleString()} total`);
        }

        if (total >= (checkpoint + 1) * CHECKPOINT_INTERVAL) {
          checkpoint++;
          console.log(`--- CHECKPOINT ${checkpoint} at ${total.toLocaleString()} tokens ---`);

          const compactStart = Date.now();
          const compactResult = vccCompact(conversation, previousSummary);
          const compactMs = Date.now() - compactStart;
          const compactTok = estimateTokens(compactResult);
          totalCompactTokens += compactTok;
          previousSummary = compactResult;

          const entry = {
            checkpoint, repo: repoName, compactor: 'vcc',
            totalConversationTokens: total,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            compactOutputTokens: compactTok,
            totalCompactTokensSoFar: totalCompactTokens,
            compactAPITokensSpent: 0,
            compactMs,
            compactRatio: (compactTok / total * 100).toFixed(2) + '%',
            conversationLength: conversation.length,
            filesRead: fileIndex,
            timestamp: new Date().toISOString(),
          };
          allResults.push(entry);
          appendFileSync(OUTPUT_FILE, JSON.stringify(entry) + '\n');

          console.log(`Compact: ${compactTok} tokens in ${compactMs}ms (${entry.compactRatio} of conversation)`);

          // Reset conversation after compact
          conversation.length = 0;
          conversation.push({ role: 'assistant', content: compactResult });
        }

        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.log(`API error: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log(`${repoName} done: ${(totalInputTokens + totalOutputTokens).toLocaleString()} tokens, ${checkpoint} checkpoints`);
  }

  console.log(`\nResults written to ${OUTPUT_FILE}`);
}

run().catch(e => { console.error(e); process.exit(1); });

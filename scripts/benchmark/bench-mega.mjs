// MEGA-COMPACT benchmark — uses our actual summarizeMessages from dist/src/compact.js
// Same walk + API + checkpoint structure as the VCC benchmark (apples to apples)

import { readFileSync, readdirSync, appendFileSync } from 'fs';
import { join, relative } from 'path';
import { parseArgs } from 'util';
import { summarizeMessages } from '../../dist/src/compact.js';

const { values, positionals } = parseArgs({
  options: {
    'provider-url': { type: 'string' },
    'api-key': { type: 'string' },
    'max-tokens': { type: 'string', default: '1000000' },
    'checkpoint-interval': { type: 'string', default: '50000' },
    output: { type: 'string', default: 'mega-results.jsonl' },
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
  console.error('Usage: node bench-mega.mjs --provider-url URL --api-key KEY repo1 [repo2 ...]');
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

// Run mega-compact's summarizeMessages on the conversation
function megaCompact(messages) {
  // summarizeMessages expects EngineMessage[]: { role, text, toolName?, input?, output? }
  const engineMessages = messages.map(m => ({
    role: m.role === 'tool' ? 'tool' : m.role,
    text: m.content || '',
  }));
  return summarizeMessages(engineMessages);
}

async function run() {
  console.log(`\n=== MEGA-COMPACT Benchmark ===`);
  console.log(`Repos: ${REPOS.join(', ')}`);
  console.log(`Max tokens per repo: ${MAX_TOKENS.toLocaleString()}, checkpoint every: ${CHECKPOINT_INTERVAL.toLocaleString()}`);

  for (const repo of REPOS) {
    const repoName = repo.split('/').pop();
    console.log(`\n--- ${repoName} ---`);

    const files = walkRepo(repo);
    console.log(`Found ${files.length} source files`);
    files.sort((a, b) => a.size - b.size);

    const conversation = [];  // {role, content}[]
    let totalInputTokens = 0, totalOutputTokens = 0;
    let totalCompactTokens = 0;
    let fileIndex = 0, checkpoint = 0;

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
          const compactResult = megaCompact(conversation);
          const compactMs = Date.now() - compactStart;
          const compactTok = estimateTokens(compactResult);
          totalCompactTokens += compactTok;

          const entry = {
            checkpoint, repo: repoName, compactor: 'mega',
            totalConversationTokens: total,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            compactOutputTokens: compactTok,
            totalCompactTokensSoFar: totalCompactTokens,
            compactAPITokensSpent: 0,  // algorithmic, no API calls
            compactMs,
            compactRatio: (compactTok / total * 100).toFixed(2) + '%',
            conversationLength: conversation.length,
            filesRead: fileIndex,
            timestamp: new Date().toISOString(),
          };
          appendFileSync(OUTPUT_FILE, JSON.stringify(entry) + '\n');

          console.log(`Compact: ${compactTok} tokens in ${compactMs}ms (${entry.compactRatio} of conversation)`);

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

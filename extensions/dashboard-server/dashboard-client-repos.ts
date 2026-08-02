/**
 * dashboard-client-repos.ts — verbatim JS chunk: multi-repo index rendering.
 *
 * Extracted from html.ts (PR0 split) — ZERO behavior change. Second of three
 * chunks concatenated into the dashboard IIFE (core → repos → game). Shares
 * the closure with core + game: uses sanitize() from core, fmtSec/renderGameScores
 * from core/game.
 */

/** Multi-repo index rendering, repo detail modal, active-repos table. */
export function dashboardClientReposJs(): string {
  return `// --- Multi-repo (index.sqlite via /api/index) ---------------------------
function fmtBytesTop(b) {
  b = b || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KiB';
  return b + ' B';
}
function renderIndex(d) {
  d = d || { updatedAt: null, summary: null, repos: [] };
  var repos = d.repos || [];
  var s = d.summary || { totalRepos: 0, totalCheckpoints: 0, totalTokensSaved: 0, totalCompressedOriginalBytes: 0 };
  document.getElementById('sm-repos').textContent = (s.totalRepos || 0).toLocaleString();
  document.getElementById('sm-checkpoints').textContent = (s.totalCheckpoints || 0).toLocaleString();
  document.getElementById('sm-saved').textContent = (s.totalTokensSaved || 0).toLocaleString();
  document.getElementById('sm-bytes').textContent = fmtBytesTop(s.totalCompressedOriginalBytes);

  // Shared clickable-row renderer for both the in-current table and the
  // All-repos tab — each row opens the per-repo detail modal.
  function rowsHtml() {
    if (!repos.length) return '<tr><td colspan="6" class="repo-none">No repositories registered yet.</td></tr>';
    return repos.map(function(r) {
      var model = r.modelName
        ? '<span class="repo-model">' + sanitize(r.modelName) + '</span>'
        : '<span class="repo-none">—</span>';
      var when = r.lastCompactedAt ? new Date(r.lastCompactedAt).toLocaleString() : '—';
      return '<tr class="repo-link" data-repo="' + sanitize(r.repoRoot) + '">' +
        '<td title="' + sanitize(r.repoRoot) + '">' + sanitize(r.displayName || r.repoRoot) + '</td>' +
        '<td>' + model + '</td>' +
        '<td class="num">' + (r.checkpointCount || 0).toLocaleString() + '</td>' +
        '<td class="num">' + (r.tokensSaved || 0).toLocaleString() + '</td>' +
        '<td class="num">' + fmtBytesTop(r.compressedOriginalBytes) + '</td>' +
        '<td class="num">' + sanitize(when) + '</td>' +
      '</tr>';
    }).join('');
  }
  document.getElementById('cur-rows').innerHTML = rowsHtml();
  document.getElementById('all-rows').innerHTML = rowsHtml();
  bindRepoRows();

  var stamp = d.updatedAt ? 'Updated ' + new Date(d.updatedAt).toLocaleTimeString() : '';
  document.getElementById('cur-updated').textContent = stamp;
  document.getElementById('all-updated').textContent = stamp;
  document.getElementById('sm-updated').textContent = stamp;
  renderByModel(repos);
}

// Savings-by-model aggregation for the Summary tab — groups the machine-
// wide repo registry by (modelName || '(unknown)') so the user can see how
// much context + cost mega-compact has reclaimed, broken down by which model
// they were running. $ Saved = Σ(tokensSaved × inputRate) per model. Sorted
// by tokens saved descending so the biggest-reclaim model wins the top row.
function renderByModel(repos) {
  var rows = document.getElementById('bm-rows');
  if (!rows) return;
  if (!repos || !repos.length) {
    rows.innerHTML = '<tr><td colspan="16" class="repo-none">No repositories registered yet.</td></tr>';
    return;
  }
  var groups = {};
  for (var i = 0; i < repos.length; i++) {
    var r = repos[i];
    var key = (r.modelName && String(r.modelName).trim()) || '(unknown)';
    if (!groups[key]) groups[key] = {
      model: key, provider: r.providerName || r.provider || '—', repos: 0, checkpoints: 0,
      tokensSaved: 0, tokensIn: 0, tokensOut: 0, sessions: 0, usd: 0, lastAt: 0,
      inRates: [], outRates: [], ctxWindows: [], maxTokens: [], reasoning: null,
    };
    var g = groups[key];
    g.repos++;
    g.checkpoints += (r.checkpointCount || 0);
    g.tokensSaved += (r.tokensSaved || 0);
    g.tokensIn += (r.tokensDropped || 0);
    g.tokensOut += (r.tokensKept || 0);
    g.sessions += (r.sessions || 0);
    if (r.inputRate) { g.usd += (r.tokensSaved || 0) * r.inputRate; g.inRates.push(r.inputRate); }
    if (r.outputRate) g.outRates.push(r.outputRate);
    if (r.contextWindow) g.ctxWindows.push(r.contextWindow);
    if (r.maxTokens) g.maxTokens.push(r.maxTokens);
    if (r.reasoning != null) g.reasoning = r.reasoning;
    if (r.lastCompactedAt && r.lastCompactedAt > g.lastAt) g.lastAt = r.lastCompactedAt;
  }
  var arr = [];
  for (var k in groups) { if (Object.prototype.hasOwnProperty.call(groups, k)) arr.push(groups[k]); }
  arr.sort(function(a, b) { return b.tokensSaved - a.tokensSaved; });
  // Helper: a set of numeric samples collapses to a single value when all
  // repos in the group agree, otherwise shows the range (min–max) so the
  // user can see mixed-config model groups at a glance.
  function collapseNum(samples) {
    if (!samples || !samples.length) return '—';
    var lo = Math.min.apply(null, samples), hi = Math.max.apply(null, samples);
    return lo === hi ? lo.toLocaleString() : lo.toLocaleString() + '–' + hi.toLocaleString();
  }
  function collapseRate(samples) {
    if (!samples || !samples.length) return '—';
    var lo = Math.min.apply(null, samples), hi = Math.max.apply(null, samples);
    var fmt = function(v) { return '$' + v.toFixed(6); };
    return lo === hi ? fmt(lo) : fmt(lo) + '–' + fmt(hi);
  }
  // Helper: compute cache hit % from providerCacheRead/Write tokens
  function cacheHitPct(cr, cw, inp) {
    var denom = cr + cw + (inp || 0);
    return denom > 0 ? ((cr / denom) * 100).toFixed(1) + '%' : '—';
  }
  // Helper: compute cache $ saved (read = 0.9 * inputRate, write = 0.25 * inputRate)
  function cacheDollar(cr, cw, rate) {
    if (!cr || !rate) return '—';
    var saved = cr * rate * 0.9 - cw * rate * 0.25;
    return '$' + saved.toFixed(4);
  }
  // Aggregate providerCacheRead/Write across repos in this group
  var groupCacheRead = 0, groupCacheWrite = 0, groupTokensIn = 0;
  for (var ii = 0; ii < repos.length; ii++) {
    var rr = repos[ii];
    var key2 = (rr.modelName && String(rr.modelName).trim()) || '(unknown)';
    if (key2 === g.model) {
      groupCacheRead += (rr.providerCacheRead || 0);
      groupCacheWrite += (rr.providerCacheWrite || 0);
      groupTokensIn += (rr.tokensDropped || 0);
    }
  }
  rows.innerHTML = arr.map(function(g) {
    var freed = (g.tokensIn || 0) - (g.tokensOut || 0);
    // B: always show a dollar value (including $0.0000) — do not use '—' when usd is 0
    var usd = '$' + (g.usd || 0).toFixed(4);
    var when = g.lastAt ? new Date(g.lastAt).toLocaleString() : '—';
    var reas = g.reasoning == null ? '—' : (g.reasoning ? 'yes' : 'no');
    var rate0 = g.inRates && g.inRates.length ? g.inRates[0] : 0;
    return '<tr>' +
      '<td><span class="repo-model">' + sanitize(g.model) + '</span></td>' +
      '<td>' + sanitize(g.provider) + '</td>' +
      '<td class="num">' + (g.tokensIn || 0).toLocaleString() + '</td>' +
      '<td class="num">' + (g.tokensOut || 0).toLocaleString() + '</td>' +
      '<td class="num">' + freed.toLocaleString() + '</td>' +
      '<td class="num">' + collapseNum(g.ctxWindows) + '</td>' +
      '<td class="num">' + collapseNum(g.maxTokens) + '</td>' +
      '<td class="num">' + reas + '</td>' +
      '<td class="num">' + g.sessions.toLocaleString() + '</td>' +
      '<td class="num">' + g.checkpoints.toLocaleString() + '</td>' +
      '<td class="num">' + collapseRate(g.inRates) + '</td>' +
      '<td class="num">' + collapseRate(g.outRates) + '</td>' +
      '<td class="num">' + sanitize(usd) + '</td>' +
      '<td class="num">' + cacheHitPct(groupCacheRead, groupCacheWrite, groupTokensIn) + '</td>' +
      '<td class="num">' + cacheDollar(groupCacheRead, groupCacheWrite, rate0) + '</td>' +
      '<td class="num">' + sanitize(when) + '</td>' +
    '</tr>';
  }).join('');
}

// Per-repo detail modal ---------------------------------------------------
var detailEl = document.getElementById('repo-detail');
var indexCache = { repos: [] };
function openRepoDetail(root) {
  var r = null;
  for (var i = 0; i < indexCache.repos.length; i++) {
    if (indexCache.repos[i].repoRoot === root) { r = indexCache.repos[i]; break; }
  }
  if (!r) return;
  document.getElementById('rd-name').textContent = r.displayName || r.repoRoot;
  document.getElementById('rd-path').textContent = r.repoRoot;
  document.getElementById('rd-model').textContent = r.modelName || '—';
  document.getElementById('rd-provider').textContent = r.providerName || (r.provider || '—');
  document.getElementById('rd-cp').textContent = (r.checkpointCount || 0).toLocaleString();
  document.getElementById('rd-saved').textContent = (r.tokensSaved || 0).toLocaleString();
  document.getElementById('rd-bytes').textContent = fmtBytesTop(r.compressedOriginalBytes);
  document.getElementById('rd-when').textContent = r.lastCompactedAt ? new Date(r.lastCompactedAt).toLocaleString() : '—';
  detailEl.classList.add('open');
}
document.getElementById('rd-close').addEventListener('click', function() { detailEl.classList.remove('open'); });
detailEl.addEventListener('click', function(e) { if (e.target === detailEl) detailEl.classList.remove('open'); });
function bindRepoRows() {
  var rows = document.querySelectorAll('.repo-link');
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener('click', function() { openRepoDetail(this.getAttribute('data-repo')); });
  }
}
function pollIndex() {
  fetch('/api/index').then(function(r) { return r.json(); }).then(function(d) { // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
    indexCache = d && d.repos ? d : indexCache;
    renderIndex(d);
  }).catch(function() {});
}
pollIndex();
setInterval(pollIndex, 5000);

// --- Active repos (live cache-hit / compaction stats) ---------------------
function fmtSec(s) {
  s = s || 0;
  if (s >= 3600) return (s / 3600).toFixed(1) + 'h';
  if (s >= 60) return Math.round(s / 60) + 'm';
  if (s >= 1) return s.toFixed(1) + 's';
  return Math.round(s * 1000) + 'ms';
}
function renderActiveRepos(d) {
  d = d || { updatedAt: null, servers: [] };
  var servers = d.servers || [];
  var rowsEl = document.getElementById('active-rows');
  if (!rowsEl) return;
  if (!servers.length) {
    rowsEl.innerHTML = '<tr><td colspan="9" class="repo-none">No active repositories.</td></tr>';
  } else {
    rowsEl.innerHTML = servers.map(function(r) {
      var ch = r.cacheHits || { session: 0, total: 0, sessionTokensSaved: 0, totalTokensSaved: 0 };
      var cp = r.compacts || { session: 0, total: 0 };
      var ts = r.timeSaved || { compact: { sessionSec: 0, totalSec: 0 }, cacheHit: { sessionSec: 0, totalSec: 0 } };
      return '<tr>' +
        '<td title="' + sanitize(r.repoRoot) + '">' + sanitize(r.displayName || r.repoRoot) + '</td>' +
        '<td>' + sanitize(r.model || '—') + '</td>' +
        '<td>' + sanitize(r.tier || '—') + '</td>' +
        '<td class="num">' + (r.contextPct != null ? Math.round(r.contextPct * 100) + '%' : '—') + '</td>' +
        '<td>' + sanitize(r.state || '—') + '</td>' +
        '<td class="num">' + (cp.session || 0) + ' / ' + (cp.total || 0) + '</td>' +
        '<td class="num">' + (ch.session || 0) + ' / ' + (ch.total || 0) + '</td>' +
        '<td class="num">' + fmtSec(ts.compact.sessionSec) + ' / ' + fmtSec(ts.compact.totalSec) + '</td>' +
        '<td class="num">' + fmtSec(ts.cacheHit.sessionSec) + ' / ' + fmtSec(ts.cacheHit.totalSec) + '</td>' +
      '</tr>';
    }).join('');
  }
  var upd = document.getElementById('active-updated');
  if (upd) upd.textContent = d.updatedAt ? 'Updated ' + new Date(d.updatedAt).toLocaleTimeString() : '';
}
function pollServers() {
  fetch('/api/servers').then(function(r) { return r.json(); }).then(renderActiveRepos).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
}
pollServers();
setInterval(pollServers, 5000);

`;
}

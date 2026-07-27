/**
 * dashboard-client-game.ts — verbatim JS chunk: game-mode, achievements, perf, tabs.
 *
 * Extracted from html.ts (PR0 split) — ZERO behavior change. Third of three
 * chunks concatenated into the dashboard IIFE (core → repos → game). Shares
 * the closure with core + repos.
 */

/** Game-mode settings, leaderboards, achievements, perf tab, tab switching. */
export function dashboardClientGameJs(): string {
  return `// --- Game-mode settings strip (S32) -------------------------------------
// Polls GET /api/game-state and applies the row to the settings controls +
// the document theme. On any control change, PUTs a partial patch back. The
// dashboard server is a detached child with no MegaRuntime ref, so it reads /
// writes the game_state SQLite row directly; the in-process MegaRuntime picks
// up the change via its fs.watch cache-eviction watcher (S32).
var gmCheckbox = document.getElementById('set-game-mode');
var gmTheme = document.getElementById('set-theme');
var gmTui = document.getElementById('set-tui-mode');

function applyGameState(gs) {
  if (!gs) return;
  if (gs.theme) document.documentElement.dataset.theme = gs.theme;
  if (gmCheckbox) gmCheckbox.checked = !!gs.game_mode_on;
  if (gmTheme) gmTheme.value = gs.theme || 'transparent';
  if (gmTui) gmTui.value = gs.tui_display_mode || 'full';
}
function pollGameState() {
  fetch('/api/game-state').then(function(r) { return r.json(); }).then(applyGameState).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
}
function putGameState(patch) {
  fetch('/api/game-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(function(r) { return r.json(); }).then(applyGameState).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
}
if (gmCheckbox) gmCheckbox.addEventListener('change', function() { putGameState({ game_mode_on: gmCheckbox.checked }); });
if (gmTheme) gmTheme.addEventListener('change', function() { putGameState({ theme: gmTheme.value }); });
// P3: client-side theme cycling (no new endpoint). Reads the already-fetched
// <option> values from the theme select, so it stays in sync with the server's
// THEMES list without a second fetch.
var gmThemeNext = document.getElementById('set-theme-next');
if (gmThemeNext) gmThemeNext.addEventListener('click', function() {
  var opts = gmTheme ? gmTheme.options : [];
  var n = opts.length;
  var cur = gmTheme ? gmTheme.value : 'transparent';
  var idx = -1;
  for (var i = 0; i < n; i++) { if (opts[i].value === cur) { idx = i; break; } }
  var next = n > 0 ? opts[(idx < 0 ? 0 : (idx + 1) % n)].value : 'transparent';
  putGameState({ theme: next });
});
if (gmTui) gmTui.addEventListener('change', function() { putGameState({ tui_display_mode: gmTui.value }); });
pollGameState();
setInterval(pollGameState, 5000);

// --- Game Mode leaderboards (S34) ----------------------------------------
// Polls GET /api/game-scores per metric, renders the per-repo leaderboard
// tables, the MEGA CACHE banner, the hidden Opie's Wild Ride unlock tile, and
// the transient oopsie toast (fires when a NEW mega_cache trophy row appears
// since the last poll). Browser-side fetch only (PREVENT-PI-004).
var GAME_METRICS = ['cache', 'dedupe', 'turns', 'mega_cache'];
var GAME_EMPTY = true;
var lastMegaTs = 0;
var lastMaxLevel = 0;
function fmtPct(v) { return (Math.round(v * 10) / 10) + '%'; }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
function trophyMeta(m) { try { return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; } }
function renderGameScores() {
  var results = {};
  var pending = GAME_METRICS.length + 1; // metrics + repos badge
  function done() {
    if (--pending > 0) return;
    var cache = results['cache'] || [];
    if (cache.length) GAME_EMPTY = false;
    document.getElementById('lb-cache').innerHTML = cache.map(function(r) {
      return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(String(r.value)) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="repo-none">no data</td></tr>';
    var dedupe = results['dedupe'] || [];
    if (dedupe.length) GAME_EMPTY = false;
    document.getElementById('lb-dedupe').innerHTML = dedupe.map(function(r) {
      return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(String(r.value)) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="repo-none">no data</td></tr>';
    var turns = results['turns'] || [];
    var maxTurns = turns.reduce(function(mx, r) { return Math.max(mx, r.value); }, 0);
    var lvl = Math.floor(Math.log2(maxTurns + 1)) + 1;
    var lvlEl = document.getElementById('turns-level');
    if (lvlEl) lvlEl.textContent = 'LVL ' + lvl;
    if (turns.length) GAME_EMPTY = false;
    // level-up pulse: when max level increases vs last poll, pulse the cache bar
    if (lvl > lastMaxLevel && lastMaxLevel > 0) {
      var bar = document.getElementById('ctx-bar');
      if (bar) { bar.classList.add('level-up'); setTimeout(function() { bar.classList.remove('level-up'); }, 1200); }
    }
    if (lvl > lastMaxLevel) lastMaxLevel = lvl;
    document.getElementById('lb-turns').innerHTML = turns.map(function(r) {
      return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(String(r.value)) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="repo-none">no data</td></tr>';
    // mega_cache trophies + banner + Opie tile + transient toast
    var mega = results['mega_cache'] || [];
    var megaBody = document.getElementById('lb-mega_cache');
    if (megaBody) {
      megaBody.innerHTML = mega.map(function(r) {
        var m = trophyMeta(r.meta);
        var fs = m.firstSeenTs || m.firstSeen || r.ts;
        var extra = fs ? ' <span class="lb-meta">' + sanitize(fmtDate(fs)) + '</span>' : '';
        return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(fmtPct(r.value)) + extra + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="repo-none">no trophies yet</td></tr>';
    }
    var banner = document.getElementById('mega-cache-banner');
    var tile = document.getElementById('opie-tile');
    var best = null, firstSeen = null;
    mega.forEach(function(r) {
      if (best == null || r.value > best) best = r.value;
      var m = trophyMeta(r.meta);
      var fs = m.firstSeenTs || m.firstSeen || r.ts;
      if (firstSeen == null || fs < firstSeen) firstSeen = fs;
    });
    if (banner) {
      if (best != null && best > 100) {
        banner.style.display = 'block';
        banner.textContent = '🥧 MEGA CACHE! peak ' + fmtPct(best) + ' — first reached ' + fmtDate(firstSeen);
      } else { banner.style.display = 'none'; }
    }
    if (tile) {
      if (best != null && best > 100) {
        tile.style.display = 'block';
        tile.className = 'achievement-tile unlocked';
        tile.innerHTML = '🏆 Opie\\'s Wild Ride<span class="ach-detail">best ' + sanitize(fmtPct(best)) + ' · first ' + sanitize(fmtDate(firstSeen)) + '</span>';
      } else { tile.style.display = 'none'; tile.className = 'achievement-tile'; }
    }
    // transient oopsie toast: a NEW mega_cache trophy row since the last poll
    var maxTs = mega.reduce(function(mx, r) { return Math.max(mx, r.ts); }, 0);
    var newRow = mega.find(function(r) { return r.ts > lastMegaTs && r.value > 100; });
    if (lastMegaTs && newRow) {
      var toast = document.getElementById('mega-cache-toast');
      if (toast) {
        toast.textContent = 'oopsie! cache went to ' + Math.round(newRow.value) + '% — MEGA CACHE 🥧';
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 4000);
      }
    }
    if (maxTs > lastMegaTs) lastMegaTs = maxTs;
    // empty state
    var emptyEl = document.getElementById('game-empty');
    if (emptyEl) emptyEl.style.display = GAME_EMPTY ? 'block' : 'none';
  }
  GAME_METRICS.forEach(function(m) {
    fetch('/api/game-scores?metric=' + encodeURIComponent(m) + '&limit=25').then(function(r) { return r.ok ? r.json() : []; }).then(function(rows) { results[m] = rows || []; }).catch(function() { results[m] = []; }).then(done);
  });
  fetch('/api/game-scores?metric=repos&limit=1').then(function(r) { return r.ok ? r.json() : []; }).then(function(rows) {
    var badge = document.getElementById('repos-badge');
    if (badge) badge.textContent = ((rows && rows.length) ? rows[0].value : 0) + ' repos';
    if (rows && rows.length && rows[0].value > 0) GAME_EMPTY = false;
  }).catch(function() {}).then(done);
}

// --- Achievements tile row (S35) ------------------------------------------
// Polls GET /api/achievements; renders the tile row (hidden+locked render
// NOTHING; unlocked show icon+title+date; visible-but-locked show ??? teaser)
// and fires a transient toast when a newly-unlocked achievement appears.
// Browser-side fetch only (PREVENT-PI-004).
var lastAchMaxTs = 0;
function renderAchievements() {
  fetch('/api/achievements').then(function(r) { return r.ok ? r.json() : []; }).then(function(rows) { // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
    var box = document.getElementById('ach-tiles');
    if (!box) return;
    var html = '';
    var maxTs = 0;
    (rows || []).forEach(function(a) {
      if (a.hidden === 1 && a.unlocked_at == null) return; // hidden invariant: render nothing
      if (a.unlocked_at != null) {
        var isNew = a.unlocked_at > lastAchMaxTs && lastAchMaxTs > 0;
        maxTs = Math.max(maxTs, a.unlocked_at);
        html += '<div class="ach-tile unlocked' + (isNew ? ' just-unlocked' : '') + '">' + sanitize(a.icon || '') + ' ' + sanitize(a.title) + '<span class="ach-detail">unlocked ' + sanitize(fmtDate(a.unlocked_at)) + '</span></div>';
      } else {
        html += '<div class="ach-tile locked">??? ' + sanitize(a.title) + '</div>';
      }
    });
    box.innerHTML = html || '<span class="repo-none">no achievements yet</span>';
    var newly = (rows || []).filter(function(a) { return a.unlocked_at != null && a.unlocked_at > lastAchMaxTs; });
    if (lastAchMaxTs && newly.length) {
      var toast = document.getElementById('ach-toast');
      if (toast) {
        toast.textContent = newly.map(function(a) { return (a.icon || '') + ' ' + a.title; }).join(', ') + ' unlocked!';
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 4000);
      }
    }
    if (maxTs > lastAchMaxTs) lastAchMaxTs = maxTs;
  }).catch(function() {});
}

// --- Perf tab (v0.8.8) — live local instrumentation ----------------------
var perfPollTimer = null;
function pollPerf() {
  fetch('/api/perf?minutes=30').then(function(r) { return r.ok ? r.json() : null; }).then(function(d) { // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
    if (!d) return;
    var el = document.getElementById('perf-updated');
    if (el) el.textContent = d.sampleCount + ' samples · updated ' + (d.updatedAt || '');
    function setText(id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; }
    function fmtMs(v) { return v == null ? '—' : (v >= 100 ? Math.round(v) + 'ms' : v.toFixed(1) + 'ms'); }
    function fmtNum(v, dec) { return v == null ? '—' : (typeof v === 'number' ? v.toFixed(dec) : '—'); }
    setText('pf-turn-p50', fmtMs(d.turn_latency_ms && d.turn_latency_ms.p50));
    setText('pf-turn-p95', fmtMs(d.turn_latency_ms && d.turn_latency_ms.p95));
    setText('pf-prov-p50', fmtMs(d.provider_latency_ms && d.provider_latency_ms.p50));
    setText('pf-prov-p95', fmtMs(d.provider_latency_ms && d.provider_latency_ms.p95));
    setText('pf-tps', fmtNum(d.tps && d.tps.avg, 1));
    setText('pf-cache', (d.cache_hit_pct && typeof d.cache_hit_pct.avg === 'number') ? fmtNum(d.cache_hit_pct.avg, 1) + '%' : '—');
    setText('pf-rss', (d.rss_mb && typeof d.rss_mb.latest === 'number') ? fmtNum(d.rss_mb.latest, 1) + ' MB' : '—');
    setText('pf-heap', (d.heap_mb && typeof d.heap_mb.latest === 'number') ? fmtNum(d.heap_mb.latest, 1) + ' MB' : '—');
    setText('pf-cpu', (d.cpu_user_ms && d.cpu_sys_ms) ? (fmtNum(d.cpu_user_ms.latest,1) + ' / ' + fmtNum(d.cpu_sys_ms.latest,1) + ' ms') : '—');
    setText('pf-db-p50', fmtMs(d.db_recompute_ms && d.db_recompute_ms.p50));
    setText('pf-db-p95', fmtMs(d.db_recompute_ms && d.db_recompute_ms.p95));
    setText('pf-disk', fmtMs(d.disk_write_ms && d.disk_write_ms.p50));
    var diag = d.diag || {};
    setText('pf-recompute', diag.liveTrimFires != null ? String(diag.liveTrimFires) : '—');
    setText('pf-replays', diag.liveTrimReplays != null ? String(diag.liveTrimReplays) : '—');
    setText('pf-skips', diag.ctxFastGate != null ? String(diag.ctxFastGate) : '—');
  }).catch(function() {});
}
function startPerfPoll() { if (perfPollTimer) return; pollPerf(); perfPollTimer = setInterval(pollPerf, 2000); }
function stopPerfPoll() { if (perfPollTimer) { clearInterval(perfPollTimer); perfPollTimer = null; } }

// --- Tab switching ------------------------------------------------------
var tabs = document.querySelectorAll('.tab');
var panels = { current: 'panel-current', all: 'panel-all', active: 'panel-active', summary: 'panel-summary', game: 'panel-game', perf: 'panel-perf' };
for (var i = 0; i < tabs.length; i++) {
  tabs[i].addEventListener('click', function() {
    var name = this.getAttribute('data-tab');
    for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
    this.classList.add('active');
    for (var k in panels) {
      if (Object.prototype.hasOwnProperty.call(panels, k)) {
        var el = document.getElementById(panels[k]);
        if (el) el.classList.toggle('active', k === name);
      }
    }
    if (name === 'all' || name === 'summary') pollIndex();
    if (name === 'active') pollServers();
    if (name === 'game') { renderGameScores(); renderAchievements(); }
    if (name === 'perf') startPerfPoll(); else stopPerfPoll();
  });
}
})();`;
}

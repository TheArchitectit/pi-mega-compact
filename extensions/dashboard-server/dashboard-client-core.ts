/**
 * dashboard-client-core.ts — verbatim JS chunk: snapshot + SSE + event rendering.
 *
 * Extracted from html.ts (PR0 split) — ZERO behavior change. This is one of
 * three chunks whose concatenation forms the dashboard's IIFE client script
 * (see dashboard-client.ts). The chunks share one closure, so they must be
 * concatenated in order: core → repos → game.
 */

/** Snapshot rendering, event/SSE handling, and shared helpers. */
export function dashboardClientCoreJs(): string {
  return `var evBox = document.getElementById('events');
var evBuffer = [];
var MAX_EV = 50;
var offlineBanner = document.getElementById('offline-banner');

function bullet(el, on, na) {
  el.className = 'bullet ' + (na ? 'bullet-na' : on ? 'bullet-on' : 'bullet-off');
}

function renderSnapshot(d) {
  if (!d || !d.updatedAt) { offlineBanner.style.display = 'block'; return; }
  offlineBanner.style.display = 'none';

  var pct = d.context.percent || 0;
  document.getElementById('ctx-pct').textContent = pct + '%';
  var bar = document.getElementById('ctx-bar');
  bar.style.width = Math.max(pct, 1) + '%';
  bar.className = 'meter-fill ' + (pct >= 90 ? 'meter-red' : pct >= 70 ? 'meter-yellow' : 'meter-green');
  var tok = d.context.tokens != null ? d.context.tokens.toLocaleString() : '?';
  var win = d.context.contextWindow ? d.context.contextWindow.toLocaleString() : '?';
  document.getElementById('ctx-sub').textContent = tok + ' / ' + win + ' tokens';

  bullet(document.getElementById('tr-armed'), d.trigger.armed, false);
  bullet(document.getElementById('tr-ready'), d.trigger.ready, !d.trigger.armed);
  var state = d.trigger.ready ? 'THRESHOLD EXCEEDED — compacting next event' :
              d.trigger.armed ? 'past fast gate — monitoring token count' : 'idle — below fast gate';
  document.getElementById('tr-state').textContent = state;

  // ---- Vector Store — reconciled token accounting (same formula as widget) -
  document.getElementById('st-count').textContent = d.store.checkpointCount;
  // Compression block from the snapshot (Freed = In − Out, single formula).
  var c = d.compression || {};
  var sess = c.session || { tokensIn:0, tokensOut:0, tokensFreed:0, compressionPct:0, dedupPct:0 };
  var cRepo = c.repo || { tokensIn:0, tokensOut:0, tokensFreed:0, compressionPct:0, dedupPct:0 };
  document.getElementById('st-in').textContent = sess.tokensIn.toLocaleString();
  document.getElementById('st-kept').textContent = sess.tokensOut.toLocaleString();
  document.getElementById('st-freed').textContent = sess.tokensFreed.toLocaleString();
  var sp = sess.compressionPct || 0;
  document.getElementById('st-compress-bar').style.width = Math.max(sp * 100, 0.5) + '%';
  document.getElementById('st-compress-bar').className = 'meter-fill ' + (sp >= 0.9 ? 'meter-green' : sp >= 0.6 ? 'meter-yellow' : 'meter-red');
  document.getElementById('st-compress-sub').textContent = (sp * 100 >= 10 ? Math.round(sp * 100) : (sp * 100).toFixed(1)) + '% tokens saved · dedup: ' + (sess.dedupPct * 100 >= 10 ? Math.round(sess.dedupPct * 100) : (sess.dedupPct * 100).toFixed(1)) + '%';
  // ------
  document.getElementById('st-injected').textContent = d.store.injectedCount;
  document.getElementById('st-dedup').textContent = Math.round(d.store.dedupHitRate * 100) + '%';
  var sdr = d.store.storageDedupRate || 0;
  document.getElementById('st-sdedup').textContent = (sdr * 100 >= 10 ? Math.round(sdr * 100) : (sdr * 100).toFixed(1)) + '%';
  document.getElementById('st-collapsed').textContent = d.store.dedupCollapsed || 0;
  document.getElementById('st-lastid').textContent = d.session.lastCheckpointId || '—';

  // ---- Repo (all sessions) — same compression fields, repo scope ----------
  document.getElementById('rp-count').textContent = (d.repo && d.repo.checkpointCount || 0).toLocaleString();
  document.getElementById('rp-in').textContent = cRepo.tokensIn.toLocaleString();
  document.getElementById('rp-kept').textContent = cRepo.tokensOut.toLocaleString();
  document.getElementById('rp-freed').textContent = cRepo.tokensFreed.toLocaleString();
  document.getElementById('rp-sessions').textContent = (d.repo && d.repo.sessionCount || 0).toLocaleString();
  document.getElementById('rp-collapsed').textContent = (d.repo && d.repo.dedupCollapsed || 0).toLocaleString();
  var rdr = d.repo && d.repo.storageDedupRate || 0;
  document.getElementById('rp-sdedup').textContent = (rdr * 100 >= 10 ? Math.round(rdr * 100) : (rdr * 100).toFixed(1)) + '%';
  var rp = cRepo.compressionPct || 0;
  document.getElementById('rp-compress-bar').style.width = Math.max(rp * 100, 0.5) + '%';
  document.getElementById('rp-compress-bar').className = 'meter-fill ' + (rp >= 0.9 ? 'meter-green' : rp >= 0.6 ? 'meter-yellow' : 'meter-red');
  document.getElementById('rp-compress-sub').textContent = (rp * 100 >= 10 ? Math.round(rp * 100) : (rp * 100).toFixed(1)) + '% tokens saved · dedup: ' + (cRepo.dedupPct * 100 >= 10 ? Math.round(cRepo.dedupPct * 100) : (cRepo.dedupPct * 100).toFixed(1)) + '%';

  // Data-safety invariant (Phase 0 — trust foundation).
  var ig = d.integrity || { regionsRetained: 0, compressedOriginalBytes: 0, duplicatesCollapsed: 0, bytesPermanentlyDeleted: 0 };
  function fmtBytes(b) {
    b = b || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KiB';
    return b + ' B';
  }
  document.getElementById('ig-retained').textContent = (ig.regionsRetained || 0).toLocaleString();
  document.getElementById('ig-bytes').textContent = fmtBytes(ig.compressedOriginalBytes);
  document.getElementById('ig-dupes').textContent = (ig.duplicatesCollapsed || 0).toLocaleString();
  document.getElementById('ig-deleted').textContent = fmtBytes(ig.bytesPermanentlyDeleted);

  // Crew / agents (live sub-agent activity + turn).
  var crew = d.crew || { activeAgents: 0, currentTurn: 0 };
  document.getElementById('cr-agents').textContent = crew.activeAgents || 0;
  document.getElementById('cr-turn').textContent = crew.currentTurn || 0;
  document.getElementById('cr-status').textContent = (crew.activeAgents > 0)
    ? ('▶ ' + crew.activeAgents + ' running') : 'idle';

  // S24: headline tier is the LIVE pressure band; the config card shows the
  // env preset + live pressure ratio so the user sees the system react.
  document.getElementById('hdr-tier').textContent = d.tier;
  document.getElementById('cf-tier').textContent = d.tier + ' (live)';
  document.getElementById('cf-preset').textContent = d.presetTier;
  document.getElementById('cf-pressure').textContent = Math.round((d.pressure || 0) * 100) + '%';
  // (b) Threshold: show the effective token threshold AND the % of the model
  // context window it represents (percentage-based tiers). d.config.tierPct
  // is present on the live snapshot written by the runtime (Phase-1/2a).
  var cfgPct = d.config.tierPct;
  var cw = d.context.contextWindow || 0;
  var thresholdTxt = d.config.thresholdTokens.toLocaleString();
  if (cfgPct != null && cw > 0) {
    thresholdTxt += ' (' + Math.round(cfgPct * 100) + '% of ' + cw.toLocaleString() + ')';
  }
  document.getElementById('cf-threshold').textContent = thresholdTxt;
  // (c) Fast Gate: arming floor — live trim arms once context passes this %.
  document.getElementById('cf-gate').textContent = d.config.fastGatePct + '%';
  document.getElementById('cf-auto').textContent = d.config.auto ? 'enabled' : 'disabled';
  document.getElementById('cf-anchor').textContent = d.config.anchorUserMessages;

  // --- Active model + cost savings (same calc as /mega-status) ---------------
  var model = d.model;
  document.getElementById('hdr-model').textContent = model && model.name ? model.name : '—';
  document.getElementById('md-name').textContent = model && model.name ? model.name : '—';
  document.getElementById('md-provider').textContent = model && model.providerName ? model.providerName : (model && model.provider ? model.provider : '—');
  document.getElementById('md-input').textContent = model && model.inputRate ? '$' + (model.inputRate).toFixed(6) : '—';
  document.getElementById('md-output').textContent = model && model.outputRate ? '$' + (model.outputRate).toFixed(6) : '—';
  var repoSaved = cRepo.tokensFreed || 0;
  if (model && model.inputRate && repoSaved > 0) {
    var usd = (repoSaved * model.inputRate);
    var win = d.context.contextWindow || 0;
    var windows = win > 0 ? (repoSaved / win).toFixed(1) : '0';
    document.getElementById('cost-usd').textContent = '≈ $' + usd.toFixed(4) + ' saved';
    document.getElementById('cost-windows').textContent = windows + ' context-windows extended';
  } else {
    document.getElementById('cost-usd').textContent = '≈ $0.00 saved';
    document.getElementById('cost-windows').textContent = '0 context-windows extended';
  }

  // --- Cache hits & compactions (live counters) ---------------------------
  var ch = d.cacheHits || { session: 0, total: 0, sessionTokensSaved: 0, totalTokensSaved: 0 };
  var cp = d.compacts || { session: 0, total: 0 };
  var ts = d.timeSaved || { compact: { sessionSec: 0, totalSec: 0 }, cacheHit: { sessionSec: 0, totalSec: 0 } };
  document.getElementById('ch-session').textContent = (ch.session || 0).toLocaleString();
  document.getElementById('ch-total').textContent = (ch.total || 0).toLocaleString();
  document.getElementById('ch-tok-session').textContent = (ch.sessionTokensSaved || 0).toLocaleString();
  document.getElementById('ch-tok-total').textContent = (ch.totalTokensSaved || 0).toLocaleString();
  document.getElementById('cp-session').textContent = (cp.session || 0).toLocaleString();
  document.getElementById('cp-total').textContent = (cp.total || 0).toLocaleString();
  document.getElementById('ts-compact-session').textContent = fmtSec(ts.compact.sessionSec);
  document.getElementById('ts-compact-total').textContent = fmtSec(ts.compact.totalSec);
  document.getElementById('ts-cache-session').textContent = fmtSec(ts.cacheHit.sessionSec);
  document.getElementById('ts-cache-total').textContent = fmtSec(ts.cacheHit.totalSec);

  document.getElementById('updated').textContent = 'Updated ' + new Date(d.updatedAt).toLocaleTimeString();
}

function sanitize(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderEvent(ev) {
  evBuffer.unshift(ev);
  if (evBuffer.length > MAX_EV) evBuffer.length = MAX_EV;
  evBox.innerHTML = evBuffer.map(function(e) {
    var t = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
    var detail = '';
    if (e.data) {
      if (e.data.checkpointId) detail = sanitize(e.data.checkpointId);
      else if (e.data.query) detail = sanitize(e.data.query.slice(0, 80));
      if (e.data.tokenEstimate != null) detail += '  ' + e.data.tokenEstimate + ' tok';
      if (e.data.deduped) detail += '  (deduped)';
      if (e.data.injected != null) detail = 'injected: ' + e.data.injected + (e.data.empty ? ' (empty)' : '');
    }
    return '<div class="ev">' +
      '<span class="ev-time">' + t + '</span>' +
      '<span class="ev-type ev-type-' + sanitize(e.type) + '">' + sanitize(e.type) + '</span>' +
      '<span class="ev-detail">' + detail + '</span></div>';
  }).join('');
}

// Poll snapshot every 2s
function pollSnapshot() {
  fetch('/api/snapshot').then(function(r) { return r.json(); }).then(renderSnapshot).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
}
pollSnapshot();
renderGameScores();
renderAchievements();
setInterval(pollSnapshot, 2000);
setInterval(renderGameScores, 2000);
setInterval(renderAchievements, 2000);

// SSE for events
function connectSSE() {
  var es = new EventSource('/api/events');
  es.onmessage = function(msg) {
    try { renderEvent(JSON.parse(msg.data)); } catch(e) {}
  };
  es.onerror = function() {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}
connectSSE();

`;
}

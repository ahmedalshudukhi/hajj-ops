/**
 * Hajj CAD — Shared topbar component (project codename: Shudukhi CAD).
 * INLINE critical CSS so styling works even when external style.css is stale.
 */
(function() {
  'use strict';

  // ---- Inject critical topbar CSS once ----
  if (!document.getElementById('cad-topbar-styles')) {
    const css = document.createElement('style');
    css.id = 'cad-topbar-styles';
    css.textContent = `
      .cad-topbar { background: linear-gradient(180deg,#131720 0%,#0e131c 100%);
        border-bottom: 1px solid #1f2937; padding: 8px 14px; margin: 0 0 14px 0;
        position: sticky; top: 0; z-index: 50; }
      .cad-topbar-inner { max-width: 1400px; margin: 0 auto;
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .cad-topbar-logo { height: 26px !important; width: auto !important;
        max-height: 26px !important; max-width: 130px !important;
        flex-shrink: 0; object-fit: contain; }
      .cad-topbar-brand { display: flex; flex-direction: column;
        border-left: 1px solid #1f2937; padding-left: 10px; margin-left: 2px;
        flex-shrink: 0; min-width: 0; }
      .cad-topbar-title { font-size: 14px; font-weight: 600; color: #e5e7eb;
        line-height: 1.2; }
      .cad-topbar-subtitle { font-size: 10px; color: #9ca3af;
        text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1px; }
      .cad-topbar-nav { display: flex; gap: 2px; margin-left: auto;
        flex-wrap: wrap; align-items: center; }
      .cad-topbar-nav a { text-decoration: none; color: #9ca3af !important;
        font-size: 12px; padding: 5px 10px; border-radius: 6px;
        transition: all 0.15s; white-space: nowrap; background: transparent; }
      .cad-topbar-nav a:hover { background: #1a2030; color: #e5e7eb !important; }
      .cad-topbar-nav a.active { background: rgba(34,197,94,0.15); color: #4ade80 !important; }
      .cad-topbar-nav a.signout { color: #fca5a5 !important; }
      .cad-topbar-nav a.signout:hover { background: rgba(239,68,68,0.10); }
      @media (max-width: 720px) {
        .cad-topbar-inner { gap: 6px; }
        .cad-topbar-brand { border-left: none; padding-left: 0; margin-left: 0; }
        .cad-topbar-nav { width: 100%; border-top: 1px solid #1f2937;
          padding-top: 6px; overflow-x: auto; gap: 2px; }
        .cad-topbar-nav a { padding: 4px 6px; font-size: 11px; }
        .cad-topbar-title { font-size: 13px; }
      }
      .cad-tile-grid { display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px; max-width: 1400px; margin: 0 auto; padding: 0 16px; }
      .cad-tile { display: block; background: #131720; border: 1px solid #1f2937;
        border-radius: 10px; padding: 14px; text-decoration: none;
        color: inherit; transition: all 0.15s; position: relative; overflow: hidden; }
      .cad-tile::before { content: ''; position: absolute;
        left: 0; top: 0; bottom: 0; width: 3px;
        background: var(--tile-accent, #4ade80); }
      .cad-tile:hover { transform: translateY(-2px);
        border-color: var(--tile-accent, #4ade80);
        box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
      .cad-tile-icon { font-size: 22px; margin-bottom: 6px; }
      .cad-tile-title { font-size: 15px; font-weight: 600; color: #e5e7eb;
        margin-bottom: 3px; }
      .cad-tile-desc { font-size: 12px; color: #9ca3af; line-height: 1.4; }
      .cad-tile-roles { font-size: 10px; color: #6b7280;
        text-transform: uppercase; letter-spacing: 0.05em; margin-top: 8px; }
      @media (max-width: 480px) { .cad-tile-grid { grid-template-columns: 1fr; } }

      /* Shudukhi Labs subtle site-wide footer */
      .shudukhi-labs-footer {
        position: fixed; left: 10px; bottom: 6px;
        font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(203, 213, 225, 0.55);
        pointer-events: none; user-select: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        z-index: 9000;
        text-shadow: 0 1px 2px rgba(0,0,0,0.4);
      }
      @media (max-width: 480px) { .shudukhi-labs-footer { font-size: 8px; left: 6px; bottom: 4px; } }
    `;
    document.head.appendChild(css);

    // Inject the footer once per page.
    if (!document.querySelector('.shudukhi-labs-footer')) {
      const f = document.createElement('footer');
      f.className = 'shudukhi-labs-footer';
      f.setAttribute('aria-hidden', 'true');
      f.textContent = 'Shudukhi Labs';
      if (document.body) document.body.appendChild(f);
      else document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(f); });
    }
  }

  // ---- All pages and which roles can see them ----
  const PAGES = [    { href: 'lobby.html',     label: 'Lobby',      roles: ['leadership','admin','dispatcher','cluster_supervisor','paramedic','gp','sar'] },
    { href: 'command.html',   label: 'Command',    roles: ['leadership','admin','dispatcher'] },
    { href: 'active.html',    label: 'Active',     roles: ['leadership','admin','dispatcher','cluster_supervisor'] },
    { href: 'dispatch.html',  label: 'Dispatch',   roles: ['dispatcher','leadership','admin'] },
    { href: 'sv.html',        label: 'Cluster',    roles: ['cluster_supervisor','leadership','admin'] },
    { href: 'sar.html',       label: 'SAR View',   roles: ['sar','admin','leadership'] },
    { href: 'admin.html',     label: 'Admin',      roles: ['admin'] },
    { href: 'reports.html',   label: 'Reports',    roles: ['leadership','admin','dispatcher','cluster_supervisor'] },
    { href: 'protocols.html', label: 'Protocols',  roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'] },
    { href: 'timeline.html',  label: 'Timeline',   roles: ['cluster_supervisor','dispatcher','leadership','admin'] },
    { href: 'incidents.html', label: 'Incidents',  roles: ['cluster_supervisor','dispatcher','leadership','admin'] },
    { href: 'units.html',     label: 'Units',      roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin','sar'] },
    { href: 'positioning.html', label: 'Positioning', roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin','sar'] },
    { href: 'metro.html',     label: 'Metro',      roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin','sar'] },
    { href: 'pcr.html',       label: 'PCR',        roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'] },
    { href: 'escalation.html', label: 'Escalation', roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin','sar'] },
    { href: 'map.html',       label: 'Map',        roles: ['cluster_supervisor','dispatcher','leadership','admin','sar'] },
    { href: 'code.html',      label: 'Code Blue',  roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'] },
    { href: 'me.html',        label: 'Me',         roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'] },
    { href: 'board.html',     label: 'Board',      roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'] },
    { href: 'diagnostic.html', label: 'Diag',      roles: ['admin'] },
    { href: 'system.html',    label: 'System',     roles: ['admin','leadership'] },
    { href: 'training.html',  label: 'Training',   roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin','sar'] },
    { href: 'schedule.html', label: 'Schedule',   roles: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin','sar'] },
    { href: 'kpi.html',       label: 'KPI',        roles: ['cluster_supervisor','dispatcher','leadership','admin','sar'] },
    { href: 'pulse.html',     label: 'Live Pulse', roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'] }
  ];

  function pagesForRole(role) {
    role = String(role || '').toLowerCase();
    return PAGES.filter(function(p) { return p.roles.indexOf(role) !== -1; });
  }
  function currentPageHref() {
    const path = (location.pathname || '').split('/').pop();
    return path || 'index.html';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"\']/g, function(c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" })[c];
    });
  }

  function render(opts) {
    opts = opts || {};
    const mount = document.getElementById('topbar');
    if (!mount) return;
    const user = (window.HAJJ && HAJJ.getUser && HAJJ.getUser()) || {};
    const role = String(user.role || '').toLowerCase();
    const pages = pagesForRole(role);
    const here = currentPageHref();

    const navLinks = pages.map(function(p) {
      const cls = (p.href === here) ? 'active' : '';
      return '<a href="' + p.href + '" class="' + cls + '">' + p.label + '</a>';
    }).join('') + '<a href="#" class="signout" id="cadSignOut">Sign out</a>';

    const subtitleHtml = opts.subtitle
      ? '<div class="cad-topbar-subtitle">' + escapeHtml(opts.subtitle) + '</div>'
      : '';

    // UI brand: "Hajj CAD" (codename: Shudukhi CAD — kept private)
    mount.innerHTML =
      '<nav class="cad-topbar">' +
        '<div class="cad-topbar-inner">' +
          '<img src="assets/img/hmg_logo.png" alt="HMG" class="cad-topbar-logo" style="height:26px !important;max-height:26px !important;max-width:130px !important;width:auto !important;">' +
          '<div class="cad-topbar-brand">' +
            '<div class="cad-topbar-title">Hajj CAD' + (opts.title ? ' · ' + escapeHtml(opts.title) : '') + '</div>' +
            subtitleHtml +
          '</div>' +
          '<div class="cad-topbar-nav">' + navLinks + '</div>' +
        '</div>' +
      '</nav>';

    const so = document.getElementById('cadSignOut');
    if (so) so.addEventListener('click', function(e) {
      e.preventDefault();
      if (window.HAJJ && HAJJ.logout) HAJJ.logout();
    });
  }

  function renderTileGrid(mountId) {
    const mount = document.getElementById(mountId || 'tileGrid');
    if (!mount) return;
    const user = (window.HAJJ && HAJJ.getUser && HAJJ.getUser()) || {};
    const role = String(user.role || '').toLowerCase();
    const pages = pagesForRole(role);

    const TILE_META = {
      'lobby.html':    { icon:'🏠', desc:'Page selector — you are here', accent:'#4ade80' },
      'active.html':   { icon:'📊', desc:'Live operations — incidents, units, station status, augmentations, PCRs', accent:'#3b82f6' },
      'dispatch.html': { icon:'🚑', desc:'Create incidents, dispatch units, file PCRs, log timeline events', accent:'#ef4444' },
      'sv.html':       { icon:'⚙️', desc:'Cluster supervisor — set station status, request unit reposition', accent:'#a855f7' },
      'sar.html':      { icon:'👁️', desc:'SAR partner — read-only redacted operations summary', accent:'#06b6d4' },
      'admin.html':    { icon:'🔐', desc:'Allowlist, sessions, reposition queue, audit log', accent:'#f59e0b' },
      'me.html':       { icon:'📅', desc:'Your shift schedule and assignments', accent:'#10b981' },
      'diagnostic.html': { icon:'🩺', desc:'Backend health check — ping every endpoint, see what is actually deployed', accent:'#ef4444' }
    };

    mount.innerHTML = pages.map(function(p) {
      const meta = TILE_META[p.href] || { icon:'📄', desc:'', accent:'#6b7280' };
      return '<a href="' + p.href + '" class="cad-tile" style="--tile-accent:' + meta.accent + ';">' +
        '<div class="cad-tile-icon">' + meta.icon + '</div>' +
        '<div class="cad-tile-title">' + escapeHtml(p.label) + '</div>' +
        '<div class="cad-tile-desc">' + escapeHtml(meta.desc) + '</div>' +
        '<div class="cad-tile-roles">' + p.roles.join(' · ') + '</div>' +
      '</a>';
    }).join('');
  }

  window.CADTopbar = {
    render: render,
    renderTileGrid: renderTileGrid,
    pagesForRole: pagesForRole
  };

  // === GLOBAL MCI + BROADCAST OVERLAY (rendered on every authed page) ===
  async function _initOverlay() {
    if (!window.HAJJ || !window.HAJJ.authedCall) return;
    if (document.getElementById('cadGlobalOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'cadGlobalOverlay';
    overlay.innerHTML = `
      <div id="cadMciBanner" style="display:none; background:linear-gradient(90deg,#ef4444,#b91c1c,#ef4444); background-size:200% 100%; color:#fff; padding:8px 18px; text-align:center; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; font-size:13px; animation:cad-mci-stripes 4s linear infinite;"></div>
      <div id="cadDrillBanner" style="display:none; background:linear-gradient(90deg,#a855f7,#7e22ce,#a855f7); background-size:200% 100%; color:#fff; padding:8px 18px; text-align:center; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; font-size:13px; animation:cad-mci-stripes 4s linear infinite;"></div>
      <div id="cadBroadcastBar" style="display:none;"></div>
      <style>
        @keyframes cad-mci-stripes { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }
        #cadBroadcastBar .bcast { padding:8px 14px; display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px; }
        #cadBroadcastBar .bcast.info { background: rgba(59,130,246,0.13); color:#bfdbfe; border-bottom:1px solid rgba(59,130,246,0.3); }
        #cadBroadcastBar .bcast.warn { background: rgba(245,158,11,0.13); color:#fde68a; border-bottom:1px solid rgba(245,158,11,0.3); }
        #cadBroadcastBar .bcast.critical { background: rgba(239,68,68,0.18); color:#fecaca; border-bottom:1px solid rgba(239,68,68,0.4); font-weight:600; }
        #cadBroadcastBar .bcast button { background:rgba(255,255,255,0.15); color:inherit; border:1px solid rgba(255,255,255,0.25); padding:3px 9px; border-radius:5px; font-size:11px; cursor:pointer; }
      </style>
    `;
    document.body.insertBefore(overlay, document.body.firstChild);
    // Online users pill (visible on all pages once first ping returns)
    if (!document.getElementById('cadOnlinePill')) {
      const pill = document.createElement('div');
      pill.id = 'cadOnlinePill';
      pill.title = 'Online users (last 5 min)';
      pill.style.cssText = 'position:fixed; bottom:14px; right:60px; padding:6px 12px; border-radius:999px; background:rgba(34,197,94,0.13); color:#6ee7b7; border:1px solid rgba(34,197,94,0.32); font-size:12px; font-weight:600; cursor:pointer; z-index:200; backdrop-filter:blur(6px); display:none;';
      pill.innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.7);margin-right:6px;vertical-align:middle;"></span><span id="cadOnlinePillNum">—</span>';
      pill.addEventListener('click', async () => {
        if (window.location.pathname === '/command') return; // already there
        // Show simple modal with users
        const r = await HAJJ.authedCall('presence_list', { window: 300 });
        if (!r || !r.ok) return;
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.75); backdrop-filter:blur(4px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        const list = (r.users || []).map(u => {
          const fresh = u.seconds_ago < 90;
          return '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(99,179,237,0.08);font-size:13px;align-items:center;"><span style="width:8px;height:8px;border-radius:50%;background:' + (fresh ? '#22c55e' : '#94a3b8') + ';"></span><span style="flex:1;color:#e7ecf7;font-weight:600;">' + (u.name || u.nid) + '</span><span style="color:#93a4cd;font-size:11px;">' + (u.role || '') + '</span><span style="color:#6b7d9e;font-size:11px;">' + (u.page || '/').replace(/^\//, '') + '</span><span style="color:#6b7d9e;font-size:11px;min-width:36px;text-align:right;">' + (u.seconds_ago < 60 ? 'now' : Math.floor(u.seconds_ago/60) + 'm') + '</span></div>';
        }).join('');
        overlay.innerHTML = '<div style="background:linear-gradient(135deg,#0f1830,#06101e);border:1px solid rgba(99,179,237,0.25);border-radius:14px;padding:24px 28px;max-width:540px;width:100%;max-height:84vh;overflow-y:auto;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;"><h2 style="margin:0;color:#e7ecf7;font-size:18px;">Online Users · ' + r.count + '</h2><span style="cursor:pointer;color:#93a4cd;font-size:18px;" onclick="this.closest(\'div\').parentElement.remove()">×</span></div>' + (list || '<div style="color:#93a4cd;text-align:center;padding:20px 0;">No active users</div>') + '</div>';
        document.body.appendChild(overlay);
      });
      document.body.appendChild(pill);
      // Refresh count every 60s
      async function _refreshOnline() {
        const r = await HAJJ.authedCall('presence_list', { window: 300 });
        if (r && r.ok) {
          const n = r.count || 0;
          if (n > 0) {
            pill.style.display = '';
            document.getElementById('cadOnlinePillNum').textContent = n + ' online';
          } else {
            pill.style.display = 'none';
          }
        }
      }
      _refreshOnline();
      setInterval(_refreshOnline, 60000);
    }

    // === PRESENCE PING (every 60s while page open) ===
    if (!window.cadPresenceTimer) {
      function _ping() {
        try {
          HAJJ.authedCall('presence_ping', {
            page: location.pathname,
            ua: navigator.userAgent.slice(0, 200)
          }).catch(() => {});
        } catch (_) {}
      }
      _ping();
      window.cadPresenceTimer = setInterval(_ping, 60 * 1000);
      // Re-ping on visibility change so we catch resumed tabs
      document.addEventListener('visibilitychange', () => { if (!document.hidden) _ping(); });
    }

    // Help button (bottom-right, opens shortcut overlay)
    if (window.CADShortcuts && !document.getElementById('cadHelpBtn')) {
      const btn = document.createElement('button');
      btn.id = 'cadHelpBtn';
      btn.textContent = '?';
      btn.title = 'Keyboard shortcuts (press ?)';
      btn.style.cssText = 'position:fixed; bottom:14px; right:14px; width:36px; height:36px; border-radius:50%; background:rgba(56,189,248,0.16); color:#cdf1ff; border:1px solid rgba(56,189,248,0.4); font-size:18px; font-weight:700; cursor:pointer; z-index:200; backdrop-filter:blur(6px);';
      btn.addEventListener('click', () => CADShortcuts.showHelp());
      document.body.appendChild(btn);
    }


    async function refresh() {
      try {
        const [mciR, bcR, drR] = await Promise.all([
          HAJJ.authedCall('mci_status', {}),
          HAJJ.authedCall('broadcast_list', { since: Math.floor(Date.now()/1000) - 7200 }),
          HAJJ.authedCall('drill_status', {})
        ]);
        // Drill banner
        const drillEl = document.getElementById('cadDrillBanner');
        if (drillEl) {
          if (drR && drR.ok && drR.drill && drR.drill.active) {
            drillEl.style.display = 'block';
            drillEl.textContent = '🎓 DRILL — ' + (drR.drill.scenario || 'Training') + ' — Started by ' + (drR.drill.started_by_name || '?');
          } else {
            drillEl.style.display = 'none';
          }
        }
        // MCI
        const mciEl = document.getElementById('cadMciBanner');
        if (mciR && mciR.ok && mciR.mci && mciR.mci.active) {
          const m = mciR.mci;
          mciEl.style.display = 'block';
          mciEl.textContent = `⚠ MCI ${(m.level || '').replace('level_','Level ')} ACTIVE — ${m.reason || 'No reason'} — Declared by ${m.declared_by_name || '?'}`;
        } else {
          mciEl.style.display = 'none';
        }
        // Broadcasts (last 2hrs, hide if acked)
        const bcEl = document.getElementById('cadBroadcastBar');
        const list = (bcR && bcR.ok && bcR.broadcasts) ? bcR.broadcasts.filter(b => !b.acked) : [];
        if (list.length === 0) { bcEl.style.display = 'none'; bcEl.innerHTML = ''; return; }
        bcEl.style.display = 'block';
        bcEl.innerHTML = list.slice(0, 3).map(b => {
          const t = new Date((b.ts || 0) * 1000);
          const time = String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
          return `<div class="bcast ${b.level || 'info'}">
            <div><strong>${b.sender_name || 'OCC'}</strong> @ ${time} · ${escapeHtml(b.text || '')}</div>
            <button onclick="window.cadAckBroadcast('${b.id}', this)">Acknowledge</button>
          </div>`;
        }).join('');
      } catch (_) {}
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    window.cadAckBroadcast = async function(id, btn) {
      btn.disabled = true; btn.textContent = '⏳';
      const r = await HAJJ.authedCall('broadcast_ack', { id });
      if (r && r.ok) {
        // Hide just this one
        btn.parentElement.parentElement.style.display = 'none';
      } else {
        btn.disabled = false; btn.textContent = 'Acknowledge';
        alert('Ack failed: ' + ((r && r.error) || 'unknown'));
      }
    };
    refresh();
    setInterval(refresh, 15000);  // 15s refresh on overlay
  }

  // Auto-init when topbar renders
  const _origRender = CADTopbar.render;
  CADTopbar.render = function(opts) {
    _origRender.call(this, opts);
    setTimeout(_initOverlay, 200);  // after topbar paints
  };


})();


// === Global Floating Action Button (Wave 7) ===
// Appears bottom-left on every page (bottom-right reserved for sound alerts).
// Role-aware quick actions.
(function() {
  // Wait for HAJJ.whoami to be available
  function injectFab() {
    if (window.cadFabInjected) return;
    if (!window.HAJJ || !window.HAJJ.whoami) { setTimeout(injectFab, 300); return; }
    window.cadFabInjected = true;
    const fabRoot = document.createElement('div');
    fabRoot.id = 'cadFabRoot';
    fabRoot.innerHTML = `
      <style>
        #cadFabRoot { position:fixed; bottom:20px; left:20px; z-index:9985; }
        #cadFabBtn { width:54px; height:54px; border-radius:50%; background:linear-gradient(135deg,#3b82f6,#a855f7); border:none; cursor:pointer; box-shadow:0 6px 20px rgba(59,130,246,0.45); transition:all 0.2s; position:relative; }
        #cadFabBtn:hover { transform:scale(1.06); }
        #cadFabBtn::before { content:'+'; position:absolute; inset:0; display:grid; place-items:center; color:#fff; font-size:28px; font-weight:300; transition:transform 0.3s; }
        #cadFabBtn.open::before { transform:rotate(135deg); }
        #cadFabMenu { display:none; flex-direction:column; gap:6px; margin-bottom:10px; background:rgba(20,28,50,0.95); backdrop-filter:blur(14px); border:1px solid rgba(99,179,237,0.3); border-radius:14px; padding:10px; min-width:200px; box-shadow:0 12px 40px rgba(0,0,0,0.5); }
        #cadFabMenu.open { display:flex; }
        #cadFabMenu a { padding:10px 14px; color:#cdf1ff; text-decoration:none; border-radius:8px; font-size:13px; font-weight:600; display:flex; align-items:center; gap:10px; transition:background 0.12s; }
        #cadFabMenu a:hover { background:rgba(99,179,237,0.14); }
        #cadFabMenu a .ico { font-size:18px; }
        #cadFabMenu a.danger { color:#fca5a5; }
        #cadFabMenu a.warn { color:#fcd34d; }
        #cadFabMenu a.good { color:#86efac; }
        #cadFabMenu .div { height:1px; background:rgba(99,179,237,0.12); margin:4px 0; }
        @media (max-width:600px) {
          #cadFabRoot { bottom:14px; left:14px; }
          #cadFabBtn { width:50px; height:50px; }
        }
      </style>
      <div id="cadFabMenu"></div>
      <button id="cadFabBtn" title="Quick actions"></button>
    `;
    document.body.appendChild(fabRoot);

    // Populate menu based on role (best-effort: try to get user role)
    async function populate() {
      let role = 'paramedic';
      try { const w = await window.HAJJ.whoami(); if (w && w.user && w.user.role) role = w.user.role; } catch (_) {}
      const items = [];
      // Operational actions (most roles)
      if (['dispatcher','leadership','admin','cluster_supervisor'].includes(role)) {
        items.push({ href: '/dispatch', label: 'New Dispatch', ico: '+', cls: 'warn' });
      }
      if (['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'].includes(role)) {
        items.push({ href: '/code', label: 'Code Blue', ico: 'CB', cls: 'danger' });      }
      items.push({ href: '/pcr', label: 'PCR', ico: 'PC', cls: '' });
      items.push({ divider: true });
      items.push({ href: '/board', label: 'Operations Board', ico: 'BD', cls: '' });
      items.push({ href: '/pulse', label: 'Live Pulse', ico: 'PL', cls: '' });      if (['cluster_supervisor','leadership','admin','dispatcher'].includes(role)) {      }
      items.push({ divider: true });      items.push({ href: '/protocols', label: 'Protocols', ico: 'PR', cls: '' });
      items.push({ href: '/me', label: 'My Page', ico: 'ME', cls: '' });

      const menu = document.getElementById('cadFabMenu');
      menu.innerHTML = items.map(function(it) {
        if (it.divider) return '<div class="div"></div>';
        return '<a href="' + it.href + '" class="' + it.cls + '"><span class="ico">' + it.ico + '</span><span>' + it.label + '</span></a>';
      }).join('');
    }
    populate();

    document.getElementById('cadFabBtn').addEventListener('click', function() {
      const btn = this;
      const menu = document.getElementById('cadFabMenu');
      menu.classList.toggle('open');
      btn.classList.toggle('open');
    });
    document.addEventListener('click', function(e) {
      if (!fabRoot.contains(e.target)) {
        document.getElementById('cadFabMenu').classList.remove('open');
        document.getElementById('cadFabBtn').classList.remove('open');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectFab);
  else injectFab();
})();

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
    `;
    document.head.appendChild(css);
  }

  // ---- All pages and which roles can see them ----
  const PAGES = [
    { href: 'lobby.html',    label: 'Lobby',     roles: ['leadership','admin','dispatcher','cluster_supervisor'] },
    { href: 'active.html',   label: 'Active',    roles: ['leadership','admin','dispatcher','cluster_supervisor'] },
    { href: 'dispatch.html', label: 'Dispatch',  roles: ['dispatcher','leadership','admin'] },
    { href: 'sv.html',       label: 'Cluster',   roles: ['cluster_supervisor','leadership','admin'] },
    { href: 'sar.html',      label: 'SAR view',  roles: ['sar','admin'] },
    { href: 'admin.html',    label: 'Admin',     roles: ['admin'] },
    { href: 'me.html',       label: 'My schedule', roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'] },
    { href: 'diagnostic.html', label: 'Diag',       roles: ['admin'] }
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
})();

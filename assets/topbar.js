/**
 * Shudukhi CAD — Shared topbar component.
 * Usage on any page:
 *   <div id="topbar"></div>
 *   <script src="assets/topbar.js"></script>
 *   <script>CADTopbar.render({ title: 'Active', subtitle: 'live operations' });</script>
 *
 * Uses HAJJ.getUser() to render role-aware nav links.
 */
(function() {
  'use strict';

  // All pages and which roles can see them
  const PAGES = [
    { href: 'lobby.html',    label: 'Lobby',     roles: ['leadership','admin','dispatcher','cluster_supervisor'] },
    { href: 'active.html',   label: 'Active',    roles: ['leadership','admin','dispatcher','cluster_supervisor'] },
    { href: 'dispatch.html', label: 'Dispatch',  roles: ['dispatcher','leadership','admin'] },
    { href: 'sv.html',       label: 'Cluster',   roles: ['cluster_supervisor','leadership','admin'] },
    { href: 'sar.html',      label: 'SAR view',  roles: ['sar','admin'] },
    { href: 'admin.html',    label: 'Admin',     roles: ['admin'] },
    { href: 'me.html',       label: 'My schedule', roles: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'] }
  ];

  function pagesForRole(role) {
    role = String(role || '').toLowerCase();
    return PAGES.filter(p => p.roles.indexOf(role) !== -1);
  }

  function currentPageHref() {
    const path = (location.pathname || '').split('/').pop();
    return path || 'index.html';
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

    mount.innerHTML =
      '<nav class="cad-topbar">' +
        '<div class="cad-topbar-inner">' +
          '<img src="assets/img/hmg_logo.png" alt="HMG" class="cad-topbar-logo">' +
          '<div class="cad-topbar-brand">' +
            '<div class="cad-topbar-title">Shudukhi CAD' + (opts.title ? ' · ' + escapeHtml(opts.title) : '') + '</div>' +
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

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"\']/g, function(c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" })[c];
    });
  }

  // Tile grid renderer for /lobby — shows ALL pages accessible to user
  function renderTileGrid(mountId) {
    const mount = document.getElementById(mountId || 'tileGrid');
    if (!mount) return;
    const user = (window.HAJJ && HAJJ.getUser && HAJJ.getUser()) || {};
    const role = String(user.role || '').toLowerCase();
    const pages = pagesForRole(role);

    const TILE_META = {
      'lobby.html':    { icon:'🏠', desc:'Page selector — you are here', accent:'#4ade80' },
      'active.html':   { icon:'📊', desc:'Live operations dashboard — incidents, units, station status, augmentations, PCRs', accent:'#3b82f6' },
      'dispatch.html': { icon:'🚑', desc:'Create incidents, dispatch units, file PCRs, log timeline events', accent:'#ef4444' },
      'sv.html':       { icon:'⚙️', desc:'Cluster supervisor — set station status, request unit reposition', accent:'#a855f7' },
      'sar.html':      { icon:'👁️', desc:'SAR partner — read-only redacted operations summary', accent:'#06b6d4' },
      'admin.html':    { icon:'🔐', desc:'Allowlist, sessions, reposition queue, audit log', accent:'#f59e0b' },
      'me.html':       { icon:'📅', desc:'Your shift schedule and assignments', accent:'#10b981' }
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

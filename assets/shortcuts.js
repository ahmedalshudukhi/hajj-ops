// shortcuts.js - global keyboard shortcuts + help overlay
// Loaded on every authed page after auth.js + topbar.js
(function() {
  if (window.CADShortcuts) return;
  const NAV_PREFIX_TIMEOUT = 1500;
  const NAV_TARGETS = {
    c: { url: '/command',   label: 'Command Center' },
    d: { url: '/dispatch',  label: 'Dispatch CAD' },
    a: { url: '/active',    label: 'Active Operations' },
    s: { url: '/sv',        label: 'Cluster Supervisor' },
    r: { url: '/reports',   label: 'Reports' },
    p: { url: '/protocols', label: 'Protocols' },
    m: { url: '/me',        label: 'My schedule' },
    l: { url: '/lobby',     label: 'Lobby' },
    o: { url: '/sar',       label: 'SAR view' },
    x: { url: '/admin',     label: 'Admin' }
  };
  const _pageShortcuts = {};
  let _gPressed = false;
  let _gTimer = null;
  const _isTyping = (e) => {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return false;
  };

  function showHelp() {
    if (document.getElementById('cadShortcutHelp')) return;
    const overlay = document.createElement('div');
    overlay.id = 'cadShortcutHelp';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.75); backdrop-filter:blur(4px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const navRows = Object.entries(NAV_TARGETS).map(([k, v]) =>
      `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(99,179,237,0.1);">
        <span style="color:#cbd5e1;">${v.label}</span>
        <span><kbd>g</kbd> <kbd>${k}</kbd></span>
      </div>`
    ).join('');
    const pageRows = Object.entries(_pageShortcuts).map(([k, v]) =>
      `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(99,179,237,0.1);">
        <span style="color:#cbd5e1;">${v.label}</span>
        <kbd>${k}</kbd>
      </div>`
    ).join('');
    overlay.innerHTML = `
      <div style="background:linear-gradient(135deg,#0f1830,#06101e); border:1px solid rgba(99,179,237,0.25); border-radius:14px; padding:24px 28px; max-width:540px; width:100%; max-height:84vh; overflow-y:auto; color:#e7ecf7;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h2 style="margin:0; font-size:18px;">Keyboard Shortcuts</h2>
          <span style="cursor:pointer; color:#93a4cd; font-size:18px;" onclick="this.closest('#cadShortcutHelp').remove()">×</span>
        </div>
        <h3 style="font-size:11px; color:#93a4cd; letter-spacing:0.16em; text-transform:uppercase; margin:14px 0 6px;">Navigation</h3>
        <div style="font-size:13px;">${navRows}</div>
        ${pageRows ? `<h3 style="font-size:11px; color:#93a4cd; letter-spacing:0.16em; text-transform:uppercase; margin:18px 0 6px;">This Page</h3>
        <div style="font-size:13px;">${pageRows}</div>` : ''}
        <h3 style="font-size:11px; color:#93a4cd; letter-spacing:0.16em; text-transform:uppercase; margin:18px 0 6px;">Help</h3>
        <div style="font-size:13px;">
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(99,179,237,0.1);">
            <span style="color:#cbd5e1;">Show this help</span><kbd>?</kbd>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0;">
            <span style="color:#cbd5e1;">Close modal / cancel</span><kbd>Esc</kbd>
          </div>
        </div>
        <style>
          #cadShortcutHelp kbd { display:inline-block; background:rgba(56,189,248,0.16); color:#cdf1ff; border:1px solid rgba(56,189,248,0.35); padding:2px 8px; border-radius:5px; font-size:11px; font-family:ui-monospace,Menlo,monospace; font-weight:600; margin-left:4px; }
        </style>
      </div>
    `;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function navTo(key) {
    const t = NAV_TARGETS[key];
    if (t) location.href = t.url;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const help = document.getElementById('cadShortcutHelp');
      if (help) { help.remove(); e.preventDefault(); return; }
    }
    if (_isTyping(e)) return;
    if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
      showHelp();
      e.preventDefault();
      return;
    }
    if (_gPressed) {
      const k = (e.key || '').toLowerCase();
      _gPressed = false;
      if (_gTimer) { clearTimeout(_gTimer); _gTimer = null; }
      if (NAV_TARGETS[k]) {
        navTo(k);
        e.preventDefault();
        return;
      }
    } else if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      _gPressed = true;
      _gTimer = setTimeout(() => { _gPressed = false; }, NAV_PREFIX_TIMEOUT);
      return;
    }
    const k = (e.key || '').toLowerCase();
    if (_pageShortcuts[k]) {
      const ps = _pageShortcuts[k];
      try { ps.handler(e); } catch (_) {}
      e.preventDefault();
    }
  });

  window.CADShortcuts = {
    register(key, label, handler) {
      _pageShortcuts[key.toLowerCase()] = { label, handler };
    },
    showHelp,
    unregister(key) { delete _pageShortcuts[key.toLowerCase()]; }
  };
})();

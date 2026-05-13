/*
 * docs-editor.js v2 — supports BOTH:
 *   (a) Live Notes panels via <div id="docOverlay" data-slug="..." data-title="...">
 *   (b) Per-card edits via <span data-edit-slug="..." data-edit-title="...">card content</span>
 *
 * The card mode lets you mark any text inside an existing page card as editable.
 * Leadership/admin sees a small ✏ button next to each editable span; clicking opens
 * an inline overlay to edit the markdown content. Content saves to editable_docs.
 */
(function () {
  const SHARED_CSS = `
.dec-pill { position:fixed; bottom:22px; right:22px; z-index:9000; background:rgba(56,189,248,0.22); color:#cdf1ff; border:1px solid rgba(56,189,248,0.45); border-radius:999px; padding:10px 18px; font-weight:600; font-size:13px; cursor:pointer; box-shadow:0 8px 24px rgba(0,0,0,0.4); transition:background 0.15s, transform 0.15s; font-family:'Inter',system-ui,sans-serif; }
.dec-pill:hover { background:rgba(56,189,248,0.34); transform:translateY(-2px); }
.dec-card-edit { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; margin-left:6px; background:rgba(56,189,248,0.15); color:#67e8f9; border:1px solid rgba(56,189,248,0.3); border-radius:50%; cursor:pointer; font-size:11px; vertical-align:middle; line-height:1; transition:background 0.12s; }
.dec-card-edit:hover { background:rgba(56,189,248,0.35); }
.dec-card-edit.editing { background:rgba(34,197,94,0.25); color:#86efac; border-color:rgba(34,197,94,0.4); }
.dec-card-wrap { position:relative; display:inline; }
.dec-edited { background:linear-gradient(transparent 60%, rgba(252,211,77,0.20) 60%); padding:0 2px; border-radius:2px; }
.dec-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.78); z-index:9100; display:none; align-items:center; justify-content:center; backdrop-filter:blur(6px); padding:20px; }
.dec-overlay.visible { display:flex; }
.dec-modal { background:#0e1530; color:#e7ecf7; width:min(940px,100%); max-height:88vh; border:1px solid rgba(99,179,237,0.22); border-radius:14px; overflow:hidden; display:flex; flex-direction:column; font-family:'Inter',system-ui,sans-serif; }
.dec-modal h3 { margin:0; padding:14px 22px; font-size:15px; color:#cdf1ff; border-bottom:1px solid rgba(99,179,237,0.16); display:flex; justify-content:space-between; align-items:center; }
.dec-modal h3 .meta { font-size:11px; color:#93a4cd; font-weight:400; }
.dec-modal textarea { flex:1; min-height:280px; padding:14px 22px; border:0; background:#0a0e1a; color:#e7ecf7; font-family:ui-monospace,Menlo,monospace; font-size:13px; line-height:1.55; outline:none; resize:vertical; }
.dec-actions { display:flex; gap:10px; justify-content:flex-end; align-items:center; padding:12px 22px; border-top:1px solid rgba(99,179,237,0.16); background:rgba(15,23,42,0.5); }
.dec-actions .hint { flex:1; color:#6b7d9e; font-size:11px; }
.dec-btn { padding:9px 18px; border-radius:7px; cursor:pointer; font-weight:600; font-size:13px; border:1px solid rgba(99,179,237,0.3); background:rgba(15,23,42,0.7); color:#cdf1ff; }
.dec-btn:hover { background:rgba(56,189,248,0.18); }
.dec-btn.primary { background:rgba(34,197,94,0.22); color:#86efac; border-color:rgba(34,197,94,0.45); }
.dec-btn.primary:hover { background:rgba(34,197,94,0.34); }
.dec-btn.danger { background:rgba(239,68,68,0.18); color:#fca5a5; border-color:rgba(239,68,68,0.35); }
.dec-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); padding:10px 20px; border-radius:8px; font-size:13px; font-weight:600; z-index:9200; opacity:0; transition:opacity 0.3s; background:rgba(34,197,94,0.22); color:#86efac; border:1px solid rgba(34,197,94,0.45); }
.dec-toast.visible { opacity:1; }
.dec-toast.error { background:rgba(239,68,68,0.22); color:#fca5a5; border-color:rgba(239,68,68,0.45); }
.dec-content { padding:14px 22px; line-height:1.65; color:#cbd5e1; font-size:14px; }
.dec-content h2, .dec-content h3 { color:#cdf1ff; margin-top:14px; margin-bottom:8px; }
.dec-content h2 { font-size:17px; } .dec-content h3 { font-size:14px; letter-spacing:0.03em; }
.dec-content ul, .dec-content ol { margin:6px 0 12px; padding-left:24px; }
.dec-content li { margin:4px 0; }
.dec-content code { background:rgba(15,23,42,0.7); padding:1px 6px; border-radius:4px; color:#fde68a; font-size:12px; }
.dec-content blockquote { border-left:3px solid rgba(56,189,248,0.4); padding-left:12px; color:#93a4cd; margin:12px 0; }
.dec-byline { font-size:11px; color:#6b7d9e; padding:8px 22px; border-top:1px dashed rgba(99,179,237,0.14); font-style:italic; }
`;

  function injectStyles() {
    if (document.getElementById('dec-styles')) return;
    const s = document.createElement('style');
    s.id = 'dec-styles'; s.textContent = SHARED_CSS;
    document.head.appendChild(s);
  }

  function md2html(md) {
    if (!md) return '';
    let s = md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h2>$1</h2>')
      .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>');
    s = s.replace(/(^|\n)((?:[-*] .+\n?)+)/g, function (m, pre, block) {
      const items = block.trim().split('\n').map(l => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('');
      return pre + '<ul>' + items + '</ul>';
    });
    s = s.split(/\n{2,}/).map(p => {
      if (/^<(h\d|ul|ol|blockquote|p)/.test(p)) return p;
      return p.trim() ? '<p>' + p.replace(/\n/g, '<br>') + '</p>' : '';
    }).join('\n');
    return s;
  }

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.className = 'dec-toast' + (isErr ? ' error' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 350); }, 2200);
  }

  // ─── Shared overlay editor ─────────────────────────────────────────────
  let _overlay = null;
  function buildOverlay() {
    if (_overlay) return _overlay;
    _overlay = document.createElement('div');
    _overlay.className = 'dec-overlay';
    _overlay.innerHTML = `
      <div class="dec-modal">
        <h3><span id="decModalTitle">Edit</span><span class="meta" id="decModalMeta"></span></h3>
        <textarea id="decTextarea" spellcheck="false"></textarea>
        <div class="dec-actions">
          <span class="hint">Markdown: # headings · **bold** · *italic* · - bullet · &gt; quote · \`code\`</span>
          <button class="dec-btn" id="decCancel">Cancel</button>
          <button class="dec-btn primary" id="decSave">Save</button>
        </div>
      </div>`;
    document.body.appendChild(_overlay);
    _overlay.addEventListener('click', e => { if (e.target === _overlay) closeOverlay(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && _overlay.classList.contains('visible')) closeOverlay(); });
    return _overlay;
  }
  function closeOverlay() { if (_overlay) _overlay.classList.remove('visible'); }

  async function openEdit(slug, title, currentContent, version, onSave) {
    buildOverlay();
    _overlay.querySelector('#decModalTitle').textContent = 'Edit · ' + title;
    _overlay.querySelector('#decModalMeta').textContent = 'v' + (version || 0);
    const ta = _overlay.querySelector('#decTextarea');
    ta.value = currentContent || '';
    _overlay.classList.add('visible');
    setTimeout(() => ta.focus(), 100);
    _overlay.querySelector('#decCancel').onclick = closeOverlay;
    _overlay.querySelector('#decSave').onclick = async () => {
      const newContent = ta.value;
      const r = await HAJJ.authedCall('docs_save', { slug, title, content: newContent });
      if (r && r.ok) {
        closeOverlay();
        toast('Saved · v' + r.version);
        if (onSave) onSave(newContent, r.version, r.updated_at);
      } else {
        toast('Save failed: ' + ((r && r.error) || 'unknown'), true);
      }
    };
  }

  // ─── (a) Live Notes panel mode ─────────────────────────────────────────
  async function initNotesPanel() {
    const host = document.getElementById('docOverlay');
    if (!host) return;
    const slug = host.dataset.slug;
    const title = host.dataset.title || slug;
    if (!slug) return;

    const r = await HAJJ.authedCall('docs_get', { slug });
    let content = (r && r.ok && r.content) || host.dataset.fallback || '';
    let version = (r && r.ok && r.version) || 0;
    let lastEdit = (r && r.ok && r.updated_at) ? new Date(r.updated_at * 1000).toLocaleString('en-GB') : null;
    let lastBy = (r && r.ok && r.updated_by_name) || null;

    function render() {
      let html = '<div class="dec-content">' + md2html(content) + '</div>';
      if (lastEdit) html += '<div class="dec-byline">Last edited ' + lastEdit + (lastBy ? ' by ' + lastBy : '') + ' · v' + version + '</div>';
      host.innerHTML = html;
    }
    render();

    const user = HAJJ.getUser();
    const canEdit = user && (user.role === 'admin' || user.role === 'leadership');
    if (!canEdit) return;

    const btn = document.createElement('button');
    btn.className = 'dec-pill';
    btn.textContent = '✏ Edit ' + title;
    document.body.appendChild(btn);
    btn.addEventListener('click', () => {
      openEdit(slug, title, content, version, (newContent, newVersion, newUpdatedAt) => {
        content = newContent;
        version = newVersion;
        lastEdit = new Date((newUpdatedAt || Date.now() / 1000) * 1000).toLocaleString('en-GB');
        lastBy = (user && user.name) || lastBy;
        render();
      });
    });
  }

  // ─── (b) Per-card editable spans mode ──────────────────────────────────
  async function initCardEdits() {
    const cards = Array.from(document.querySelectorAll('[data-edit-slug]'));
    if (!cards.length) return;

    const user = HAJJ.getUser();
    const canEdit = user && (user.role === 'admin' || user.role === 'leadership');

    // Bulk-load any saved overrides for this page. Group by common prefix.
    // We assume slugs follow "page:section:id" pattern.
    const prefixes = new Set();
    cards.forEach(c => {
      const slug = c.dataset.editSlug;
      const colon = slug.indexOf(':');
      if (colon > 0) prefixes.add(slug.slice(0, colon + 1));
    });
    const overrides = {};
    for (const p of prefixes) {
      try {
        const r = await HAJJ.authedCall('cards_get_bulk', { prefix: p });
        if (r && r.ok && r.cards) Object.assign(overrides, r.cards);
      } catch (_) {}
    }

    cards.forEach(card => {
      const slug = card.dataset.editSlug;
      const title = card.dataset.editTitle || slug;

      // If we have a saved override, replace card content
      let originalHtml = card.innerHTML;
      let currentContent = card.dataset.editFallback || card.textContent.trim();
      const ov = overrides[slug];
      if (ov && ov.content) {
        card.innerHTML = md2html(ov.content);
        card.classList.add('dec-edited');
        currentContent = ov.content;
      }
      let version = ov ? ov.version : 0;

      if (!canEdit) return;

      // Add an inline ✏ button next to the card
      const btn = document.createElement('button');
      btn.className = 'dec-card-edit';
      btn.title = 'Edit "' + title + '"';
      btn.textContent = '✏';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openEdit(slug, title, currentContent, version, (newContent, newVersion, newUpdatedAt) => {
          currentContent = newContent;
          version = newVersion;
          card.innerHTML = md2html(newContent);
          card.classList.add('dec-edited');
        });
      });
      // Place button after the card
      if (card.parentNode) card.parentNode.insertBefore(btn, card.nextSibling);
    });
  }

  async function init() {
    injectStyles();
    await Promise.all([initNotesPanel(), initCardEdits()]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

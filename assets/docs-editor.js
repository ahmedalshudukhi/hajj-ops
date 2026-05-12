/*
 * docs-editor.js — drop-in inline editor for editable_docs (protocols/runbook/training).
 *
 * Usage in any page:
 *   <div id="docOverlay" data-slug="protocols" data-title="Field Protocols"></div>
 *   <script src="assets/docs-editor.js?v=0.2.41"></script>
 *
 * The script adds a floating Edit button (visible to leadership/admin only) that
 * opens a markdown textarea overlay, with Save / Cancel / Last-edited byline.
 *
 * Reads via docs_get; saves via docs_save (role-gated server-side).
 * If a user has no docs_save permission, the Edit button stays hidden.
 */
(function () {
  const PILL_CSS = `
.dec-pill {
  position: fixed; bottom: 22px; right: 22px; z-index: 9000;
  background: rgba(56,189,248,0.22); color: #cdf1ff;
  border: 1px solid rgba(56,189,248,0.45);
  border-radius: 999px; padding: 10px 18px;
  font-weight: 600; font-size: 13px; cursor: pointer;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  transition: background 0.15s, transform 0.15s;
  font-family: 'Inter', system-ui, sans-serif;
}
.dec-pill:hover { background: rgba(56,189,248,0.34); transform: translateY(-2px); }
.dec-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.78);
  z-index: 9100; display: none; align-items: center; justify-content: center;
  backdrop-filter: blur(6px);
}
.dec-overlay.visible { display: flex; }
.dec-modal {
  background: #0e1530; color: #e7ecf7; width: min(940px, 92vw); max-height: 88vh;
  border: 1px solid rgba(99,179,237,0.22); border-radius: 14px; overflow: hidden;
  display: flex; flex-direction: column;
  font-family: 'Inter', system-ui, sans-serif;
}
.dec-modal h3 { margin: 0; padding: 16px 22px; font-size: 15px; color: #cdf1ff;
  border-bottom: 1px solid rgba(99,179,237,0.16); display: flex; justify-content: space-between; align-items: center; }
.dec-modal h3 .meta { font-size: 11px; color: #93a4cd; font-weight: 400; letter-spacing: 0.03em; }
.dec-modal textarea {
  flex: 1; min-height: 380px; padding: 16px 22px; border: 0; background: #0a0e1a;
  color: #e7ecf7; font-family: ui-monospace, Menlo, monospace; font-size: 13px;
  line-height: 1.55; outline: none; resize: vertical;
}
.dec-actions {
  display: flex; gap: 10px; justify-content: flex-end; align-items: center;
  padding: 12px 22px; border-top: 1px solid rgba(99,179,237,0.16);
  background: rgba(15,23,42,0.5);
}
.dec-actions .hint { flex: 1; color: #6b7d9e; font-size: 11px; }
.dec-btn {
  padding: 9px 18px; border-radius: 7px; cursor: pointer; font-weight: 600;
  font-size: 13px; border: 1px solid rgba(99,179,237,0.3);
  background: rgba(15,23,42,0.7); color: #cdf1ff;
}
.dec-btn:hover { background: rgba(56,189,248,0.18); }
.dec-btn.primary { background: rgba(34,197,94,0.22); color: #86efac; border-color: rgba(34,197,94,0.45); }
.dec-btn.primary:hover { background: rgba(34,197,94,0.34); }
.dec-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600;
  z-index: 9200; opacity: 0; transition: opacity 0.3s;
  background: rgba(34,197,94,0.22); color: #86efac; border: 1px solid rgba(34,197,94,0.45);
}
.dec-toast.visible { opacity: 1; }
.dec-toast.error { background: rgba(239,68,68,0.22); color: #fca5a5; border-color: rgba(239,68,68,0.45); }
.dec-content { padding: 18px 22px; line-height: 1.65; color: #cbd5e1; font-size: 14px; }
.dec-content h2, .dec-content h3 { color: #cdf1ff; margin-top: 18px; margin-bottom: 8px; }
.dec-content h2 { font-size: 17px; }
.dec-content h3 { font-size: 14px; letter-spacing: 0.03em; }
.dec-content ul, .dec-content ol { margin: 6px 0 12px; padding-left: 24px; }
.dec-content li { margin: 4px 0; }
.dec-content code { background: rgba(15,23,42,0.7); padding: 1px 6px; border-radius: 4px; color: #fde68a; font-size: 12px; }
.dec-content blockquote { border-left: 3px solid rgba(56,189,248,0.4); padding-left: 12px; color: #93a4cd; margin: 12px 0; }
.dec-byline { font-size: 11px; color: #6b7d9e; padding: 8px 22px; border-top: 1px dashed rgba(99,179,237,0.14); font-style: italic; }
`;

  function injectStyles() {
    if (document.getElementById('dec-styles')) return;
    const s = document.createElement('style');
    s.id = 'dec-styles'; s.textContent = PILL_CSS;
    document.head.appendChild(s);
  }

  // tiny markdown → html
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
    // lists
    s = s.replace(/(^|\n)((?:[-*] .+\n?)+)/g, function (m, pre, block) {
      const items = block.trim().split('\n').map(l => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('');
      return pre + '<ul>' + items + '</ul>';
    });
    // paragraphs
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

  async function init() {
    const host = document.getElementById('docOverlay');
    if (!host) return;
    const slug = host.dataset.slug;
    const title = host.dataset.title || slug;
    if (!slug) { console.warn('[docs-editor] missing data-slug'); return; }

    injectStyles();

    // Load doc
    const r = await HAJJ.authedCall('docs_get', { slug });
    let content = (r && r.ok && r.content) || host.dataset.fallback || '';
    let lastEdit = (r && r.ok && r.updated_at)
      ? new Date(r.updated_at * 1000).toLocaleString('en-GB')
      : null;
    let lastBy = (r && r.ok && r.updated_by_name) || null;
    let version = (r && r.ok && r.version) || 0;

    // Render content
    function render() {
      let html = '<div class="dec-content">' + md2html(content) + '</div>';
      if (lastEdit) {
        html += '<div class="dec-byline">Last edited ' + lastEdit
              + (lastBy ? ' by ' + lastBy : '') + ' · v' + version + '</div>';
      }
      host.innerHTML = html;
    }
    render();

    // Edit button — try to show it; will be hidden if user lacks role
    const user = HAJJ.getUser();
    const canEdit = user && (user.role === 'admin' || user.role === 'leadership');
    if (!canEdit) return;

    const btn = document.createElement('button');
    btn.className = 'dec-pill';
    btn.textContent = '✏ Edit ' + title;
    document.body.appendChild(btn);

    const overlay = document.createElement('div');
    overlay.className = 'dec-overlay';
    overlay.innerHTML = `
      <div class="dec-modal">
        <h3>
          <span>Edit · ${title}</span>
          <span class="meta" id="decVersion">v${version}</span>
        </h3>
        <textarea id="decTextarea" spellcheck="false"></textarea>
        <div class="dec-actions">
          <span class="hint">Markdown: # headings, **bold**, *italic*, - bullets, &gt; quote, \`code\`</span>
          <button class="dec-btn" id="decCancel">Cancel</button>
          <button class="dec-btn primary" id="decSave">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const ta = overlay.querySelector('#decTextarea');
    btn.addEventListener('click', () => {
      ta.value = content;
      overlay.classList.add('visible');
      ta.focus();
    });
    overlay.querySelector('#decCancel').addEventListener('click', () => {
      overlay.classList.remove('visible');
    });
    overlay.querySelector('#decSave').addEventListener('click', async () => {
      const newContent = ta.value;
      const r2 = await HAJJ.authedCall('docs_save', { slug, title, content: newContent });
      if (r2 && r2.ok) {
        content = newContent;
        version = r2.version || (version + 1);
        lastEdit = new Date((r2.updated_at || Date.now() / 1000) * 1000).toLocaleString('en-GB');
        lastBy = (user && user.name) || lastBy;
        overlay.querySelector('#decVersion').textContent = 'v' + version;
        overlay.classList.remove('visible');
        render();
        toast('Saved · v' + version);
      } else {
        toast('Save failed: ' + ((r2 && r2.error) || 'unknown'), true);
      }
    });

    // Esc closes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) {
        overlay.classList.remove('visible');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

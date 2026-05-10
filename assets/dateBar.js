// Shared Hajj date controls — single date / range / Hajj day quick-pick.
// Used by dispatch.html and active.html.

(function () {
  // 4 DH = 30 May 2026 (operations start). DH labels run from D-1 (drills setup) to DH 14.
  const HAJJ_DAYS = [
    { day: 0,  label: 'D-1',   date: '2026-05-26', desc: 'Pre-drills' },
    { day: 1,  label: 'DH 1',  date: '2026-05-27', desc: 'Drills' },
    { day: 2,  label: 'DH 2',  date: '2026-05-28', desc: '' },
    { day: 3,  label: 'DH 3',  date: '2026-05-29', desc: '' },
    { day: 4,  label: 'DH 4',  date: '2026-05-30', desc: 'Ops start' },
    { day: 5,  label: 'DH 5',  date: '2026-05-31', desc: '' },
    { day: 6,  label: 'DH 6',  date: '2026-06-01', desc: 'Arafat' },
    { day: 7,  label: 'DH 7',  date: '2026-06-02', desc: '' },
    { day: 8,  label: 'DH 8',  date: '2026-06-03', desc: '' },
    { day: 9,  label: 'DH 9',  date: '2026-06-04', desc: 'Nafra' },
    { day: 10, label: 'DH 10', date: '2026-06-05', desc: '' },
    { day: 11, label: 'DH 11', date: '2026-06-06', desc: '' },
    { day: 12, label: 'DH 12', date: '2026-06-07', desc: '' },
    { day: 13, label: 'DH 13', date: '2026-06-08', desc: '' },
    { day: 14, label: 'DH 14', date: '2026-06-09', desc: 'Ops end' }
  ];

  // Build markup; appends to anchorEl. Returns API: { getScope(), setDate(d), setRange(s,e), refresh() }.
  function build(anchorEl, opts) {
    opts = opts || {};
    const onChange = opts.onChange || function () {};
    const inline = opts.inline !== false;  // default to inline-flex layout
    const todayISO = new Date().toISOString().slice(0, 10);
    const minDate = '2026-05-25';
    const maxDate = '2026-06-12';

    anchorEl.innerHTML = `
      <div style="display:${inline ? 'flex' : 'block'}; align-items:center; gap:6px; flex-wrap:wrap; font-size:13px; font-weight:500;">
        <button type="button" data-act="prev" title="Previous day" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#e5e7eb; padding:4px 10px; border-radius:6px; cursor:pointer; font-size:14px; line-height:1;">‹</button>
        <input type="date" data-act="start" min="${minDate}" max="${maxDate}" value="${todayISO}" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#e5e7eb; padding:4px 8px; border-radius:6px; font-size:13px; color-scheme:dark;">
        <span data-act="rangeArrow" hidden style="color:#9ca3af;">→</span>
        <input type="date" data-act="end" min="${minDate}" max="${maxDate}" value="${todayISO}" hidden style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#e5e7eb; padding:4px 8px; border-radius:6px; font-size:13px; color-scheme:dark;">
        <button type="button" data-act="next" title="Next day" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#e5e7eb; padding:4px 10px; border-radius:6px; cursor:pointer; font-size:14px; line-height:1;">›</button>
        <button type="button" data-act="today" title="Today" style="background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.4); color:#93c5fd; padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600;">TODAY</button>
        <select data-act="dh" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#e5e7eb; padding:4px 8px; border-radius:6px; font-size:12px; color-scheme:dark;">
          <option value="">Hajj day…</option>
          ${HAJJ_DAYS.map(d => `<option value="${d.date}">${d.label}${d.desc ? ' · ' + d.desc : ''} (${d.date.slice(5)})</option>`).join('')}
          <option value="ALL_SEASON">— All season —</option>
        </select>
        <button type="button" data-act="rangeToggle" title="Toggle range mode" style="background:rgba(245,158,11,0.10); border:1px solid rgba(245,158,11,0.3); color:#fcd34d; padding:4px 9px; border-radius:6px; cursor:pointer; font-size:12px;">↔ Range</button>
        <span data-act="status" style="color:#9ca3af; font-size:11px; margin-left:6px;"></span>
      </div>
    `;

    const startEl   = anchorEl.querySelector('[data-act="start"]');
    const endEl     = anchorEl.querySelector('[data-act="end"]');
    const arrowEl   = anchorEl.querySelector('[data-act="rangeArrow"]');
    const prevBtn   = anchorEl.querySelector('[data-act="prev"]');
    const nextBtn   = anchorEl.querySelector('[data-act="next"]');
    const todayBtn  = anchorEl.querySelector('[data-act="today"]');
    const dhSel     = anchorEl.querySelector('[data-act="dh"]');
    const rangeBtn  = anchorEl.querySelector('[data-act="rangeToggle"]');
    const statusEl  = anchorEl.querySelector('[data-act="status"]');

    let rangeMode = false;

    function fmtScope() {
      const s = startEl.value, e = rangeMode ? endEl.value : startEl.value;
      const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
      if (s === e) {
        const dh = HAJJ_DAYS.find(d => d.date === s);
        return dh ? dh.label + (dh.desc ? ' · ' + dh.desc : '') : s;
      }
      return `${s} → ${e} · ${days} day${days === 1 ? '' : 's'}`;
    }

    function emit() {
      statusEl.textContent = fmtScope();
      const scope = api.getScope();
      onChange(scope);
    }

    prevBtn.addEventListener('click', () => {
      const d = new Date(startEl.value); d.setUTCDate(d.getUTCDate() - 1);
      startEl.value = d.toISOString().slice(0, 10);
      if (!rangeMode) endEl.value = startEl.value;
      emit();
    });
    nextBtn.addEventListener('click', () => {
      const d = new Date(startEl.value); d.setUTCDate(d.getUTCDate() + 1);
      startEl.value = d.toISOString().slice(0, 10);
      if (!rangeMode) endEl.value = startEl.value;
      emit();
    });
    todayBtn.addEventListener('click', () => {
      startEl.value = todayISO; endEl.value = todayISO;
      if (rangeMode) { rangeMode = false; arrowEl.hidden = true; endEl.hidden = true; rangeBtn.textContent = '↔ Range'; }
      emit();
    });
    startEl.addEventListener('change', () => {
      if (!rangeMode) endEl.value = startEl.value;
      emit();
    });
    endEl.addEventListener('change', emit);
    dhSel.addEventListener('change', () => {
      const v = dhSel.value;
      if (!v) return;
      if (v === 'ALL_SEASON') {
        rangeMode = true; arrowEl.hidden = false; endEl.hidden = false;
        rangeBtn.textContent = '✓ Range';
        startEl.value = '2026-05-27';  // DH 1
        endEl.value = '2026-06-09';    // DH 14
      } else {
        if (rangeMode) {
          // In range mode: setting DH sets START. User can pick end DH next.
          startEl.value = v;
          if (new Date(endEl.value) < new Date(v)) endEl.value = v;
        } else {
          startEl.value = v; endEl.value = v;
        }
      }
      dhSel.value = '';  // reset for next selection
      emit();
    });
    rangeBtn.addEventListener('click', () => {
      rangeMode = !rangeMode;
      arrowEl.hidden = !rangeMode; endEl.hidden = !rangeMode;
      rangeBtn.textContent = rangeMode ? '✓ Range' : '↔ Range';
      if (!rangeMode) endEl.value = startEl.value;
      emit();
    });

    const api = {
      getScope: function() {
        const s = startEl.value;
        const e = rangeMode ? endEl.value : startEl.value;
        const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
        return { start_date: s, end_date: e, days, range: rangeMode, single: !rangeMode && s === e };
      },
      setDate: function(d) { startEl.value = d; if (!rangeMode) endEl.value = d; emit(); },
      setRange: function(s, e) {
        rangeMode = true; arrowEl.hidden = false; endEl.hidden = false; rangeBtn.textContent = '✓ Range';
        startEl.value = s; endEl.value = e; emit();
      },
      isRange: function() { return rangeMode; },
      _refresh: function() { emit(); }
    };
    statusEl.textContent = fmtScope();
    return api;
  }

  window.HAJJ_DATE_BAR = { build: build, days: HAJJ_DAYS };
})();

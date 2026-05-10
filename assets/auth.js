/**
 * Hajj 2026 — shared auth + API module.
 * Loaded by every authenticated page after config.js.
 *
 * Exposes window.HAJJ with:
 *   call(action, params)        public API call
 *   authedCall(action, params)  protected API call (auto-redirects on 401)
 *   login(nid, last4)           authenticate, stores session
 *   logout()                    clear session, redirect to entry
 *   getToken() / getUser()      read session
 *   requireAuth()               redirect to entry if no session
 *   requireRole(allowed[])      redirect to me.html if role not allowed
 *   landingFor(role)            return appropriate page for role
 *   pcrCall(method, params)     call DCH's PCR/Q-PCR script
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'hajj_token';
  const USER_KEY = 'hajj_user';
  const EXPIRES_KEY = 'hajj_expires';
  const ENTRY = 'entry.html';

  function backend() {
    if (!window.BACKEND_URL || window.BACKEND_URL.indexOf('PASTE_') !== -1) {
      console.error('BACKEND_URL not set — edit assets/config.js');
      return null;
    }
    return window.BACKEND_URL;
  }

  function pcrEndpoint() {
    if (!window.PCR_URL || window.PCR_URL.indexOf('PASTE_') !== -1) return null;
    return window.PCR_URL;
  }

  async function call(action, params) {
    const url = backend();
    if (!url) return { ok: false, error: 'backend_not_configured' };
    const u = new URL(url);
    u.searchParams.set('action', action);
    if (params) {
      for (const k in params) {
        if (params[k] !== undefined && params[k] !== null) {
          u.searchParams.set(k, params[k]);
        }
      }
    }
    try {
      const res = await fetch(u.toString(), { method: 'GET', redirect: 'follow' });
      const text = await res.text();
      try { return JSON.parse(text); }
      catch (_) { return { ok: false, error: 'non_json_response', raw: text.slice(0, 200) }; }
    } catch (err) {
      return { ok: false, error: 'network', message: String(err) };
    }
  }

  /**
   * Call DCH's PCR/Q-PCR script.
   * GET endpoints: summary | encounters | stations | health
   * POST: body is the Q-PCR payload (JSON).
   */
  async function pcrCall(method, params) {
    const url = pcrEndpoint();
    if (!url) return { ok: false, error: 'pcr_not_configured' };
    method = String(method || 'GET').toUpperCase();
    try {
      if (method === 'GET') {
        const u = new URL(url);
        if (params) {
          for (const k in params) {
            if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
          }
        }
        const res = await fetch(u.toString(), { method: 'GET', redirect: 'follow' });
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (_) { return { ok: false, error: 'non_json_response', raw: text.slice(0, 200) }; }
      } else {
        // POST — Apps Script web apps accept text/plain to avoid CORS preflight
        const res = await fetch(url, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(params || {})
        });
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (_) { return { ok: false, error: 'non_json_response', raw: text.slice(0, 200) }; }
      }
    } catch (err) {
      return { ok: false, error: 'network', message: String(err) };
    }
  }

  function getToken() { return sessionStorage.getItem(TOKEN_KEY); }

  function getUser() {
    const raw = sessionStorage.getItem(USER_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  function getExpires() {
    const raw = sessionStorage.getItem(EXPIRES_KEY);
    return raw ? new Date(raw) : null;
  }

  function setSession(token, user, expires) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    if (expires) sessionStorage.setItem(EXPIRES_KEY, expires);
  }

  function clearSession() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(EXPIRES_KEY);
  }

  function isExpired() {
    const exp = getExpires();
    return exp ? exp < new Date() : false;
  }

  // === D1 login (fast path, ~300ms) + GAS shadow login (background, ~5s) ===
  // D1 token stored as hajj_token (primary). GAS token stored as hajj_gas_token (legacy).
  // authedCall reads hajj_gas_token for ?action= calls until each endpoint is migrated.
  const GAS_TOKEN_KEY = 'hajj_gas_token';

  async function login(nid, last4) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // Parallel fetch BOTH D1 (fast) and GAS (slow). We MUST await both before
    // returning, otherwise browser kills the GAS fetch on page navigation.
    // Login takes max(D1, GAS) — same as before D1 cutover, but now ALL endpoints
    // will work post-login (D1 token for migrated, GAS token for legacy).
    const ua = navigator.userAgent.slice(0, 80);

    const d1Promise = (async () => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nid: String(nid), last4_mobile: String(last4) })
        });
        return await res.json();
      } catch (e) {
        return { ok: false, error: 'network', message: String(e) };
      }
    })();

    const gasPromise = (async () => {
      try {
        return await call('auth', { nid: nid, last4: last4, ua: ua });
      } catch (e) {
        return { ok: false, error: 'network', message: String(e) };
      }
    })();

    const [d1, gas] = await Promise.all([d1Promise, gasPromise]);
    const ms = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);

    if (d1 && d1.ok && d1.token) {
      const expIso = d1.expires_at ? new Date(d1.expires_at * 1000).toISOString() : null;
      setSession(d1.token, d1.user, expIso);
    }
    if (gas && gas.ok && gas.token) {
      sessionStorage.setItem(GAS_TOKEN_KEY, gas.token);
    }

    if (typeof console !== 'undefined') {
      console.log('%c[CAD] login %c' + ms + 'ms %cD1=' + (d1 && d1.ok ? 'ok' : 'fail') + ' GAS=' + (gas && gas.ok ? 'ok' : 'fail'),
        'color:#3b82f6', 'color:#9ca3af', 'color:#22c55e');
    }

    // Return D1 result as primary (it has the user object the frontend expects)
    // If D1 failed but GAS succeeded, fall back to GAS shape (for emergency continuity)
    if (d1 && d1.ok) return d1;
    if (gas && gas.ok) {
      // Fallback path — D1 had a problem but GAS worked. Should never happen if D1 is healthy.
      console.warn('[CAD] D1 login failed but GAS ok — using GAS-only mode');
      setSession(gas.token, gas.user, gas.expires);
      return gas;
    }
    return d1 || gas || { ok: false, error: 'login_failed' };
  }

  async function logout() {
    const d1Token = getToken();
    const gasToken = sessionStorage.getItem(GAS_TOKEN_KEY);
    if (d1Token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + d1Token }
        });
      } catch (_) {}
    }
    if (gasToken) {
      try { await call('logout', { token: gasToken }); } catch (_) {}
    }
    clearSession();
    sessionStorage.removeItem(GAS_TOKEN_KEY);
    window.location.href = ENTRY;
  }

  // Migrated D1 actions — served from Worker via /api/v2/exec (single router)
  // Each action gets 200-500ms instead of 3-60s on Apps Script.
  // Adding a new action = one entry here + one handler in worker.
  const EXEC_PATH = '/api/v2/exec';
  const MIGRATED_ACTIONS = {
    // Auth (uses dedicated path, fastest)
    whoami:                 { method: 'GET', path: '/api/auth/whoami' },
    // All others go through unified /api/v2/exec router
    roster:                 { method: 'GET', exec: true },
    admin_allowlist_view:   { method: 'GET', exec: true },
    admin_sessions_view:    { method: 'GET', exec: true },
    admin_audit_list:       { method: 'GET', exec: true },
    station_status_list:    { method: 'GET', exec: true },
    reposition_list:        { method: 'GET', exec: true },
    units_list:             { method: 'GET', exec: true },
    unit_availability:      { method: 'GET', exec: true },
    augmentations:          { method: 'GET', exec: true },
    roster_fill:            { method: 'GET', exec: true },
    unit_positions:         { method: 'GET', exec: true },
    mobilization_plan:      { method: 'GET', exec: true },
    sar_summary:            { method: 'GET', exec: true },
    active_summary:         { method: 'GET', exec: true },
    dispatch_list:          { method: 'GET', exec: true },
    dashboard_active:       { method: 'GET', exec: true },
    dashboard_dispatch:     { method: 'GET', exec: true },
    dashboard_sv:           { method: 'GET', exec: true },
    // Writes (still GET via query params for now, consistent with reads)
    dispatch_create:        { method: 'GET', exec: true },
    dispatch_event:         { method: 'GET', exec: true },
    dispatch_close:         { method: 'GET', exec: true },
    station_status_set:     { method: 'GET', exec: true },
    unit_status_set:        { method: 'GET', exec: true },
    reposition_request:     { method: 'GET', exec: true },
    reposition_approve:     { method: 'GET', exec: true },
    reposition_reject:      { method: 'GET', exec: true },
    dispatch_edit:          { method: 'GET', exec: true },
    incident_audit_trail:   { method: 'GET', exec: true },
    admin_apply_validation: { method: 'GET', exec: true }
  };

  async function waitForGasToken(timeoutMs) {
    // Wait for shadow GAS login to populate the token. Returns null if it never arrives.
    const deadline = Date.now() + (timeoutMs || 8000);
    let t = sessionStorage.getItem(GAS_TOKEN_KEY);
    while (!t && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      t = sessionStorage.getItem(GAS_TOKEN_KEY);
    }
    return t;
  }

  async function authedCall(action, params) {
    const d1Token = getToken();
    if (!d1Token || isExpired()) {
      clearSession();
      window.location.href = ENTRY;
      return { ok: false, error: 'no_session' };
    }

    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let r;

    // === Migrated D1 path (fast) ===
    const mig = MIGRATED_ACTIONS[action];
    if (mig) {
      try {
        if (mig.exec) {
          // Unified router: /api/v2/exec?action=X&token=Y&...params
          const u = new URL(EXEC_PATH, window.location.origin);
          u.searchParams.set('action', action);
          u.searchParams.set('token', d1Token);
          if (params) {
            for (const k in params) {
              if (params[k] !== undefined && params[k] !== null) {
                u.searchParams.set(k, String(params[k]));
              }
            }
          }
          const res = await fetch(u.toString(), { method: mig.method || 'GET' });
          r = await res.json();
        } else {
          // Dedicated path (e.g. /api/auth/whoami)
          const res = await fetch(mig.path, {
            method: mig.method || 'GET',
            headers: {
              'Authorization': 'Bearer ' + d1Token,
              'Content-Type': 'application/json'
            },
            body: (mig.method === 'POST') ? JSON.stringify(params || {}) : undefined
          });
          r = await res.json();
        }
      } catch (e) {
        r = { ok: false, error: 'network', message: String(e) };
      }
    } else {
      // === Legacy GAS path (proxied via existing call() function) ===
      // Wait briefly for shadow GAS login to complete if not ready
      let gasToken = sessionStorage.getItem(GAS_TOKEN_KEY);
      if (!gasToken) {
        gasToken = await waitForGasToken(8000);
      }
      if (!gasToken) {
        // GAS login never completed — try one fresh attempt synchronously
        const u = getUser();
        if (u && u.nid) {
          console.warn('[CAD] GAS token missing, retrying shadow login now...');
        }
        return { ok: false, error: 'gas_token_unavailable', message: 'login may have failed silently — try logout/login' };
      }
      r = await call(action, Object.assign({ token: gasToken }, params || {}));
    }

    const ms = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
    const ok = r && r.ok;
    const via = mig ? 'D1' : 'GAS';
    if (typeof console !== 'undefined' && console.log) {
      console.log('%c[CAD] ' + action + ' (' + via + ') %c' + ms + 'ms %c' + (ok ? 'ok' : 'fail: ' + (r && r.error || 'unknown')),
        mig ? 'color:#22c55e' : 'color:#3b82f6', 'color:#9ca3af', ok ? 'color:#22c55e' : 'color:#ef4444', r);
    }
    if (r && (r.error === 'unauthorized' || r.error === 'session_expired')) {
      clearSession();
      sessionStorage.removeItem(GAS_TOKEN_KEY);
      window.location.href = ENTRY;
    }
    return r;
  }

  

  // ============================================================
  // Stale-While-Revalidate cache for read endpoints (free speed boost)
  // Returns cached response instantly if ≤ TTL old, fetches fresh in
  // background. Caller's promise resolves IMMEDIATELY with cached data
  // when available; the next refresh will have the fresh data.
  //
  // Use authedCallSWR for read-only endpoints. Keep authedCall for
  // mutations (POST-style operations like dispatch_create).
  // ============================================================
  const SWR_TTL_MS = 30 * 1000; // 30s
  const SWR_KEY_PREFIX = 'hajj_swr_';

  // Purge any SWR cache from a previous app version on first call.
  // version.js loads after auth.js, so we evaluate this lazily.
  let _swrPurgedFor = null;
  function purgeStaleSwrCache() {
    const v = (window.HAJJ_VERSION && window.HAJJ_VERSION.version) || 'dev';
    if (_swrPurgedFor === v) return;
    _swrPurgedFor = v;
    const lastVer = sessionStorage.getItem('hajj_swr_version');
    if (lastVer === v) return;
    // Version changed — wipe all SWR cache entries
    const toRemove = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf(SWR_KEY_PREFIX) === 0) toRemove.push(k);
    }
    toRemove.forEach(function(k) { sessionStorage.removeItem(k); });
    // Also clear localStorage page caches that might hold stale shapes
    ['hajj_active_cache','hajj_dispatch_cache','hajj_units_avail_cache'].forEach(function(k){
      try { localStorage.removeItem(k); } catch(_){}
    });
    sessionStorage.setItem('hajj_swr_version', v);
    if (toRemove.length && typeof console !== 'undefined') {
      console.log('[CAD] SWR cache purged (v ' + (lastVer || 'none') + ' → ' + v + '): ' + toRemove.length + ' entries');
    }
  }

  // Endpoints safe to cache (read-only)
  const SWR_SAFE_ACTIONS = {
    active_summary: true, augmentations: true, roster_fill: true,
    unit_positions: true, unit_availability: true, units_list: true,
    mobilization_plan: true, schedule_grid: true,
    station_status_list: true, sar_summary: true,
    reposition_list: true, admin_audit_list: true,
    admin_allowlist_view: true, admin_sessions_view: true,
    roster: true
  };

  async function authedCallSWR(action, params) {
    purgeStaleSwrCache();
    if (!SWR_SAFE_ACTIONS[action]) return authedCall(action, params);

    const key = SWR_KEY_PREFIX + action + ':' + JSON.stringify(params || {});
    let cached = null;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) cached = JSON.parse(raw);
    } catch (_) {}

    const fresh = cached && cached.ts && (Date.now() - cached.ts < SWR_TTL_MS);
    if (fresh && cached.data) return cached.data;

    // Stale or missing — fetch and cache
    const r = await authedCall(action, params);
    if (r && r.ok) {
      try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: r })); } catch (_) {}
    }
    return r;
  }

  function requireAuth() {
    if (!getToken() || isExpired()) {
      clearSession();
      window.location.href = ENTRY;
      return false;
    }
    return true;
  }

  function requireRole(allowed) {
    if (!requireAuth()) return false;
    const user = getUser();
    const role = String(user && user.role || '').toLowerCase();
    for (let i = 0; i < allowed.length; i++) {
      if (role === allowed[i]) return true;
    }
    // Not authorized for this page — bounce to me.html
    window.location.href = landingFor(user && user.role);
    return false;
  }

  function landingFor(role) {
    role = String(role || '').toLowerCase();
    if (role === 'sar')                return 'sar.html';
    if (role === 'cluster_supervisor') return 'sv.html';
    if (role === 'dispatcher')         return 'dispatch.html';
    if (role === 'leadership' || role === 'admin') return 'lobby.html';
    return 'me.html';
  }

  // Hajj 1447H mapping (4 DH = 30 May 2026 → 14 DH = 9 June 2026).
  const DH_DATES = {
    '4 DH':  '2026-05-30',
    '5 DH':  '2026-05-31',
    '6 DH':  '2026-06-01',
    '7 DH':  '2026-06-02',
    '8 DH':  '2026-06-03',
    '9 DH':  '2026-06-04',
    '10 DH': '2026-06-05',
    '11 DH': '2026-06-06',
    '12 DH': '2026-06-07',
    '13 DH': '2026-06-08',
    '14 DH': '2026-06-09'
  };

  function dhForDate(d) {
    const iso = (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
    for (const k in DH_DATES) if (DH_DATES[k] === iso) return k;
    return null;
  }

  function todayDH() { return dhForDate(new Date()); }

  window.HAJJ = {
    call: call,
    pcrCall: pcrCall,
    authedCall: authedCall,
    authedCallSWR: authedCallSWR,
    login: login,
    logout: logout,
    getToken: getToken,
    getUser: getUser,
    setSession: setSession,
    clearSession: clearSession,
    requireAuth: requireAuth,
    requireRole: requireRole,
    landingFor: landingFor,
    dhForDate: dhForDate,
    todayDH: todayDH,
    DH_DATES: DH_DATES
  };
})();

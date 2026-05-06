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

  async function login(nid, last4) {
    const r = await call('auth', {
      nid: nid,
      last4: last4,
      ua: navigator.userAgent.slice(0, 80)
    });
    if (r && r.ok && r.token) {
      setSession(r.token, r.user, r.expires);
    }
    return r;
  }

  async function logout() {
    const token = getToken();
    if (token) {
      try { await call('logout', { token: token }); } catch (_) {}
    }
    clearSession();
    window.location.href = ENTRY;
  }

  async function authedCall(action, params) {
    const token = getToken();
    if (!token || isExpired()) {
      clearSession();
      window.location.href = ENTRY;
      return { ok: false, error: 'no_session' };
    }
    const r = await call(action, Object.assign({ token: token }, params || {}));
    if (r && r.error === 'unauthorized') {
      clearSession();
      window.location.href = ENTRY;
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
    window.location.href = 'me.html';
    return false;
  }

  function landingFor(role) {
    role = String(role || '').toLowerCase();
    if (role === 'dispatcher') return 'dispatch.html';
    // Admin, leadership, paramedic, gp, cluster_supervisor → personal page.
    // Lobby comes later when active.html exists.
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

/**
 * Hajj 2026 — Date-aware refresh tempo.
 *
 * Returns refresh interval (ms) based on current date relative to Hajj operational phases.
 * Anchor: DH 4 = 30 May 2026 (per master plan); DH 1 = 27 May 2026.
 *
 * Phases:
 *   Pre-Hajj    (now - DH 1, before 27 May 2026)  : 60s   (low cost during planning)
 *   DH 1-3      (27 May - 29 May 2026, drills)    : 30s
 *   DH 4-6      (30 May - 1 Jun 2026, soft ops)   : 15s
 *   DH 7-14     (2 Jun - 9 Jun 2026, peak/Nafra)  : 5s    (operations critical)
 *   Post-Hajj   (10 Jun 2026 onwards)             : 60s
 */
window.HAJJ_TEMPO = (function() {
  // KSA timezone (UTC+3) — anchor dates in local KSA midnight
  function ksaDate(yyyy, mm, dd) {
    return new Date(Date.UTC(yyyy, mm - 1, dd, -3, 0, 0)); // adjust for UTC+3
  }
  const DH1 = ksaDate(2026, 5, 27);   // 27 May 2026 00:00 KSA
  const DH4 = ksaDate(2026, 5, 30);   // 30 May 2026
  const DH7 = ksaDate(2026, 6, 2);    // 2 Jun 2026
  const DH14_END = ksaDate(2026, 6, 10); // 10 Jun 2026 (post-Hajj)

  function intervalMs() {
    const now = new Date();
    if (now < DH1)        return 60000; // pre-Hajj
    if (now < DH4)        return 30000; // DH 1-3 drills
    if (now < DH7)        return 15000; // DH 4-6 soft ops
    if (now < DH14_END)   return 5000;  // DH 7-14 peak (operations critical)
    return 60000;                       // post-Hajj
  }

  function phase() {
    const now = new Date();
    if (now < DH1)        return 'pre-hajj';
    if (now < DH4)        return 'drills (DH 1-3)';
    if (now < DH7)        return 'soft ops (DH 4-6)';
    if (now < DH14_END)   return 'peak ops (DH 7-14)';
    return 'post-hajj';
  }

  return { intervalMs: intervalMs, phase: phase };
})();

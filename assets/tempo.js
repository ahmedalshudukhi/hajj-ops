/**
 * Hajj 2026 — Date-aware refresh tempo.
 *
 * Returns refresh interval (ms) based on current date relative to Hajj operational phases.
 * Anchor: DH 1 = 27 May 2026, DH 4 = 30 May, DH 9 (Nafra) = 4 Jun, DH 14 = 9 Jun.
 *
 * Phases (per Ahmed's call — DH 4 onwards is peak ops, no soft-ops phase):
 *   Pre-Hajj    (now -> 27 May)              60s   (low cost during planning)
 *   DH 1-3      (27-29 May, drills only)     30s
 *   DH 4-14     (30 May - 9 Jun, FULL OPS)   5s    (centerpiece + Nafra + Eid + Tashreeq)
 *   Post-Hajj   (10 Jun onwards)             60s
 */
window.HAJJ_TEMPO = (function() {
  function ksaDate(yyyy, mm, dd) {
    return new Date(Date.UTC(yyyy, mm - 1, dd, -3, 0, 0)); // KSA = UTC+3
  }
  const DH1     = ksaDate(2026, 5, 27);
  const DH4     = ksaDate(2026, 5, 30);
  const POST_HAJJ = ksaDate(2026, 6, 10);

  function intervalMs() {
    const now = new Date();
    if (now < DH1)        return 60000; // pre-Hajj
    if (now < DH4)        return 30000; // DH 1-3 drills
    if (now < POST_HAJJ)  return 5000;  // DH 4-14 — full ops, all peak
    return 60000;                        // post-Hajj
  }

  function phase() {
    const now = new Date();
    if (now < DH1)        return 'pre-hajj';
    if (now < DH4)        return 'drills (DH 1-3)';
    if (now < POST_HAJJ)  return 'peak ops (DH 4-14)';
    return 'post-hajj';
  }

  return { intervalMs: intervalMs, phase: phase };
})();

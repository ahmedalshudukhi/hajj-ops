/**
 * Hajj 2026 — backend URLs.
 *
 * Two Apps Scripts power the dashboard. Edit both URLs below after deployment.
 *
 *  BACKEND_URL — Our auth + dispatch + roster backend
 *                Owner: Ahmed (PM). Deployed from /backend/Code.gs.
 *                Used by:  entry.html, me.html, dispatch.html
 *
 *  PCR_URL     — Clinical PCR + Q-PCR sheet (existing /gas-template.gs)
 *                Owner: DCH (Hayil). Deployed by DCH from gas-template.gs.
 *                Used by:  dispatch.html (write Q-PCR on close),
 *                          active.html (read census), index.html (PCR tab).
 *
 * Both URLs are safe to commit: they require auth (NID + last-4) and/or
 * field validation server-side. The URL alone is useless.
 */

// Our backend (deployed yesterday — paste your /exec URL):
window.BACKEND_URL = 'https://script.google.com/macros/s/PASTE_BACKEND_DEPLOYMENT_ID/exec';

// DCH's Q-PCR script (paste the URL Hayil shared):
window.PCR_URL = 'https://script.google.com/macros/s/PASTE_PCR_DEPLOYMENT_ID/exec';

/**
 * Hajj 2026 — backend URLs.
 *
 * Two Apps Scripts power the dashboard. Both URLs are safe to commit:
 * the URL alone is useless without auth (NID + last-4) or field validation.
 *
 *  BACKEND_URL — Auth + dispatch + roster backend (deployed by Ahmed).
 *                Used by:  entry.html, me.html, dispatch.html
 *
 *  PCR_URL     — Q-PCR sheet (deployed by DCH from gas-template.gs).
 *                Used by:  dispatch.html (Q-PCR write on close),
 *                          active.html (read census), index.html (PCR tab).
 */

window.BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxm3tEWy8RiJXjxGV_yPLG6j4iXv_HiPVYzJ28B-evL9OcM4pzap9GglUMkAvvht4Y/exec';

window.PCR_URL = 'https://script.google.com/macros/s/AKfycbxbr7cD4oAEPkMDfaJBu48-205l9qeB777Z3EpuM_ikubfh9R_XjZqnjnvV2DLl1-41tg/exec';

/**
 * Hajj CAD — config.
 *
 * BACKEND_URL: now points to our Cloudflare Pages Function proxy at /api/exec.
 * The function (in functions/api/exec.js) caches read endpoints at the edge
 * for 30s and proxies writes straight through to Apps Script.
 *
 * Net effect:
 *   - First call per cache window: ~3-5s (Apps Script cold)
 *   - Subsequent calls within 30s: ~30-80ms (Cloudflare edge)
 *   - Mutating writes always passthrough (no cache, dispatch_create stays consistent)
 *
 * Direct Apps Script URL (used by the function):
 *   https://script.google.com/macros/s/AKfycbxm3tEWy8RiJXjxGV_yPLG6j4iXv_HiPVYzJ28B-evL9OcM4pzap9GglUMkAvvht4Y/exec
 */
window.BACKEND_URL = '/api/exec';

// PCR script (separate, on DCH's Apps Script project — not yet proxied)
window.PCR_URL = 'https://script.google.com/macros/s/AKfycbxbr7cD4oAEPkMDfaJBu48-205l9qeB777Z3EpuM_ikubfh9R_XjZqnjnvV2DLl1-41tg/exec';

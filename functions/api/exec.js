/**
 * Hajj CAD — Cloudflare Pages Function caching proxy
 * Path: /api/exec
 * Replaces direct calls to Apps Script with edge-cached responses.
 *
 * BEHAVIOR:
 *   - Read endpoints: cached at Cloudflare edge for 30s (per data center)
 *   - Write endpoints: pass through, never cached
 *   - Cache key includes user token so it is per-session (privacy-safe)
 *   - First request after cache miss = Apps Script latency (~3-5s)
 *   - Subsequent requests within 30s = ~30-80ms edge response
 *
 * NO MANUAL CONFIG NEEDED:
 *   - Cloudflare Pages auto-discovers functions/ on push
 *   - Cache API is built-in (no KV namespace needed)
 *   - Just push to main and it goes live
 */
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxm3tEWy8RiJXjxGV_yPLG6j4iXv_HiPVYzJ28B-evL9OcM4pzap9GglUMkAvvht4Y/exec';

// Read-only actions that are safe to cache
const READ_ACTIONS = new Set([
  'whoami', 'roster',
  'admin_allowlist_view', 'admin_sessions_view', 'admin_audit_list',
  'station_status_list', 'reposition_list',
  'units_list', 'unit_availability', 'unit_positions',
  'augmentations', 'roster_fill', 'mobilization_plan',
  'sar_summary', 'active_summary', 'dispatch_list',
  'dashboard_active', 'dashboard_dispatch', 'dashboard_sv',
  'schedule_grid', 'stats'
]);

const TTL_SECONDS = 30; // edge cache lifetime

export async function onRequest(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);

  // Pass POSTs straight through (mutations)
  if (request.method === 'POST') {
    return proxyToAppsScript(request, url);
  }

  const action = url.searchParams.get('action') || '';
  const token  = url.searchParams.get('token')  || '';
  const cacheable = READ_ACTIONS.has(action);

  if (!cacheable) {
    // Mutations / unknown — straight passthrough, no cache
    return proxyToAppsScript(request, url);
  }

  // Build a cache key URL that:
  //   - is unique per (action, token-prefix, query params)
  //   - lives on a fake hostname so we never collide with real assets
  const tokenSlice = token.slice(0, 16);
  const extraParams = new URLSearchParams();
  for (const k of url.searchParams.keys()) {
    if (k !== 'token') extraParams.set(k, url.searchParams.get(k));
  }
  const cacheUrl = new URL(`https://hajj-cad-cache.internal/${action}/${tokenSlice}?${extraParams.toString()}`);

  const cache = caches.default;
  const hit = await cache.match(cacheUrl);
  if (hit) {
    const cached = new Response(hit.body, hit);
    cached.headers.set('X-CAD-Cache', 'HIT');
    cached.headers.set('Access-Control-Allow-Origin', '*');
    return cached;
  }

  // MISS — fetch from Apps Script
  const upstreamUrl = APPS_SCRIPT_URL + url.search;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      redirect: 'follow',
      cf: { cacheTtl: TTL_SECONDS, cacheEverything: true }
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'upstream_unreachable', detail: String(err) }, 502);
  }

  const body = await upstream.text();

  // Validate JSON before caching — never cache HTML error pages
  let isValidJson = false;
  try { JSON.parse(body); isValidJson = true; } catch (_) {}

  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-CAD-Cache': 'MISS',
    'Access-Control-Allow-Origin': '*'
  });

  if (upstream.ok && isValidJson && body) {
    headers.set('Cache-Control', `public, max-age=${TTL_SECONDS}, s-maxage=${TTL_SECONDS}`);
    const toCache = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${TTL_SECONDS}, s-maxage=${TTL_SECONDS}`
      }
    });
    waitUntil(cache.put(cacheUrl, toCache));
  } else {
    headers.set('Cache-Control', 'no-cache');
  }

  return new Response(body, { status: upstream.status, headers });
}

async function proxyToAppsScript(request, url) {
  const upstreamUrl = APPS_SCRIPT_URL + url.search;
  const init = { method: request.method, redirect: 'follow' };
  if (request.method === 'POST') {
    init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    init.body = await request.text();
  }
  try {
    const upstream = await fetch(upstreamUrl, init);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'X-CAD-Cache': 'BYPASS',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'upstream_unreachable', detail: String(err) }, 502);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// Handle CORS preflight (in case browser sends one)
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

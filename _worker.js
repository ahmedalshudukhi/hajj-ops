/**
 * hajj-ops _worker.js
 * Cloudflare Pages Functions worker for the hajj.shuki.tech dashboard.
 *
 * Adds JSON API on top of the static site:
 *   GET /api/v1/health         service status + version
 *   GET /api/v1/personnel      staff totals
 *   GET /api/v1/units          all units detail
 *   GET /api/v1/stations       station summary + fill state
 *   GET /api/v1/movements      augmentation movements
 *   GET /api/v1/ambulances     ambulance fleet
 *   GET /api/v1/calendar       hajj day calendar
 *   GET /api/v1/snapshot       full data.json snapshot
 *   GET /api/v1/pcr/proxy?url=…&endpoint=…   GAS proxy with CORS handling
 *
 * Static assets served normally for everything else.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=60",
};

function jsonResponse(data, opts = {}) {
  return new Response(JSON.stringify(data, null, opts.pretty ? 2 : 0), {
    status: opts.status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...(opts.cache !== false ? CACHE_HEADERS : {}),
    },
  });
}

async function loadData(env) {
  // Fetch the static data.json from the site itself
  const url = "https://hajj.shuki.tech/data.json?t=" + Date.now();
  try {
    const r = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
    if (!r.ok) throw new Error("data.json fetch failed: " + r.status);
    return await r.json();
  } catch (e) {
    return { error: "data.json unavailable", detail: e.message };
  }
}

async function handleApi(request, env, ctx, pathname) {
  // OPTIONS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const route = pathname.replace(/^\/api\/v1\/?/, "");

  // Health check (no data needed)
  if (route === "health") {
    return jsonResponse({
      status: "ok",
      version: "v11.8",
      build: "v8 schema",
      service: "hajj-ops",
      time: new Date().toISOString(),
    });
  }

  // PCR proxy — forward to user-configured GAS endpoint
  if (route === "pcr/proxy") {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target || !/^https:\/\/script\.google\.com\//.test(target)) {
      return jsonResponse({ error: "url param required, must be https://script.google.com/..." }, { status: 400, cache: false });
    }
    const endpoint = url.searchParams.get("endpoint") || "summary";
    const targetUrl = new URL(target);
    targetUrl.searchParams.set("endpoint", endpoint);
    // Forward additional params
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== "url" && k !== "endpoint") targetUrl.searchParams.set(k, v);
    }
    try {
      const r = await fetch(targetUrl.toString(), { headers: { "Accept": "application/json" } });
      const txt = await r.text();
      return new Response(txt, {
        status: r.status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
      });
    } catch (e) {
      return jsonResponse({ error: "proxy failed", detail: e.message }, { status: 502, cache: false });
    }
  }

  // All other routes need data.json
  const data = await loadData(env);
  if (data.error) return jsonResponse(data, { status: 503, cache: false });

  switch (route) {
    case "snapshot":
      return jsonResponse(data, { pretty: true });
    case "personnel":
      return jsonResponse({ personnel: data.personnel, totals: data.totals, refreshed_at: data.refreshed_at });
    case "units":
      return jsonResponse({ units: data.units_detail || [], count: (data.units_detail || []).length, refreshed_at: data.refreshed_at });
    case "stations":
      return jsonResponse({ stations: data.stations_detail || [], count: (data.stations_detail || []).length, refreshed_at: data.refreshed_at });
    case "movements":
      return jsonResponse({ movements: data.movements || [], augmentations: data.augmentations || [], refreshed_at: data.refreshed_at });
    case "ambulances":
      return jsonResponse({ ambulances: data.ambulance_roster || [], by_station: data.amb_by_station || {}, count: (data.ambulance_roster || []).length, refreshed_at: data.refreshed_at });
    case "calendar":
      return jsonResponse({ calendar: data.calendar || [], timeline: data.timeline || [], refreshed_at: data.refreshed_at });
    case "":
    case "/":
      return jsonResponse({
        api: "hajj-ops v1",
        version: "v11.8",
        endpoints: [
          "/api/v1/health",
          "/api/v1/personnel",
          "/api/v1/units",
          "/api/v1/stations",
          "/api/v1/movements",
          "/api/v1/ambulances",
          "/api/v1/calendar",
          "/api/v1/snapshot",
          "/api/v1/pcr/proxy?url=…&endpoint=…",
        ],
        docs: "https://hajj.shuki.tech/api-docs.html",
      });
  }

  return jsonResponse({ error: "endpoint not found", route, available: "/api/v1/" }, { status: 404, cache: false });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx, url.pathname);
    }

    // Static assets — pass through to Pages
    return env.ASSETS.fetch(request);
  },
};

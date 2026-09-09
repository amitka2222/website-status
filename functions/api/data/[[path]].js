// Serves the monitoring JSON to the dashboard.
//
// Why this exists: once the repository is private, the data files under
// docs/data are no longer publicly readable, and Cloudflare Pages would need a
// rebuild to publish each new set of results. At ~14 result commits a day that
// is ~430 builds a month against a 500/month free allowance - almost no
// headroom, and it breaks the moment the check cadence improves.
//
// Instead the result commits carry [skip ci], so Cloudflare skips those builds
// entirely, and this function reads the current data straight from the private
// repo through the GitHub API. Builds then only happen when the site itself
// changes, which is rare.
//
// Responses are cached at the edge for CACHE_SECONDS so that a room full of
// people watching the dashboard collapses into a couple of GitHub calls a
// minute rather than one per viewer per file.

const CACHE_SECONDS = 30;

// Only these may be requested. Without an allowlist, `path` would let anyone
// behind Access read any file in the repository through this endpoint.
const ALLOWED = new Set([
  'status.json',
  'recent.json',
  'incidents.json',
  'apis.json',
  'forms.json',
  'forms-recent.json',
]);

export async function onRequestGet(context) {
  const { params, env, request } = context;

  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const name = parts.join('/');

  // Monthly aggregates live in a subfolder and are named by date.
  const isDaily = /^daily\/\d{4}-\d{2}\.json$/.test(name);
  if (!ALLOWED.has(name) && !isDaily) {
    return json({ error: 'Not found' }, 404);
  }

  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const branch = env.GITHUB_BRANCH || 'main';
  if (!repo || !token) {
    return json({ error: 'GITHUB_REPO and GITHUB_TOKEN must be set on the Pages project' }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream =
    `https://api.github.com/repos/${repo}/contents/docs/data/${name}?ref=${encodeURIComponent(branch)}`;

  let res;
  try {
    res = await fetch(upstream, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github.raw+json',
        'user-agent': 'advtech-website-status-dashboard',
      },
    });
  } catch (err) {
    return json({ error: 'Could not reach GitHub', detail: String(err.message) }, 502);
  }

  if (!res.ok) {
    // 404 here usually means the first run of a new check has not committed yet.
    return json({ error: `GitHub returned ${res.status}`, file: name }, res.status === 404 ? 404 : 502);
  }

  const body = await res.text();
  const out = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      'x-data-source': 'github-api',
    },
  });

  context.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

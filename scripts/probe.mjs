// Probes every site in sites.csv and updates the JSON files that the dashboard reads.
// Runs on a GitHub Actions runner using only the Node standard library - no dependencies,
// so there is nothing to install and nothing to keep patched.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA      = join(ROOT, 'docs', 'data');
const DAILY_DIR = join(DATA, 'daily');

const TIMEOUT_MS     = 30000;
const CONCURRENCY    = 10;
// Calibrated for the vantage point, not for a local browser. GitHub's runners sit
// in US datacentres, so South African sites legitimately answer in 2-5s from there
// (measured: p50 2.1s, p90 4.5s). A 3s threshold - reasonable from Johannesburg -
// flagged a quarter of the estate as degraded around the clock. 8s leaves headroom
// above normal transatlantic latency while still catching a genuinely sick site.
// A per-site baseline (flag when a site exceeds ~2x its own 7-day p95) would be
// sharper still, and the daily aggregates already record what that needs.
const SLOW_MS        = 8000;   // slower than this counts as Degraded
const CERT_WARN_DAYS = 21;     // cert expiring sooner than this counts as Degraded
const MAX_REDIRECTS  = 10;
const RETRIES        = 1;
const RECENT_POINTS  = 288;    // rolling sparkline window

const USER_AGENT = 'Advtech-SiteMonitor/1.0 (+availability monitoring)';

// Some properties sit behind a Cloudflare bot challenge that returns 403 to every
// automated client regardless of user agent or source IP. The site is perfectly
// fine for real visitors, so this is "cannot verify" - not "down". Calling it an
// outage is a false alarm; calling it up would be a false pass. It gets its own
// state so the distinction is visible rather than guessed at.
const CHALLENGE_RE = /Just a moment|cf-browser-verification|challenge-platform|_cf_chl|Attention Required|Checking your browser/i;

function isBotChallenge(status, headers, body) {
  if (headers && headers['cf-mitigated'] === 'challenge') return true;
  if ((status === 403 || status === 503 || status === 429) && body && CHALLENGE_RE.test(body)) return true;
  return false;
}

// ---------------------------------------------------------------- site list

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).filter(Boolean).map(line => {
    // A simple split is safe here: the site list has no quoted commas.
    const cells = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]));
  }).filter(row => row.Url);
}

// ---------------------------------------------------------------- probing

function requestOnce(url, collectCert) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ error: 'Invalid URL: ' + url, ms: 0 });
    }

    const lib = target.protocol === 'http:' ? http : https;
    const started = process.hrtime.bigint();
    let cert = null;
    let settled = false;

    const done = result => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ...result, ms: Math.round(ms), cert });
    };

    // Reads the peer certificate off an already-secure socket.
    const readCert = socket => {
      if (cert || !socket || typeof socket.getPeerCertificate !== 'function') return;
      const peer = socket.getPeerCertificate();
      if (!peer || !peer.valid_to) return;
      const expires = new Date(peer.valid_to);
      cert = {
        expiresOn: expires.toISOString().slice(0, 10),
        daysToExpiry: Math.floor((expires - Date.now()) / 86400000),
        issuer: (peer.issuer && (peer.issuer.O || peer.issuer.CN)) || null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
      };
    };

    const req = lib.request(target, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      // We inspect the certificate ourselves, so an expired or mismatched cert must
      // not abort the connection - the whole point is to report on it.
      rejectUnauthorized: false,
    }, res => {
      // Fallback: Node keeps sockets alive by default, so a pooled connection
      // (e.g. one left open by a redirect to the same host) never re-fires
      // 'secureConnect'. By response time the socket is definitely secure.
      if (collectCert && target.protocol === 'https:') readCert(res.socket);

      let bytes = 0;
      let body = '';
      res.on('data', chunk => {
        bytes += chunk.length;
        if (body.length < 200000) body += chunk.toString('utf8');
      });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, bytes, body }));
    });

    if (collectCert && target.protocol === 'https:') {
      req.on('socket', socket => {
        if (socket.encrypted) readCert(socket);          // already-connected pooled socket
        socket.on('secureConnect', () => readCert(socket)); // fresh handshake
      });
    }

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      done({ error: 'Timed out after ' + (TIMEOUT_MS / 1000) + 's' });
    });
    req.on('error', err => done({ error: err.message }));
    req.end();
  });
}

// Follows redirects by hand so the full chain can be reported rather than hidden.
async function probe(url) {
  let current = url;
  let hops = 0;
  let cert = null;
  let totalMs = 0;

  while (hops <= MAX_REDIRECTS) {
    const res = await requestOnce(current, hops === 0);
    totalMs += res.ms || 0;
    if (hops === 0) cert = res.cert;

    if (res.error) return { error: res.error, ms: totalMs, finalUrl: current, hops, cert };

    const location = res.headers && res.headers.location;
    const isRedirect = res.status >= 300 && res.status < 400 && location;
    if (!isRedirect) {
      return { status: res.status, headers: res.headers, bytes: res.bytes, body: res.body,
               ms: totalMs, finalUrl: current, hops, cert };
    }

    current = new URL(location, current).toString();
    hops++;
  }
  return { error: 'More than ' + MAX_REDIRECTS + ' redirects', ms: totalMs, finalUrl: current, hops, cert };
}

async function checkSite(site) {
  let result;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    result = await probe(site.Url);
    if (!result.error) break;
    // A single dropped packet should not read as an outage.
    if (attempt < RETRIES) await new Promise(r => setTimeout(r, 1500));
  }

  const expected = (site.ExpectedText || '').trim();
  const contentOk = expected ? (result.body || '').includes(expected) : null;

  const blocked = isBotChallenge(result.status, result.headers, result.body);
  const up = !result.error && result.status >= 200 && result.status < 400;
  const reasons = [];

  if (blocked) reasons.push('Blocked by bot protection (HTTP ' + result.status + ') - cannot verify');
  else if (result.error) reasons.push(result.error);
  else if (!up) reasons.push('HTTP ' + result.status);

  if (up && result.ms > SLOW_MS) reasons.push('Slow (' + (result.ms / 1000).toFixed(1) + 's)');
  if (contentOk === false) reasons.push('Content check failed');

  if (result.cert && !result.cert.authorized && result.cert.authorizationError) {
    reasons.push('Certificate: ' + result.cert.authorizationError);
  } else if (result.cert && result.cert.daysToExpiry <= CERT_WARN_DAYS) {
    reasons.push('Certificate expires in ' + result.cert.daysToExpiry + ' days');
  }

  const state = blocked ? 'blocked' : !up ? 'down' : reasons.length ? 'degraded' : 'up';

  return {
    site: site.Site,
    brand: site.Brand,
    division: site.Division,
    url: site.Url,
    finalUrl: result.finalUrl,
    redirected: (result.hops || 0) > 0,
    redirects: result.hops || 0,
    state,
    status: result.status || 0,
    ms: typeof result.ms === 'number' ? result.ms : null,
    bytes: typeof result.bytes === 'number' ? result.bytes : null,
    contentOk,
    cert: result.cert
      ? {
          expiresOn: result.cert.expiresOn,
          days: result.cert.daysToExpiry,
          issuer: result.cert.issuer,
          valid: result.cert.authorized,
        }
      : null,
    reason: reasons.join('; '),
  };
}

async function runPool(items, worker, limit) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------- persistence

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value) + '\n');
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const i = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p));
  return sortedValues[i];
}

// ---------------------------------------------------------------- main

const sites = parseCsv(readFileSync(join(ROOT, 'sites.csv'), 'utf8'));
const startedAt = Date.now();

console.log('Probing ' + sites.length + ' sites...');

const results = (await runPool(sites, checkSite, CONCURRENCY))
  .sort((a, b) => a.site.localeCompare(b.site));

const nowIso = new Date().toISOString();
const day    = nowIso.slice(0, 10);
const month  = nowIso.slice(0, 7);

// ---------------------------------------------------------------- vantage guard
// When the monitor itself is being blocked, every site fails at once at the
// network layer. Reporting that as 33 simultaneous outages is a lie, and one
// that trains people to ignore the dashboard - the same failure the staleness
// banner exists to prevent.
//
// So: if a large share of sites fail with no HTTP response at all (connection
// reset, TLS handshake dropped) in a single run, the vantage point is the far
// more likely culprit than the entire estate going dark in the same second.
// Those become "cannot verify" and the run is flagged. Sites that answered with
// a real HTTP error are untouched - a 500 is a genuine fault wherever you are.
const VANTAGE_SUSPECT_RATIO = 0.4;

const connectionFailures = results.filter(r => r.state === 'down' && !r.status);
const vantageSuspect = connectionFailures.length / results.length >= VANTAGE_SUSPECT_RATIO;

if (vantageSuspect) {
  for (const r of connectionFailures) {
    r.state = 'blocked';
    r.reason = 'No connection, along with ' + (connectionFailures.length - 1) +
               ' other sites in the same run - the monitor is being blocked at the ' +
               'network layer, so this site could not be verified either way';
  }
  console.log('WARNING: ' + connectionFailures.length + ' of ' + results.length +
              ' sites failed to connect in one run. Treating this as a blocked ' +
              'vantage point rather than a mass outage.');
}

const counts = { up: 0, degraded: 0, down: 0, blocked: 0 };
for (const r of results) counts[r.state]++;

// --- 1. Current snapshot -------------------------------------------------
writeJson(join(DATA, 'status.json'), {
  generatedAt: nowIso,
  total: results.length,
  up: counts.up,
  degraded: counts.degraded,
  down: counts.down,
  blocked: counts.blocked,
  vantageSuspect: vantageSuspect,
  // Strip the response body before writing - it is only needed for the content check.
  sites: results.map(({ body, ...rest }) => rest),
});

// --- 2. Rolling sparkline window (column-oriented to keep the file small) -
const recent = readJson(join(DATA, 'recent.json'), { points: [], series: {} });
recent.points.push(nowIso);
for (const r of results) {
  if (!recent.series[r.site]) recent.series[r.site] = [];
  recent.series[r.site].push(r.state === 'down' || r.state === 'blocked' ? null : r.ms);
}

const overflow = recent.points.length - RECENT_POINTS;
if (overflow > 0) recent.points = recent.points.slice(overflow);

const liveSites = new Set(results.map(r => r.site));
for (const key of Object.keys(recent.series)) {
  // Forget sites that have been removed from sites.csv.
  if (!liveSites.has(key)) {
    delete recent.series[key];
    continue;
  }
  // Left-pad series for sites added part-way through the window so every
  // series lines up with the shared points axis.
  const pad = recent.points.length - recent.series[key].length;
  if (pad > 0) recent.series[key] = Array(pad).fill(null).concat(recent.series[key]);
  if (recent.series[key].length > recent.points.length) {
    recent.series[key] = recent.series[key].slice(-recent.points.length);
  }
}
recent.updatedAt = nowIso;
writeJson(join(DATA, 'recent.json'), recent);

// --- 3. Daily aggregates (one small file per month) ----------------------
const dailyFile = join(DAILY_DIR, month + '.json');
const daily = readJson(dailyFile, {});
if (!daily[day]) daily[day] = {};

for (const r of results) {
  // A blocked check measured nothing, so it is excluded from the uptime maths
  // entirely rather than counted as either a success or a failure.
  if (r.state === 'blocked') continue;
  if (!daily[day][r.site]) {
    daily[day][r.site] = { checks: 0, up: 0, msSum: 0, msMax: 0, samples: [] };
  }
  const d = daily[day][r.site];
  d.checks++;
  if (r.state !== 'down') d.up++;
  if (typeof r.ms === 'number') {
    d.msSum += r.ms;
    d.msMax = Math.max(d.msMax, r.ms);
    // Bounded reservoir so p95 stays meaningful without the file growing forever.
    if (d.samples.length < 500) d.samples.push(r.ms);
  }
  d.avg = Math.round(d.msSum / Math.max(1, d.checks));
  d.p95 = percentile(d.samples.slice().sort((a, b) => a - b), 0.95);
  d.uptime = Number((d.up / d.checks).toFixed(4));
}
writeJson(dailyFile, daily);

// --- 4. Incident log (open on first failure, close on recovery) ----------
const incidentsFile = join(DATA, 'incidents.json');
const incidents = readJson(incidentsFile, []);
const openBySite = new Map(incidents.filter(i => !i.endedAt).map(i => [i.site, i]));

for (const r of results) {
  const open = openBySite.get(r.site);
  if (r.state === 'down' && !open) {
    incidents.unshift({
      id: r.site + '-' + nowIso,
      site: r.site,
      brand: r.brand,
      startedAt: nowIso,
      endedAt: null,
      minutes: null,
      status: r.status,
      reason: r.reason || 'Unreachable',
    });
  } else if (r.state === 'blocked') {
    // Once a site is blocked we lose visibility, so an open incident can never be
    // resolved and would sit there reading "ongoing" forever. Close it and record
    // that the outcome is unknown, rather than implying a permanent outage.
    if (open) {
      open.endedAt = nowIso;
      open.minutes = Math.round((Date.parse(nowIso) - Date.parse(open.startedAt)) / 60000);
      open.reason = (open.reason || '') + ' - closed because monitoring was blocked; outcome unknown';
    }
  } else if (r.state !== 'down' && open) {
    open.endedAt = nowIso;
    open.minutes = Math.round((Date.parse(nowIso) - Date.parse(open.startedAt)) / 60000);
  }
}
// 500 incidents is far more history than anyone scrolls through.
writeJson(incidentsFile, incidents.slice(0, 500));

// --- 5. Console summary --------------------------------------------------
const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log('Done in ' + secs + 's - up ' + counts.up + ', degraded ' + counts.degraded +
            ', down ' + counts.down + ', blocked ' + counts.blocked);
for (const r of results.filter(x => x.state !== 'up')) {
  console.log('  [' + r.state.toUpperCase() + '] ' + r.site + ' - ' + r.reason);
}

// Optionally fail the step so the Actions run goes red and GitHub notifies watchers.
if (counts.down > 0 && process.env.FAIL_ON_DOWN === 'true') {
  process.exitCode = 1;
}

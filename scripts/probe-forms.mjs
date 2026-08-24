// Checks that the application and enquiry forms actually render and are usable.
//
// These forms are JavaScript-driven, so an HTTP fetch is not enough - the Emeris
// enquiry form, for example, returns HTTP 200 with every dropdown empty because
// its options arrive by API afterwards, and the Capsicum signup page is an Angular
// app whose entire form exists only after the bundle boots. So this runs a real
// Chromium browser.
//
// IMPORTANT: this NEVER submits anything. It loads each form and inspects it.
// Submitting on a schedule would file real enquiries and applications into the
// admissions systems - hundreds of fake leads a day. Do not add a submit step.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'data');

const NAV_TIMEOUT_MS   = 45000;
const FIELD_TIMEOUT_MS = 20000;  // how long to wait for the form to render
const SLOW_MS          = 15000;  // a form slower than this is Degraded (browser + US runner)
const RECENT_POINTS    = 96;     // rolling window for the sparkline (48h at 30 min)

// Some properties sit behind a Cloudflare bot challenge that no automated client
// can pass - not even a headless browser, which Cloudflare fingerprints. The page
// is fine for real visitors, so this is "cannot verify", not "down". Reporting it
// as an outage would be a false alarm; reporting it as up would be a false pass.
const CHALLENGE_RE = /Just a moment|cf-browser-verification|challenge-platform|_cf_chl|Attention Required|Checking your browser/i;

const readJson = (f, fallback) => {
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback; }
  catch { return fallback; }
};
const writeJson = (f, v) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 0) + '\n');
};

const config = JSON.parse(readFileSync(join(ROOT, 'forms.json'), 'utf8'));
const forms = config.forms;

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const results = [];

console.log('Checking ' + forms.length + ' forms with a real browser...');

for (const form of forms) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    // Identify honestly. These are ADvTECH's own properties.
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
               'Chrome/125.0.0.0 Safari/537.36 ADvTECH-SiteMonitor/1.0',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)));

  const problems = [];
  const detail = { missingFields: [], emptySelects: [], selectCounts: {} };
  let status = null, ms = null, finalUrl = null, rendered = false, blocked = false;

  const started = Date.now();
  try {
    const response = await page.goto(form.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    status = response ? response.status() : null;
    finalUrl = page.url();

    if (status !== null && status >= 400) {
      const body = await page.content().catch(() => '');
      const mitigated = response && response.headers()['cf-mitigated'] === 'challenge';
      if (mitigated || CHALLENGE_RE.test(body)) blocked = true;
    }

    if (blocked) {
      problems.push('Blocked by bot protection - cannot verify');
    } else if (status === null) {
      problems.push('No response');
    } else if (status >= 400) {
      problems.push('HTTP ' + status);
    }

    if (!blocked && status && status < 400) {
      // Wait for the form itself, not just the document - these pages render late.
      try {
        await page.waitForSelector(form.waitFor, { state: 'attached', timeout: FIELD_TIMEOUT_MS });
        rendered = true;
      } catch {
        problems.push('Form did not render within ' + (FIELD_TIMEOUT_MS / 1000) + 's');
      }

      if (rendered) {
        // 1. Are the fields a person needs actually present?
        for (const sel of form.requiredFields || []) {
          if (await page.locator(sel).count() === 0) {
            detail.missingFields.push(sel);
          }
        }
        if (detail.missingFields.length) {
          problems.push(detail.missingFields.length + ' field(s) missing');
        }

        // 2. Are the dropdowns carrying real options? An empty campus list is a
        //    broken form that still looks perfectly healthy from the outside.
        for (const spec of form.populatedSelects || []) {
          const count = await page.locator(spec.selector + ' option').count().catch(() => 0);
          detail.selectCounts[spec.selector] = count;
          if (count < spec.min) {
            detail.emptySelects.push(spec.selector + ' (' + count + ')');
          }
        }
        if (detail.emptySelects.length) {
          problems.push('empty dropdown: ' + detail.emptySelects.join(', '));
        }

        // 3. Expected copy present?
        if (form.expectText) {
          const body = await page.textContent('body').catch(() => '');
          if (!(body || '').includes(form.expectText)) {
            problems.push('missing text "' + form.expectText + '"');
          }
        }
      }
    }
  } catch (err) {
    problems.push(String(err.message).split('\n')[0].slice(0, 160));
  }

  ms = Date.now() - started;
  if (!problems.length && ms > SLOW_MS) problems.push('Slow (' + (ms / 1000).toFixed(1) + 's)');

  // A console error alone is not a failure - plenty of healthy pages log noise from
  // analytics and third-party embeds. It is recorded for context only.
  const state = blocked ? 'blocked'
              : problems.length ? (rendered && status && status < 400 ? 'degraded' : 'down')
              : 'up';

  results.push({
    id: form.id,
    name: form.name,
    brand: form.brand,
    division: form.division,
    url: form.url,
    finalUrl,
    state,
    status: status || 0,
    ms,
    rendered,
    fieldsChecked: (form.requiredFields || []).length,
    fieldsMissing: detail.missingFields.length,
    selectCounts: detail.selectCounts,
    consoleErrors: consoleErrors.length,
    reason: problems.join('; '),
  });

  console.log('  [' + (state === 'up' ? 'OK  ' : state.toUpperCase().padEnd(4)) + '] ' +
              form.id.padEnd(20) + ms + 'ms' + (problems.length ? '  - ' + problems.join('; ') : ''));

  await context.close();
}

await browser.close();

// ---------------------------------------------------------------- persist
const nowIso = new Date().toISOString();
const counts = { up: 0, degraded: 0, down: 0, blocked: 0 };
for (const r of results) counts[r.state]++;

writeJson(join(DATA, 'forms.json'), {
  generatedAt: nowIso,
  total: results.length,
  ...counts,
  forms: results,
});

// Rolling window of load times, same column-oriented shape as recent.json.
const recent = readJson(join(DATA, 'forms-recent.json'), { points: [], series: {} });
recent.points.push(nowIso);
for (const r of results) {
  if (!recent.series[r.id]) recent.series[r.id] = [];
  recent.series[r.id].push(r.state === 'down' || r.state === 'blocked' ? null : r.ms);
}
const overflow = recent.points.length - RECENT_POINTS;
if (overflow > 0) recent.points = recent.points.slice(overflow);
const live = new Set(results.map(r => r.id));
for (const k of Object.keys(recent.series)) {
  if (!live.has(k)) { delete recent.series[k]; continue; }
  const pad = recent.points.length - recent.series[k].length;
  if (pad > 0) recent.series[k] = Array(pad).fill(null).concat(recent.series[k]);
  if (recent.series[k].length > recent.points.length) {
    recent.series[k] = recent.series[k].slice(-recent.points.length);
  }
}
recent.updatedAt = nowIso;
writeJson(join(DATA, 'forms-recent.json'), recent);

console.log('Forms: ' + counts.up + ' ok, ' + counts.degraded + ' degraded, ' +
            counts.down + ' down, ' + counts.blocked + ' blocked');

if (counts.down > 0 && process.env.FAIL_ON_DOWN === 'true') process.exitCode = 1;

# ADvTECH Website Status

Continuous availability, performance and TLS certificate monitoring for the 37
ADvTECH web properties — running entirely on GitHub, with a public status page
anyone can open without a licence or a login.

> **Live dashboard:** https://amitka2222.github.io/website-status/

## How it works

Three GitHub features, no servers and no third-party services:

```
GitHub Actions (cron)  ──►  scripts/probe.mjs  ──►  commits docs/data/*.json
      the scheduler          the prober              the database (git history)
                                                              │
                                                              ▼
                                                    GitHub Pages ──► docs/index.html
                                                                     the dashboard
```

1. **Actions** wakes on a schedule and runs the prober.
2. **`probe.mjs`** checks all 37 sites in parallel using only the Node standard
   library — nothing to install, nothing to keep patched.
3. Results are **committed back to the repo**, so git history *is* the time-series
   database. Every check is a commit you can diff.
4. **Pages** serves `docs/` as a static site. The dashboard reads the JSON and
   re-fetches every 60 seconds.

## What gets checked

Per site, per run: HTTP status, response time, the full redirect chain and final
URL, page size, TLS certificate expiry / issuer / validity, and an optional
content check.

Each result is classified:

| State | Meaning |
| --- | --- |
| **Up** | HTTP 2xx/3xx, responded promptly, certificate healthy |
| **Degraded** | Reachable, but slow (>3s), or certificate expiring within 21 days, or the content check failed |
| **Down** | HTTP 4xx/5xx, or no response at all |

Failed requests are retried once before being recorded as Down, so one dropped
packet doesn't invent an outage.

## Cadence and cost — read before changing the schedule

The workflow is set to **every 5 minutes**, which is GitHub's minimum and is free
because this repository is public. If it is ever made private, that becomes
billable and the schedule must be relaxed:

| Repo | Actions minutes | Practical cadence |
| --- | --- | --- |
| **Public** | Free and unlimited | `*/5` — GitHub's minimum |
| **Private, Free plan** | 2,000 min/month | `*/30` at most |
| **Private, Team plan** | 3,000 min/month | `*/15` (~2,880 min/month — close to the cap) |
| **Private, Enterprise** | 50,000 min/month | `*/5` comfortably |

Each run bills as a **whole minute** even though the probe itself takes about
5 seconds, so the maths is simply *runs per month*. At `*/5` that's ~8,640
minutes a month — fine on a public repo, expensive on a private one.

To change it, edit the `cron` line in
[`.github/workflows/monitor.yml`](.github/workflows/monitor.yml).

**Two things about GitHub's scheduler worth knowing:**

- `cron` is **best-effort, and in practice much slower than it looks**. This repo
  asks for `*/5`. Measured over the first 20 scheduled runs, GitHub actually
  delivered a check every **36–72 minutes**, averaging around 54. GitHub throttles
  frequent schedules on public repositories, and no cron expression changes that —
  asking for `*/1` would not help.

  So treat the schedule as *roughly hourly*, not 5-minutely. This is fine for
  trend and certificate monitoring; it is **not** a pager and must not be relied
  on to catch a short outage. If you need genuinely continuous probing, the
  options are an in-job loop (one workflow run that probes every 5 minutes for
  ~50 minutes before exiting) or an external service such as UptimeRobot.
  The dashboard measures the real interval and sizes its staleness warning off
  that, so it stays honest either way.
- Scheduled workflows are **disabled after 60 days of repository inactivity** —
  but because each run commits its results, the repo never goes inactive and the
  schedule sustains itself.

## The staleness guard

The dashboard's most important feature is the one that admits when it's broken.
If the workflow stops running, a monitoring page full of green is worse than no
page at all — it reports "everything is fine" when the truth is "nobody is
looking".

So the dashboard measures the gap since the last successful check against the
observed check interval, and if it exceeds 3× that interval it shows a red
**"Data is stale"** banner over everything else. Trust the green only when that
banner is absent.

## Adding or removing a site

Edit [`sites.csv`](sites.csv) — it's the only file you need to touch:

```csv
Site,Url,Brand,Division,ExpectedText
newsite.co.za,https://www.newsite.co.za/,New Brand,Schools,
```

Committing it triggers an immediate re-check (the workflow watches that path).
Removing a row also drops its history from the rolling window.

### Sites deliberately not monitored

Four ADvTECH domains are **redirects to other properties**, not sites in their own
right, so they are excluded rather than counted as separate estate entries:

| Domain | Redirects to |
| --- | --- |
| `advtech.co.za` | `groupadvtech.com` |
| `iiemsa.co.za` | `emeris.ac.za` |
| `varsitycollege.co.za` | `emeris.ac.za` |
| `vegaschool.com` | `emeris.ac.za/faculty/vega-school` |

The destinations (`groupadvtech.com`, `emeris.ac.za`) are monitored, so an outage
still shows up. What this does *not* catch is one of the redirects themselves
breaking — if that matters, add the domain back and it will be flagged in the
Detail column whenever its final URL changes.

The optional **`ExpectedText`** column guards against "soft" failures — pages
that return HTTP 200 while actually being broken. Put a string that should always
be on the homepage (e.g. `Apply Now`); if it disappears the site is flagged
Degraded even though the status code looks healthy. Leave blank to skip.

## Running it locally

```bash
node scripts/probe.mjs
```

Then serve the dashboard (it fetches JSON, so `file://` won't work):

```bash
python -m http.server 8787 --directory docs
```

## Data files

| File | Contents |
| --- | --- |
| `docs/data/status.json` | Latest run — one entry per site |
| `docs/data/recent.json` | Rolling 288-check window, column-oriented for the sparklines |
| `docs/data/daily/YYYY-MM.json` | Per-site daily aggregates: checks, uptime, avg, p95, max |
| `docs/data/incidents.json` | Outage log — opens on first failure, closes on recovery |

All four are deliberately bounded, so the repo doesn't grow without limit. The
rolling window is ~100 KB at full size; daily aggregates are a few KB per month.

## Tuning thresholds

Constants at the top of [`scripts/probe.mjs`](scripts/probe.mjs):

| Constant | Default | Meaning |
| --- | --- | --- |
| `TIMEOUT_MS` | 30000 | Per-request timeout |
| `CONCURRENCY` | 10 | Parallel checks |
| `SLOW_MS` | 8000 | Degraded threshold (set for US-runner latency, see below) |
| `CERT_WARN_DAYS` | 21 | Certificate warning window |
| `RETRIES` | 1 | Retries before recording Down |
| `RECENT_POINTS` | 288 | Sparkline window length |

Set the repository variable `FAIL_ON_DOWN` to `true` to make the Actions run go
red when a site is down — GitHub then emails whoever watches the repo. That's the
cheapest alerting available here.

## Form monitoring

Six application and enquiry forms are checked separately, by
[`scripts/probe-forms.mjs`](scripts/probe-forms.mjs), configured in
[`forms.json`](forms.json) and scheduled by
[`.github/workflows/forms.yml`](.github/workflows/forms.yml).

| Form | URL |
| --- | --- |
| Emeris — Undergraduate application | `portal.emeris.ac.za/application/undergrad-contact/application` |
| Emeris — Programme enquiry | `www.emeris.ac.za/enquiry` |
| Rosebank International — Application (step 1) | `portal.rbi.ac.za/application/application-form` |
| Rosebank International — Enquiry | `www.rbi.ac.za/enquiry/` |
| Capsicum — Programme enquiry | `portal.capsicumcooking.com/enquiry` |
| Capsicum — Student signup | `student.capsicumcooking.com/signup/` |

### These forms are never submitted

The checks **load and inspect** each form. They do not fill it in and do not
submit it. Submitting on a schedule would file real enquiries and applications
into the admissions systems — at half-hourly checks that is nearly 300 fake leads
a day, landing in front of the people who chase them. Do not add a submit step.

### Why this needs a real browser

A plain HTTP fetch cannot tell whether these forms work:

- `www.emeris.ac.za/enquiry` returns **HTTP 200 with every dropdown empty** — the
  options arrive by API afterwards.
- `student.capsicumcooking.com/signup/` is an **Angular app**. Its HTML contains
  no form at all; the entire thing is built by JavaScript after the bundle boots.

So the form checks run headless Chromium via Playwright. That is also why they sit
in their own workflow on a **30-minute** cadence — a browser run takes about a
minute against the site check's five seconds, and keeping them separate means the
heavier job can never delay or break the 5-minute availability check.

### What is checked

1. **The page loads** — HTTP status and navigation succeed.
2. **The form renders** — the `waitFor` selector appears within 20s.
3. **The fields a person needs are present** — every selector in `requiredFields`.
4. **The campus dropdown carries real options** — not just a placeholder. An empty
   campus list is a broken form that still returns 200 and looks perfectly healthy.
5. **Expected copy is on the page** — where `expectText` is set.

Console errors are recorded for context but do **not** fail a check; healthy pages
routinely log noise from analytics and third-party embeds.

### What is not yet covered

**Qualification dropdowns.** On every one of these forms the qualification list is
empty until a year and a campus have been chosen, and the required sequence
differs per site — RBI needs *intake year → campus*, Emeris needs *registration
type → mode of delivery → intake year → campus*. Each step is an API round-trip,
so the checks are timing-sensitive and easy to make flaky.

That matters, because a dead qualification feed is arguably the worst failure of
all: the form looks fine and nobody can apply. It is deliberately left out for now
rather than shipped as a check that cries wolf. `probe-forms.mjs` is structured to
take a `cascade` block per form when it is worth doing properly.

**Submission is never verified.** That the form renders does not prove a
submission reaches the admissions system. Only a real submission proves that, and
that is not something to automate.

## Adding API checks later

The prober is already structured for it: `checkSite()` takes a row and returns a
result object. Extending to APIs means adding columns to `sites.csv`
(`Method`, `Body`, `ExpectStatus`, `ExpectJsonPath`) and a branch in
`checkSite()` — the dashboard, aggregation, incident log and staleness guard all
work unchanged.

**Do not put credentials in `sites.csv`.** Authenticated endpoints must read
tokens from GitHub Actions **secrets** via `process.env`, referenced from the
workflow. A secret committed to the repo is a secret published to the internet if
the repo is public — and still exposed to everyone with read access if it isn't.

## Limitations

- **Single vantage point.** Checks run from a GitHub-hosted runner (Azure, mostly
  US East). This measures "can a datacentre in the US reach the site", not "can a
  parent in Johannesburg reach the site". Latency figures are inflated relative to
  local users, and a regional routing problem in South Africa may not show up at all.

  This is not theoretical: from a runner these sites answer in a median of 2.1s
  (p90 4.5s) against roughly 0.8s measured locally. `SLOW_MS` is set to 8000 to
  suit that vantage point. **Treat response times as a trend line, not an
  absolute** — what matters is a site getting slower than its own normal, not the
  raw number. If you need figures that reflect real user experience, the check has
  to run from South Africa.
- **Not a pager.** Cron delays mean detection latency is tens of minutes, not
  seconds. For genuine on-call alerting you want a purpose-built service —
  UptimeRobot, Better Stack or Azure Application Insights availability tests.
- **Homepage only.** Each site is checked at its root URL. Add deeper pages as
  extra rows if you need them covered.
- **Downtime is estimated**, at a resolution of one check interval.

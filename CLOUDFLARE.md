# Moving the dashboard to Cloudflare Pages

Goal: repository **private**, dashboard reachable only by Advtech staff, and the
three "run a check now" buttons working for people who have no GitHub account.

Everything in the repo is already written for this. What follows is the part
only you can do — it needs your Cloudflare and GitHub accounts.

Roughly 30 minutes. Do the steps in order; step 6 is the one that actually
closes the public hole, so don't stop before it.

---

## Before you start — two things to be clear about

**Going private does not un-publish what is already out there.** This repository
has been public for weeks. Anyone who cloned or forked it still has the endpoint
inventory, and search engines may have indexed it. Treat the URLs in `apis.json`
— including the payment and login endpoints in `doNotProbe` — as already
disclosed. Making it private stops *further* exposure; it does not undo the
existing exposure.

**This will sit on a personal Cloudflare account.** That was a deliberate
decision, but it means Advtech monitoring and Advtech staff SSO run through a
tenant the company does not own or control. If you leave, or the account is
lost, the dashboard and its access policy go with it. Worth revisiting once
there is an Advtech-owned Cloudflare account — the migration is re-pointing the
Pages project and rebuilding the Access policy, not rewriting anything here.

---

## 1. Create the GitHub token

The Pages Functions use this to read data from the private repo and to start
workflows. Make it **fine-grained** and scope it to this one repository.

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token

| Setting | Value |
| --- | --- |
| Repository access | Only select repositories → `website-status` |
| Contents | **Read-only** |
| Actions | **Read and write** |
| Expiration | 90 days (diarise the renewal — the dashboard breaks silently when it lapses) |

Copy the token. You cannot see it again.

> Nothing else needs `write`. If the token leaks, the blast radius is reading
> this repo and starting its workflows — not your account.

## 2. Make the repository private

GitHub → repo → Settings → General → Danger Zone → **Change repository visibility** → Private.

Your Actions minutes now become billable. Measured over a real week this runs
about **630 minutes a month**, against **2,000 free** on the Free plan, so there
is comfortable headroom. Keep an eye on it under Settings → Billing if you ever
raise the check frequency.

## 3. Create the Pages project

Cloudflare dashboard → **Workers & Pages** → Create → **Pages** → Connect to Git
→ authorise GitHub → pick `website-status`.

Build settings — the important ones:

| Setting | Value |
| --- | --- |
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | `docs` |
| Root directory | `/` |

There is no build step: the dashboard is a single HTML file. Cloudflare picks up
`/functions` automatically and deploys them alongside it.

## 4. Add the environment variables

Pages project → Settings → **Environment variables**. Add all three to
**Production** *and* **Preview**:

| Name | Value | Type |
| --- | --- | --- |
| `GITHUB_REPO` | `amitka2222/website-status` | Plaintext |
| `GITHUB_BRANCH` | `main` | Plaintext |
| `GITHUB_TOKEN` | the token from step 1 | **Secret** (encrypt it) |

Redeploy after adding them — variables are read at request time, but the first
deployment was built without them.

## 5. Put Cloudflare Access in front

This is the step that makes it private. Without it the `.pages.dev` URL is
world-readable, and `/api/run` is an open trigger for anyone who finds it.

Cloudflare **Zero Trust** → Settings → Authentication → add **Azure AD / Entra ID**
as an identity provider (you will need an app registration in Advtech's Entra
tenant — client ID, client secret, directory ID).

Then Zero Trust → Access → **Applications** → Add an application → **Self-hosted**:

| Setting | Value |
| --- | --- |
| Application domain | your `<project>.pages.dev` (or the custom domain) |
| Session duration | 24 hours |
| Policy name | `Advtech staff` |
| Action | Allow |
| Include | Emails ending in `@groupadvtech.com` |

Free for up to 50 users.

> If Entra federation is blocked or slow to arrange, a one-time PIN policy on the
> same email domain works immediately and can be swapped for SSO later.

## 6. Turn off GitHub Pages

**Do not skip this.** Until you do, the old public URL keeps serving the whole
dashboard — every URL, every endpoint — regardless of what Cloudflare is doing.

GitHub → repo → Settings → **Pages** → Source → **None**.

Then confirm `https://amitka2222.github.io/website-status/` returns 404.

## 7. Custom domain (optional)

Pages project → Custom domains → add e.g. `status.advtech.co.za`. You will need a
CNAME from whoever runs that DNS zone.

If you use a custom domain, uncomment this line near the top of
[`docs/index.html`](docs/index.html) so the page knows to use the Functions:

```html
<meta name="deployment" content="cloudflare">
```

The page auto-detects `*.pages.dev`, but a custom domain has no such tell.

---

## Checking it worked

1. Open the Pages URL in a private window — Access should challenge you.
2. Sign in. The dashboard loads.
3. Open dev tools → Network. The JSON should come from **`/api/data/status.json`**,
   not `data/status.json`, with an `x-data-source: github-api` header.
4. Press **Run a check now → APIs**. You should get *"APIs check queued"* rather
   than a new GitHub tab. Within a minute or two the API timestamps update.
5. Check the Pages **Deployments** tab after a day: you should see only a handful
   of builds, not one per check.

That last point matters. The result commits carry `[skip ci]`, which Cloudflare
treats as "do not build" — that is why data arrives through the Function instead
of a rebuild. If you *do* see a build per check, the free allowance (500/month)
will run out in about five weeks, and the fix is to confirm the skip token is
being honoured before anything else.

## How the pieces fit

```
GitHub Actions ──► commits results to the private repo  ("[skip ci]": no rebuild)
                                  │
Cloudflare Pages ─ serves docs/ ──┤
       │                          │
       ├─ /api/data/*  ──────────►┴─ reads the private repo via the GitHub API
       │                             (edge-cached 30s, allowlisted filenames)
       └─ /api/run     ───────────►  starts a workflow, token stays server-side
                    ▲
        Cloudflare Access (Entra SSO) gates all of the above
```

## If something breaks

| Symptom | Cause |
| --- | --- |
| Dashboard loads but every panel is empty | `GITHUB_TOKEN` missing, expired, or lacking Contents:read. Check the Function logs in the Pages project. |
| Buttons open GitHub instead of queueing | The page did not detect Cloudflare — add the `deployment` meta tag (step 7). |
| Buttons return 502 | Token lacks **Actions: read and write**. |
| Buttons return 429 | Working as intended — one run per component per 45 seconds. |
| Anyone can open the URL | Access is not applied to that hostname. A custom domain needs its own Access application. |

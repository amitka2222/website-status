// Starts a check on demand, for the three buttons on the dashboard.
//
// This is the piece a static page cannot do for itself: triggering a workflow
// needs a GitHub token, and a token shipped to the browser is a published
// token. Here the token stays server-side as a Pages secret, so anyone who
// gets past Cloudflare Access can run a check without having a GitHub account
// or any access to the repository.
//
// Cloudflare Access is what authorises the caller. This function does not
// authenticate anyone itself - if the Pages project is ever served without
// Access in front of it, this endpoint becomes an open trigger. It is
// rate-limited below to blunt that, but Access is the actual control.

const COMPONENTS = {
  sites: { workflow: 'monitor.yml', inputs: { scope: 'sites' } },
  apis:  { workflow: 'monitor.yml', inputs: { scope: 'apis' } },
  forms: { workflow: 'forms.yml',   inputs: {} },
};

// A check takes a minute or two; there is no value in queueing them faster than
// that, and it stops a stuck page from hammering the Actions API.
const MIN_SECONDS_BETWEEN_RUNS = 45;
const lastRun = new Map();

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  const cfg = COMPONENTS[String(body && body.component)];
  if (!cfg) {
    return json({ error: 'component must be one of: ' + Object.keys(COMPONENTS).join(', ') }, 400);
  }

  const now = Date.now();
  const previous = lastRun.get(body.component) || 0;
  const wait = Math.ceil((MIN_SECONDS_BETWEEN_RUNS * 1000 - (now - previous)) / 1000);
  if (wait > 0) {
    return json({ error: `A ${body.component} check was just started. Try again in ${wait}s.` }, 429);
  }

  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const branch = env.GITHUB_BRANCH || 'main';
  if (!repo || !token) {
    return json({ error: 'GITHUB_REPO and GITHUB_TOKEN must be set on the Pages project' }, 500);
  }

  // Who asked, for the audit trail. Cloudflare Access puts the verified identity
  // in this header; it is absent if Access is not in front of the deployment.
  const who = request.headers.get('cf-access-authenticated-user-email') || 'unknown (no Access header)';

  let res;
  try {
    res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${cfg.workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'advtech-website-status-dashboard',
        },
        body: JSON.stringify({ ref: branch, inputs: cfg.inputs }),
      }
    );
  } catch (err) {
    return json({ error: 'Could not reach GitHub', detail: String(err.message) }, 502);
  }

  // workflow_dispatch returns 204 with no body on success.
  if (res.status !== 204) {
    const detail = await res.text();
    return json({ error: `GitHub returned ${res.status}`, detail: detail.slice(0, 300) }, 502);
  }

  lastRun.set(body.component, now);
  console.log(`run: ${body.component} (${cfg.workflow}) requested by ${who}`);

  return json({ ok: true, component: body.component, workflow: cfg.workflow, requestedBy: who });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

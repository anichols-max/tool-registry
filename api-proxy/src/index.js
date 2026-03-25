/**
 * Printfly API Proxy
 *
 * One URL for all AI APIs. Company keys stored as Worker secrets.
 * Tools call this instead of the real API — keys are injected automatically.
 *
 * Routes:
 *   /openai/*   → api.openai.com     (uses OPENAI_API_KEY secret)
 *   /anthropic/* → api.anthropic.com  (uses ANTHROPIC_API_KEY secret)
 *   /google/*    → generativelanguage.googleapis.com (uses GOOGLE_API_KEY secret)
 *   /fal/*       → fal.run            (uses FAL_API_KEY secret)
 *   /deploy      → auto-deploy files to Cloudflare Pages (uses CF_API_TOKEN + CF_ACCOUNT_ID)
 *
 * Add more routes as needed — just add to the ROUTES map.
 */

const ROUTES = {
  '/openai/': {
    target: 'https://api.openai.com/',
    secret: 'OPENAI_API_KEY',
    header: 'Authorization',
    prefix: 'Bearer ',
  },
  '/anthropic/': {
    target: 'https://api.anthropic.com/',
    secret: 'ANTHROPIC_API_KEY',
    header: 'x-api-key',
    prefix: '',
  },
  '/google/': {
    target: 'https://generativelanguage.googleapis.com/',
    secret: 'GOOGLE_API_KEY',
    header: null, // Google uses ?key= query param
    prefix: '',
  },
  '/fal/': {
    target: 'https://fal.run/',
    secret: 'FAL_API_KEY',
    header: 'Authorization',
    prefix: 'Key ',
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ status: 'ok', message: 'Printfly API Proxy', routes: [...Object.keys(ROUTES), '/deploy'] });
    }

    // Deploy endpoint — auto-publish files to Cloudflare Pages
    if (url.pathname === '/deploy' && request.method === 'POST') {
      return handleDeploy(request, env);
    }

    // Find matching route
    const route = Object.entries(ROUTES).find(([path]) => url.pathname.startsWith(path));
    if (!route) {
      return json({ error: 'Unknown route. Available: ' + Object.keys(ROUTES).join(', ') }, 404);
    }

    const [pathPrefix, config] = route;
    const apiKey = env[config.secret];
    if (!apiKey) {
      return json({ error: `${config.secret} not configured. Ask your admin to set it.` }, 500);
    }

    // Build target URL
    const targetPath = url.pathname.slice(pathPrefix.length);
    let targetUrl = config.target + targetPath + url.search;

    // Google uses query param for key
    if (config.header === null) {
      const sep = url.search ? '&' : '?';
      targetUrl += sep + 'key=' + apiKey;
    }

    // Forward the request
    const headers = new Headers(request.headers);
    if (config.header) {
      headers.set(config.header, config.prefix + apiKey);
    }
    // Remove host header so it doesn't conflict
    headers.delete('host');

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      });

      // Return response with CORS headers
      const respHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders())) {
        respHeaders.set(k, v);
      }

      return new Response(response.body, {
        status: response.status,
        headers: respHeaders,
      });
    } catch (err) {
      return json({ error: 'Proxy error: ' + err.message }, 502);
    }
  },
};

// ==================== DEPLOY TO CLOUDFLARE PAGES ====================

async function handleDeploy(request, env) {
  const apiToken = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return json({ error: 'Deploy not configured. Set CF_API_TOKEN and CF_ACCOUNT_ID secrets.' }, 500);
  }

  let data;
  try { data = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (!data.name || !data.files?.length) return json({ error: 'Need name and files array' }, 400);

  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 40) || 'tool';
  const auth = { 'Authorization': 'Bearer ' + apiToken };

  // Create Pages project (ignore 409 = already exists)
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slug, production_branch: 'main' }),
  });

  // Build multipart form with manifest + files
  const form = new FormData();
  const manifest = {};

  for (const file of data.files) {
    const bytes = new TextEncoder().encode(file.content);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const filePath = '/' + file.path;
    manifest[filePath] = hash;
    form.append(filePath, new Blob([bytes]), filePath);
  }

  form.append('manifest', JSON.stringify(manifest));
  form.append('branch', 'main');

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${slug}/deployments`,
    { method: 'POST', headers: auth, body: form }
  );

  const result = await resp.json();
  if (!resp.ok) {
    return json({ error: result.errors?.[0]?.message || 'Deploy failed', details: result.errors }, resp.status);
  }

  return json({ url: `https://${slug}.pages.dev`, deployUrl: result.result?.url, id: result.result?.id });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

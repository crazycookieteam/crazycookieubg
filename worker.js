/**
 * cookieubg.js — CookieUBG: a small arcade at the edge, plus a live room.
 *
 * One file, one fetch handler, zero dependencies, no bindings. Three
 * game catalogs — GN-Math (jsDelivr), UGS and Seraph — are normalized
 * by the worker, merged with GN-Math play counts, and cached at the
 * edge under /zones.json?source=…. Games play in an in-page overlay
 * with a direct-link escape hatch: index-hosted games come back as
 * text/plain and are fetched into srcdoc (GN-Math and UGS) while Seraph
 * URLs go straight into the frame.
 *
 * Chat is an HTTP polling room, not a websocket and not a Durable
 * Object. Worker isolates share no memory, so /chat/send appends to a
 * small JSON log in the edge cache and /chat/poll reads the tail. The
 * Cache API is shared across isolates in a data center and needs no
 * bindings; when it is unavailable the same shape lives in module
 * memory. The room keeps only the latest messages and expires on its
 * own. The browser keeps its own copy in localStorage so the sidebar
 * and history survive reloads. A four-card tour on first paint
 * introduces games, AI and chat.
 *
 * A minimal "New Tab" launcher is served at /; it links to the arcade
 * at /app. Both pages use the title "New Tab" and carry no favicon.
 *
 *   wrangler dev CrazyCookieUBG.js          # local preview
 *   wrangler deploy CrazyCookieUBG.js --name cookieubg
 */

const GN = {
  zones: 'https://cdn.jsdelivr.net/gh/freebuisness/assets@main/zones.json',
  covers: 'https://cdn.jsdelivr.net/gh/freebuisness/covers@main',
  html: 'https://cdn.jsdelivr.net/gh/freebuisness/html@main',
  stats: 'https://data.jsdelivr.com/v1/stats/packages/gh/freebuisness/html@main/files?period=year',
};

const UGS = {
  games: 'https://cdn.jsdelivr.net/gh/bubbls/ugs-singlefile@main/games.js',
  files: 'https://cdn.jsdelivr.net/gh/bubbls/ugs-singlefile@main/UGS-Files/',
};

const SERAPH = {
  games: 'https://rawcdn.githack.com/a456pur/seraph/ae2fcc6d6a9cd051654fcc0519080db1f79cf2a7/games/',
};

const CATALOG_TTL = 600; // seconds the GN-Math index lives at the edge
const CATALOG_TTL_LONG = 3600; // UGS and Seraph change less often

const CATALOGS = {
  gn: { label: 'GN-Math', ttl: CATALOG_TTL },
  ugs: { label: 'UGS', ttl: CATALOG_TTL_LONG },
  seraph: { label: 'Seraph', ttl: CATALOG_TTL_LONG },
};

const SECURITY_HEADERS = {
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'sameorigin',
};

const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E";

/* ---------------------------------------------------------------- catalog */

function resolveTemplate(str) {
  return str.replace('{COVER_URL}', GN.covers).replace('{HTML_URL}', GN.html);
}

function fileIdFromStat(name) {
  const m = /\/(\d+)/.exec(name || '');
  return m ? Number(m[1]) : null;
}

/**
 * Zones + play counts (top-100 files from jsDelivr's stats), normalized.
 * The discord pinned entry (negative ids) is not a game and gets dropped.
 */
async function fetchCatalog(env) {
  const zonesSource = (env && env.CATALOG_SOURCE) || GN.zones;

  const zonesRes = await fetch(zonesSource, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!zonesRes.ok) throw new Error('zones upstream ' + zonesRes.status);
  const rawZones = await zonesRes.json();

  const plays = new Map();
  try {
    const statsRes = await fetch(GN.stats, { signal: AbortSignal.timeout(8000) });
    if (statsRes.ok) {
      const files = await statsRes.json();
      if (Array.isArray(files)) {
        for (const f of files) {
          const id = fileIdFromStat(f && f.name);
          const hits = f && f.hits && f.hits.total;
          if (id !== null && Number.isFinite(hits)) {
            plays.set(id, Math.max(plays.get(id) ?? 0, hits));
          }
        }
      }
    }
  } catch {
    // popularity is garnish; the catalog stands without it
  }

  const zones = (Array.isArray(rawZones) ? rawZones : [])
    .filter(
      (z) =>
        z &&
        Number.isFinite(z.id) &&
        z.id >= 0 &&
        typeof z.name === 'string' &&
        z.name.length > 0 &&
        typeof z.url === 'string' &&
        z.url.length > 0,
    )
    .map((z) => ({
      id: z.id,
      name: z.name,
      url: resolveTemplate(String(z.url)),
      cover: typeof z.cover === 'string' ? resolveTemplate(z.cover) : null,
      author: typeof z.author === 'string' ? z.author : null,
      plays: plays.get(z.id) ?? null,
      srcdoc: true,
    }));

  if (!zones.length) throw new Error('index resolved to zero games');
  return { fetchedAt: new Date().toISOString(), zones };
}

const HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtml(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code.charAt(0) === '#') {
      const hex = code.charAt(1).toLowerCase() === 'x';
      const num = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : match;
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, ' ');
}

/**
 * UGS ships a bare JavaScript array of HTML file names. Each game is served
 * as text/plain from jsDelivr, so the player injects it via srcdoc.
 */
async function fetchUgsCatalog() {
  const res = await fetch(UGS.games, {
    headers: { accept: 'text/javascript, text/plain, */*' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('UGS upstream ' + res.status);
  const text = await res.text();

  const list = /(?:let|const|var)\s+files\s*=\s*\[([\s\S]*?)\]\s*;/i.exec(text);
  if (!list) throw new Error('UGS file list not found');

  const names = [];
  const quoted = /"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = quoted.exec(list[1]))) {
    const raw = match[1].replace(/\\(["'\\])/g, '$1');
    if (!/^cl[0-9a-z]/i.test(raw)) continue; // the page hides utility entries
    names.push(raw);
  }
  if (!names.length) throw new Error('UGS list empty');

  const seen = new Set();
  const zones = [];
  for (const raw of names) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const name = raw.replace(/^cl/i, '').replace(/_+/g, ' ').trim();
    if (!name) continue;
    const file = raw.lastIndexOf('.') > raw.lastIndexOf('/') ? raw : raw + '.html';
    zones.push({
      id: 'ugs:' + raw,
      name,
      url: UGS.files + encodeURIComponent(file),
      cover: null,
      plays: null,
      srcdoc: true,
    });
  }

  if (!zones.length) throw new Error('UGS games empty');
  return { fetchedAt: new Date().toISOString(), zones };
}

/**
 * Seraph's games page is a static HTML index: anchors wrap a game card with
 * a background-image thumbnail and an h2 name. Resolve relative links
 * against the pinned games directory so both the game and its cover work.
 */
async function fetchSeraphCatalog() {
  const res = await fetch(SERAPH.games, {
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Seraph upstream ' + res.status);
  const html = await res.text();

  const card = /<a\b[^>]*\bhref="([^"]+)"[^>]*>\s*<div\b[^>]*class="button"[^>]*style="background-image:\s*url\('([^']*)'\);"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const seen = new Set();
  const zones = [];
  let match;
  while ((match = card.exec(html))) {
    const href = decodeHtml(match[1]).trim();
    if (!href || href.charAt(0) === '#' || /^(?:[a-z]+:)?\/\//i.test(href)) continue;

    let url;
    try {
      url = new URL(href, SERAPH.games);
    } catch {
      continue;
    }
    if (!url.href.startsWith(SERAPH.games) || seen.has(url.href)) continue;
    seen.add(url.href);

    const name = decodeHtml(stripTags(match[3])).replace(/\s+/g, ' ').trim();
    if (!name) continue;

    let cover = decodeHtml(match[2]).trim();
    if (cover) {
      try {
        cover = new URL(cover, SERAPH.games).href;
      } catch {
        cover = null;
      }
    } else {
      cover = null;
    }

    zones.push({
      id: 'seraph:' + url.href.slice(SERAPH.games.length),
      name,
      url: url.href,
      cover,
      plays: null,
      srcdoc: false,
    });
  }

  if (!zones.length) throw new Error('Seraph index empty');
  return { fetchedAt: new Date().toISOString(), zones };
}

const cacheAvailable = typeof caches !== 'undefined' && !!caches.default;

async function catalogResponse(request, env, ctx) {
  const requested = new URL(request.url).searchParams.get('source') || 'gn';
  const source = Object.prototype.hasOwnProperty.call(CATALOGS, requested) ? requested : 'gn';
  const meta = CATALOGS[source];
  const cache = cacheAvailable ? caches.default : null;
  const cacheKey = new Request('https://cookieubg.catalog/v2/' + source);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    let catalog;
    if (source === 'ugs') catalog = await fetchUgsCatalog();
    else if (source === 'seraph') catalog = await fetchSeraphCatalog();
    else catalog = await fetchCatalog(env);

    catalog.source = source;
    catalog.label = meta.label;

    const res = new Response(JSON.stringify(catalog), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=' + meta.ttl,
      },
    });
    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return res;
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: String(err),
        source,
        label: meta.label,
        fetchedAt: new Date().toISOString(),
        zones: [],
      }),
      {
        status: 502,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=30',
        },
      },
    );
  }
}

/* ------------------------------------------------------------------- chat */

/**
 * Chat without Durable Objects.
 *
 * Cloudflare gives a Worker no shared memory between isolates, so a
 * module-level room or a websocket pump only reaches whoever happens to
 * land on the same isolate. Instead the room lives in the edge cache:
 * /chat/send appends to a small JSON log, /chat/poll reads the tail and
 * updates a presence stamp. The Cache API is shared by every isolate in
 * a data center and needs no bindings, so the room works in production
 * on Cloudflare with a plain Worker. If the cache is unavailable (local
 * file, a non-Worker host), the same shape lives in module memory so
 * the endpoints keep working for the life of the process.
 *
 * The room is deliberately ephemeral: the cache entry carries a short
 * TTL, only the latest messages are kept, and no accounts or cookies
 * are involved. The browser keeps its own copy in localStorage.
 */

const CHAT = {
  ttl: 60 * 60, // seconds the room may sit in the edge cache
  max: 120, // messages kept in the room
  nameCap: 24,
  textCap: 500,
  cooldownMs: 5000, // one accepted message per client every five seconds
  rateWindowMs: 10 * 60 * 1000, // prune rate stamps older than this
  onlineMs: 30000, // a poll this recent counts as present
  idCap: 80,
};

const CHAT_LOG_KEY = 'https://cookieubg.chat/log/v2';
const CHAT_PRESENCE_KEY = 'https://cookieubg.chat/presence/v2';
const CHAT_RATE_KEY = 'https://cookieubg.chat/rate/v2';
const CHAT_CACHE = typeof caches !== 'undefined' && !!caches.default;

const chatMemory = {
  log: { seq: 0, messages: [] },
  presence: {},
  rates: {},
};

const CHAT_ALLOW = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'retry-after',
};

async function chatLoad(key, fallback) {
  if (CHAT_CACHE) {
    try {
      const hit = await caches.default.match(new Request(key));
      if (hit) {
        const data = await hit.json();
        if (data && typeof data === 'object') return data;
      }
    } catch {
      /* fall through to memory */
    }
  }
  return fallback;
}

async function chatSave(key, value) {
  if (!CHAT_CACHE) return;
  try {
    await caches.default.put(
      new Request(key),
      new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=' + CHAT.ttl,
        },
      }),
    );
  } catch {
    /* memory still works for this isolate */
  }
}

function chatJson(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...CHAT_ALLOW,
      ...extra,
    },
  });
}

function chatClientId(value) {
  const raw = String(value || '').slice(0, CHAT.idCap);
  return /^[A-Za-z0-9:._-]+$/.test(raw) ? raw : '';
}

async function chatLog() {
  const data = await chatLoad(CHAT_LOG_KEY, null);
  if (!data || !Array.isArray(data.messages)) return chatMemory.log;
  data.seq = Number.isFinite(data.seq) ? data.seq : 0;
  if (chatMemory.log.seq > data.seq) return chatMemory.log; // cache went stale
  chatMemory.log = data;
  return data;
}

async function chatPresence() {
  const stored = await chatLoad(CHAT_PRESENCE_KEY, null);
  const data = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  for (const key of Object.keys(chatMemory.presence)) {
    if (!Number.isFinite(data[key]) || chatMemory.presence[key] > data[key]) {
      data[key] = chatMemory.presence[key];
    }
  }
  chatMemory.presence = data;
  return data;
}

async function chatRates() {
  const stored = await chatLoad(CHAT_RATE_KEY, null);
  const data = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  for (const key of Object.keys(chatMemory.rates)) {
    if (!Number.isFinite(data[key]) || chatMemory.rates[key] > data[key]) {
      data[key] = chatMemory.rates[key];
    }
  }
  chatMemory.rates = data;
  return data;
}

async function chatPoll(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CHAT_ALLOW });
  if (request.method !== 'GET') return chatJson({ error: 'GET required' }, 405);

  const url = new URL(request.url);
  const rawSince = Number(url.searchParams.get('since'));
  const since = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0;
  const client = chatClientId(url.searchParams.get('id')) || 'anon';

  const log = await chatLog();
  const presence = await chatPresence();
  const now = Date.now();

  presence[client] = now;
  for (const key of Object.keys(presence)) {
    if (!Number.isFinite(presence[key]) || now - presence[key] > CHAT.onlineMs) delete presence[key];
  }
  await chatSave(CHAT_PRESENCE_KEY, presence);

  const reset = since > log.seq;
  const after = reset ? 0 : since;
  const messages = log.messages.filter((m) => m && m.seq > after);

  return chatJson({
    messages,
    seq: log.seq,
    reset,
    online: Object.keys(presence).length,
  });
}

async function chatSend(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CHAT_ALLOW });
  if (request.method !== 'POST') return chatJson({ error: 'POST required' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return chatJson({ error: 'bad json' }, 400);
  }

  const rawText = typeof (body && body.text) === 'string' ? body.text : '';
  if (rawText.length > CHAT.textCap) {
    return chatJson({ error: 'message too long', max: CHAT.textCap }, 413);
  }

  const text = rawText.trim();
  if (!text) return chatJson({ error: 'empty message' }, 400);

  const name = (String((body && body.name) || '').trim() || 'anon').slice(0, CHAT.nameCap);
  const suppliedId = chatClientId(body && body.id);
  const suppliedClient = chatClientId(body && body.client);
  const id = suppliedId || 'srv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const rateKey = suppliedClient
    ? 'client:' + suppliedClient
    : 'ip:' + (request.headers.get('cf-connecting-ip') || 'anon');

  const log = await chatLog();
  const duplicate = log.messages.find((m) => m && m.id === id);
  if (duplicate) return chatJson({ message: duplicate, seq: log.seq });

  const now = Date.now();
  const rates = await chatRates();
  for (const key of Object.keys(rates)) {
    if (!Number.isFinite(rates[key]) || now - rates[key] > CHAT.rateWindowMs) delete rates[key];
  }
  const last = Number(rates[rateKey]);
  if (Number.isFinite(last) && now - last < CHAT.cooldownMs) {
    const retryAfter = Math.max(1, Math.ceil((CHAT.cooldownMs - (now - last)) / 1000));
    return chatJson({ error: 'slow down', retryAfter }, 429, {
      'retry-after': String(retryAfter),
    });
  }

  rates[rateKey] = now;
  chatMemory.rates = rates;
  await chatSave(CHAT_RATE_KEY, rates);

  const message = { id, seq: log.seq + 1, name, text, at: now };
  log.seq = message.seq;
  log.messages.push(message);
  if (log.messages.length > CHAT.max) log.messages.splice(0, log.messages.length - CHAT.max);

  chatMemory.log = log;
  await chatSave(CHAT_LOG_KEY, log);

  return chatJson({ message, seq: log.seq });
}

function notFoundResponse() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 — CookieUBG</title><style>
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f2ede3;
             font-family:ui-monospace,Menlo,Consolas,monospace; }
      .kicker { letter-spacing:.18em; text-transform:uppercase; font-size:11px; color:#b6471f; margin:0 0 1rem; }
      .msg { margin:0 0 1.5rem; font-size:14px; color:#71685a; }
      a { color:#191510; font-size:13px; }
      @media (prefers-color-scheme: dark) {
        body { background:#171310; }
        .msg { color:#99907e; } a { color:#ece5d6; }
      }
    </style></head><body><div style="text-align:center">
      <p class="kicker">404</p>
      <p class="msg">nothing lives at this path.</p>
      <a href="/">&larr; back to the arcade</a>
    </div></body></html>`,
    {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
    },
  );
}

/* -------------------------------------------------------------- launcher */

function renderLauncher() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New Tab</title>
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2ede3">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#171310">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; }

    :root {
      --paper: #f2ede3;
      --ink: #191510;
      --accent: #b6471f;
      --serif: "Instrument Serif", Georgia, "Times New Roman", serif;
      --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #171310;
        --ink: #ece5d6;
        --accent: #d96b3f;
      }
    }

    html { color-scheme: light dark; }

    body {
      min-height: 100vh;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 2rem;
      background: var(--paper);
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    ::selection { background: var(--accent); color: var(--paper); }

    .launcher {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: clamp(1.5rem, 4vh, 2.25rem);
      text-align: center;
    }

    .launcher h1 {
      font-family: var(--serif);
      font-size: clamp(2rem, 10vw, 5.5rem);
      font-weight: 400;
      line-height: 0.95;
      letter-spacing: -0.035em;
      text-wrap: balance;
    }

    .launch {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 9.5rem;
      padding: 0.9rem 2.4rem;
      border-radius: 999px;
      background: var(--ink);
      color: var(--paper);
      font-family: var(--mono);
      font-size: 0.6875rem;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      text-decoration: none;
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .launch:hover { background: var(--accent); transform: translateY(-1px); }
    .launch:active { transform: translateY(0); }

    .launch:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }

    @media (prefers-reduced-motion: reduce) {
      .launch { transition: none; }
    }
  </style>
</head>
<body>
  <main class="launcher">
    <h1>CrazyCookieUBG</h1>
    <a class="launch" href="/app">Launch</a>
  </main>
</body>
</html>`;
}

/* -------------------------------------------------------------- document */

function renderDocument(cf = {}, opts = {}) {
  const isStatic = !!opts.static;
  const banner = isStatic
    ? '<!-- CookieUBG — static build, generated from cookieubg.js by scripts/build-cookieubg.mjs.\n     Edit cookieubg.js, then rebuild so the two stay identical. -->\n'
    : '';

  return banner + `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New Tab</title>
  <meta name="description" content="CookieUBG — browser games, a resident AI and a live chat served from a single Cloudflare Worker. No accounts; your name and chats stay in your browser.">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2ede3">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#171310">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; }

    :root {
      --paper: #f2ede3;
      --card: #eae3d4;
      --ink: #191510;
      --muted: #71685a;
      --line: #d9d1c1;
      --accent: #b6471f;
      --good: #3f7f55;
      --sans: "Helvetica Neue", Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
      --serif: "Instrument Serif", Georgia, "Times New Roman", serif;
      --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
      --veil: rgba(242, 237, 227, 0.88);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #171310;
        --card: #1f1a14;
        --ink: #ece5d6;
        --muted: #99907e;
        --line: #302a21;
        --accent: #d96b3f;
        --good: #76b98c;
        --veil: rgba(23, 19, 16, 0.88);
      }
    }

    html { color-scheme: light dark; }

    body {
      height: 100vh;
      height: 100svh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: var(--paper);
      color: var(--ink);
      font-family: var(--sans);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    body::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 40;
      pointer-events: none;
      opacity: 0.05;
      mix-blend-mode: multiply;
      background-image: url("${GRAIN}");
    }

    @media (prefers-color-scheme: dark) {
      body::after { mix-blend-mode: screen; opacity: 0.035; }
    }

    ::selection { background: var(--accent); color: var(--paper); }

    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
      border-radius: 2px;
    }

    [hidden] { display: none !important; }

    .sr-only {
      position: absolute;
      width: 1px; height: 1px;
      padding: 0; margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    /* ------------------------------------------------------------ top bar */

    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: grid;
      /* minmax(0, 1fr) keeps both side tracks equal width, so the
         wordmark sits at the true center regardless of side content */
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      padding: 0.35rem clamp(1.25rem, 4vw, 2.75rem);
      background: var(--paper);
      border-bottom: 1px solid var(--line);
    }

    .topbar-nav { grid-column: 1; justify-self: start; display: flex; align-items: center; gap: 0.35rem; }

    .nav-btn {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 0.5rem 0.7rem;
      font-family: var(--mono);
      font-size: 0.6875rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      text-decoration: none;
      color: var(--muted);
      transition: color 0.2s ease;
    }

    .nav-btn:hover { color: var(--ink); }

    .nav-btn.active { color: var(--ink); }

    .nav-btn.active::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      margin-right: 0.5rem;
    }

    .wordmark {
      grid-column: 2;
      justify-self: center;
      font-family: var(--serif);
      font-size: 1.35rem;
      letter-spacing: 0.01em;
      color: var(--ink);
      text-decoration: none;
      white-space: nowrap;
    }

    .wordmark-dot { color: var(--accent); }

    @keyframes breathe {
      50% { opacity: 0.35; }
    }

    @media (max-width: 600px) {
      .nav-btn { font-size: 0.625rem; padding: 0.5rem 0.5rem; }
      .wordmark { font-size: 1.05rem; }
    }

    /* ------------------------------------------------------------- views */

    main {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .view { min-height: 0; }

    .games-view {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .games-inner {
      width: 100%;
      max-width: 78rem;
      margin-inline: auto;
      padding: clamp(1.5rem, 4vh, 2.5rem) clamp(1.25rem, 4vw, 2.75rem) clamp(2.5rem, 6vh, 4rem);
    }

    .app-view {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
    }

    /* games ----------------------------------------------------------- */

    .toolbar {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: flex-end;
      flex-wrap: wrap;
      gap: 0.9rem 1.5rem;
    }

    .games-count {
      flex: none;
      padding-bottom: 0.6rem;
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .toolbar-input {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--line);
      padding: 0.55rem 0;
      font-family: var(--mono);
      font-size: 0.8125rem;
      color: var(--ink);
    }

    .toolbar-input::placeholder { color: var(--muted); }
    .toolbar-input:focus { outline: none; border-bottom-color: var(--accent); }
    .toolbar-input::-webkit-search-cancel-button { -webkit-appearance: none; }

    .catalog-picker { position: relative; flex: none; }

    .catalog-button {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      min-height: 36px;
      padding: 0.4rem 0.65rem;
      border: 1px solid var(--line);
      background: var(--card);
      color: var(--ink);
      font-family: var(--mono);
      font-size: 0.6875rem;
      cursor: pointer;
      transition: border-color 0.2s ease;
    }

    .catalog-button:hover,
    .catalog-picker.is-open .catalog-button { border-color: var(--accent); }

    .catalog-value { font-size: 0.75rem; white-space: nowrap; }

    .catalog-chevron {
      width: 7px;
      height: 7px;
      border-right: 1px solid currentColor;
      border-bottom: 1px solid currentColor;
      color: var(--muted);
      transform: rotate(45deg) translateY(-1px);
      transition: transform 0.18s ease;
    }

    .catalog-picker.is-open .catalog-chevron { transform: rotate(-135deg); }

    .catalog-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 0.4rem);
      z-index: 25;
      width: min(18rem, calc(100vw - 2.5rem));
      padding: 0.25rem;
      border: 1px solid var(--line);
      background: var(--paper);
      box-shadow: 0 18px 40px rgba(23, 19, 16, 0.16);
    }

    .catalog-option {
      display: flex;
      align-items: center;
      width: 100%;
      padding: 0.7rem 0.75rem;
      border: 0;
      border-left: 2px solid transparent;
      background: transparent;
      color: var(--ink);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .catalog-option + .catalog-option { border-top: 1px solid var(--line); }

    .catalog-option:hover { background: var(--card); }

    .catalog-option:focus-visible {
      outline: 1px solid var(--accent);
      outline-offset: -3px;
      background: var(--card);
    }

    .catalog-option.is-active {
      border-left-color: var(--accent);
      background: var(--card);
    }

    .catalog-option-name {
      font-family: var(--sans);
      font-size: 0.875rem;
      font-weight: 500;
    }

    .zone-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 1.6rem 1.1rem;
      margin-top: 1.75rem;
    }

    @media (max-width: 640px) {
      .zone-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 1.4rem 0.9rem; }
    }

    .grid-state {
      grid-column: 1 / -1;
      font-family: var(--mono);
      font-size: 0.8125rem;
      color: var(--muted);
      padding: 3.5rem 0;
    }

    .grid-state.is-loading::after {
      content: "\u25AE";
      margin-left: 0.45rem;
      color: var(--accent);
      animation: blink 1.1s steps(2, start) infinite;
    }

    @keyframes blink {
      to { visibility: hidden; }
    }

    .card { display: block; text-decoration: none; color: inherit; }

    .card-cover {
      position: relative;
      aspect-ratio: 1;
      overflow: hidden;
      border: 1px solid var(--line);
      background: var(--card);
      transition: border-color 0.25s ease;
    }

    .card:hover .card-cover,
    .card:focus-visible .card-cover { border-color: var(--accent); }

    .card-cover img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      filter: saturate(0.9) contrast(1.02);
      transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), filter 0.35s ease;
    }

    .card:hover .card-cover img {
      transform: scale(1.045);
      filter: saturate(1.08) contrast(1.03);
    }

    .card-cover.noimg { display: grid; place-items: center; }

    .card-cover.noimg::after {
      content: attr(data-initial);
      font-family: var(--serif);
      font-size: 2.75rem;
      font-style: italic;
      color: var(--accent);
      opacity: 0.85;
    }

    .card-info {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      margin-top: 0.55rem;
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }

    .card-title {
      margin-top: 0.3rem;
      font-family: var(--serif);
      font-weight: 400;
      font-size: 1.0625rem;
      line-height: 1.3;
    }

    .card:hover .card-title {
      text-decoration: underline;
      text-decoration-color: var(--accent);
      text-decoration-thickness: 1.5px;
      text-underline-offset: 3px;
    }

    .catalog-foot {
      margin-top: 2.75rem;
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }

    /* chat apps ------------------------------------------------------- */

    .chat-app {
      position: relative;
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      overflow: hidden;
      background: var(--paper);
    }

    .chat-app[data-app="chat"] { grid-template-columns: minmax(0, 1fr); }

    .chat-sidebar {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      border-right: 1px solid var(--line);
      background: var(--card);
    }

    .sidebar-head {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.9rem 1rem;
      border-bottom: 1px solid var(--line);
    }

    .sidebar-title {
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .icon-btn {
      flex: none;
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      font-family: var(--mono);
      font-size: 1rem;
      line-height: 1;
      cursor: pointer;
    }

    .icon-btn:hover { border-color: var(--accent); color: var(--accent); }

    .thread-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      padding: 0.5rem;
    }

    .thread-item {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.62rem 0.65rem;
      border-left: 2px solid transparent;
      color: var(--ink);
      cursor: pointer;
    }

    .thread-item:hover { background: var(--paper); }

    .thread-item.is-active {
      background: var(--paper);
      border-left-color: var(--accent);
    }

    .thread-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 0.875rem;
    }

    .thread-meta {
      flex: none;
      font-family: var(--mono);
      font-size: 0.5625rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .thread-del {
      flex: none;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 1rem;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
    }

    .thread-item:hover .thread-del,
    .thread-item:focus-within .thread-del { opacity: 1; }
    .thread-del:hover { color: var(--accent); }

    @media (hover: none) {
      .thread-del { opacity: 0.65; }
    }

    .field-label {
      font-size: 0.5625rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .name-input {
      width: 100%;
      padding: 0.5rem 0.55rem;
      border: 1px solid var(--line);
      background: var(--paper);
      color: var(--ink);
      font-family: var(--mono);
      font-size: 0.75rem;
    }

    .name-input:focus { outline: none; border-color: var(--accent); }
    .name-input::placeholder { color: var(--muted); opacity: 0.7; }

    .chat-main {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: var(--paper);
    }

    .chat-top {
      flex: none;
      display: flex;
      align-items: center;
      gap: 0.7rem;
      min-height: 58px;
      padding: 0.5rem 1.1rem;
      border-bottom: 1px solid var(--line);
    }

    .sidebar-toggle {
      display: none;
      flex: none;
      width: 36px;
      height: 36px;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      font-size: 1rem;
      line-height: 1;
      cursor: pointer;
    }

    .sidebar-toggle:hover { border-color: var(--accent); color: var(--accent); }

    .chat-top-title {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      min-width: 0;
    }

    .chat-top-name {
      overflow: hidden;
      font-size: 0.9375rem;
      font-weight: 600;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .chat-settings-btn {
      flex: none;
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      min-height: 34px;
      padding: 0.35rem 0.6rem;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.5625rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
    }

    .chat-settings-btn:hover,
    .chat-settings-btn[aria-expanded="true"] {
      border-color: var(--accent);
      color: var(--accent);
    }

    .settings-dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--bubble, var(--accent));
      box-shadow: 0 0 0 1px var(--line);
    }

    .chat-settings {
      flex: none;
      padding: 0.85rem 1.1rem 0.95rem;
      border-bottom: 1px solid var(--line);
      background: var(--card);
    }

    .chat-settings-inner {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.85rem 2rem;
    }

    .settings-block {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
    }

    .settings-block.is-end {
      margin-left: auto;
      align-items: flex-end;
    }

    .settings-block .field-label { display: flex; align-items: baseline; }

    .settings-name { width: min(210px, 100%); }
    .settings-name .name-input { width: 100%; }

    .settings-check {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    .settings-check .check-mark {
      color: var(--good);
      font-size: 0.75rem;
      line-height: 1;
    }

    .settings-value {
      margin-left: 0.4rem;
      font-size: 0.5625rem;
      letter-spacing: 0.06em;
      text-transform: lowercase;
      color: var(--accent);
    }

    .bubble-swatches {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.55rem;
    }

    .bubble-swatch {
      width: 27px;
      height: 27px;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 50%;
      background: var(--swatch);
      cursor: pointer;
    }

    .bubble-swatch:hover { border-color: var(--ink); }

    .bubble-swatch.is-active {
      outline: 2px solid var(--ink);
      outline-offset: 2px;
    }

    .settings-action {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.04em;
      text-decoration: underline;
      text-underline-offset: 3px;
      cursor: pointer;
    }

    .settings-action:hover { color: var(--accent); }

    .settings-note {
      margin-top: 0.65rem;
      font-family: var(--mono);
      font-size: 0.5625rem;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    .chat-status {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-family: var(--mono);
      font-size: 0.5625rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .chat-status .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--muted);
    }

    .chat-status.is-on .dot { background: var(--good); }
    .chat-status.is-busy .dot {
      background: var(--accent);
      animation: breathe 1.1s ease-in-out infinite;
    }

    .message-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      padding: 1.25rem clamp(1rem, 3vw, 2rem);
      scrollbar-width: thin;
      scrollbar-color: var(--line) transparent;
    }

    .message-list::-webkit-scrollbar { width: 8px; }
    .message-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
    .message-list::-webkit-scrollbar-track { background: transparent; }

    .empty-state {
      max-width: 24rem;
      margin: auto;
      padding: 2rem 1rem;
      text-align: center;
    }

    .empty-state h2 {
      font-family: var(--serif);
      font-weight: 400;
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      line-height: 1.05;
      letter-spacing: -0.01em;
    }

    .empty-state p {
      margin-top: 0.6rem;
      font-size: 0.875rem;
      line-height: 1.6;
      color: var(--muted);
    }

    .msg {
      display: flex;
      flex-direction: column;
      align-self: flex-start;
      max-width: min(78%, 48rem);
      min-width: 0;
    }

    .msg.own { align-self: flex-end; align-items: flex-end; }

    .msg-meta {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      margin-bottom: 0.22rem;
      font-family: var(--mono);
      font-size: 0.5625rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .msg-name { color: var(--accent); }
    .msg.own .msg-name { color: var(--muted); }

    .msg-bubble {
      padding: 0.62rem 0.8rem;
      border: 1px solid var(--line);
      background: var(--card);
      color: var(--ink);
      font-size: 0.9375rem;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .msg.own .msg-bubble {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--paper);
    }

    .chat-app[data-app="chat"] .msg.own .msg-bubble,
    .chat-app[data-app="ai"] .msg.own .msg-bubble {
      border-color: var(--bubble, var(--accent));
      background: var(--bubble, var(--accent));
      color: var(--bubble-ink, var(--paper));
    }

    .msg.is-pending .msg-bubble { opacity: 0.6; }
    .msg.is-failed .msg-bubble { border-color: var(--accent); }

    .msg-fail {
      margin-top: 0.2rem;
      font-family: var(--mono);
      font-size: 0.5625rem;
      color: var(--accent);
    }

    .ai-cursor {
      display: inline-block;
      width: 0.55em;
      height: 1em;
      margin-left: 0.15em;
      vertical-align: text-bottom;
      background: var(--accent);
      animation: breathe 1.1s ease-in-out infinite;
    }

    .composer {
      flex: none;
      display: flex;
      align-items: flex-end;
      gap: 0.7rem;
      padding: 0.75rem clamp(1rem, 3vw, 1.5rem);
      padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
      border-top: 1px solid var(--line);
      background: var(--paper);
    }

    .composer-input {
      flex: 1;
      min-width: 0;
      min-height: 42px;
      max-height: 9rem;
      overflow-y: auto;
      resize: none;
      padding: 0.7rem 0.8rem;
      border: 1px solid var(--line);
      background: var(--card);
      color: var(--ink);
      font-family: var(--sans);
      font-size: 0.9375rem;
      line-height: 1.45;
    }

    .composer-input:focus { outline: none; border-color: var(--accent); }
    .composer-input::placeholder { color: var(--muted); opacity: 0.8; }
    .composer-input:disabled { opacity: 0.55; }

    .send-btn {
      flex: none;
      min-height: 42px;
      padding: 0.55rem 1rem;
      border: 1px solid var(--ink);
      background: var(--ink);
      color: var(--paper);
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background-color 0.2s ease, border-color 0.2s ease;
    }

    .send-btn:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); }
    .send-btn:disabled { opacity: 0.4; cursor: default; }

    .sidebar-scrim {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 15;
      padding: 0;
      border: 0;
      background: rgba(23, 19, 16, 0.35);
      cursor: pointer;
    }

    @media (max-width: 820px) {
      .chat-app { grid-template-columns: 230px minmax(0, 1fr); }
    }

    @media (max-width: 720px) {
      .chat-app { grid-template-columns: minmax(0, 1fr); }
      .chat-sidebar {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 20;
        width: min(82vw, 300px);
        border-right: 1px solid var(--line);
        transform: translateX(-102%);
        transition: transform 0.22s ease;
        box-shadow: 0 0 40px rgba(23, 19, 16, 0.18);
      }
      .chat-app.sidebar-open .chat-sidebar { transform: none; }
      .chat-app.sidebar-open .sidebar-scrim { display: block; }
      .sidebar-toggle { display: inline-flex; }
      .msg { max-width: 88%; }
    }

    @media (max-width: 560px) {
      .msg-meta { font-size: 0.5rem; }
      .msg-bubble { font-size: 0.9rem; }
      .chat-top { min-height: 52px; padding-inline: 0.8rem; }
      .chat-settings { padding-inline: 0.8rem; }
      .chat-settings-inner { align-items: flex-start; }
      .settings-block.is-end { margin-left: 0; align-items: flex-start; }
      .chat-settings-btn { padding: 0.35rem 0.5rem; }
    }

    /* tour ------------------------------------------------------------ */

    .tour {
      position: fixed;
      inset: 0;
      z-index: 70;
      display: grid;
      place-items: center;
      padding: 1.25rem;
      background: var(--veil);
      animation: veil 0.3s ease both;
    }

    @keyframes veil {
      from { opacity: 0; }
    }

    .tour-card {
      width: min(30rem, 100%);
      display: flex;
      flex-direction: column;
      border: 1px solid var(--line);
      background: var(--paper);
      box-shadow: 0 24px 60px rgba(23, 19, 16, 0.18);
    }

    .tour-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
      padding: 1.05rem 1.35rem 0;
    }

    .tour-kicker {
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .tour-progress {
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.16em;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }

    .tour-map {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.45rem 0.9rem;
      margin: 0.95rem 1.35rem 0;
      padding: 0.6rem 0.9rem;
      border: 1px solid var(--line);
      background: var(--card);
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .tour-map .is-here { color: var(--accent); }

    .tour-map .is-here::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      margin-right: 0.45rem;
    }

    .tour-body {
      padding: 1.15rem 1.35rem 0.5rem;
      min-height: 14.5rem;
    }

    .tour-title {
      font-family: var(--serif);
      font-weight: 400;
      font-size: clamp(1.9rem, 4.5vw, 2.4rem);
      line-height: 1.05;
      letter-spacing: -0.01em;
    }

    .tour-copy {
      margin-top: 0.8rem;
      font-size: 0.9375rem;
      line-height: 1.65;
      color: var(--muted);
    }

    .tour-copy strong { color: var(--ink); font-weight: 500; }

    .tour-copy .k {
      font-family: var(--mono);
      font-size: 0.8125rem;
      color: var(--ink);
    }

    .tour-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.35rem 1.25rem;
    }

    .tour-skip {
      background: transparent;
      border: none;
      min-height: 44px;
      padding: 0.5rem 0;
      font-family: var(--mono);
      font-size: 0.6875rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
      cursor: pointer;
      transition: color 0.2s ease;
    }

    .tour-skip:hover { color: var(--ink); }

    .tour-nav { display: flex; gap: 0.6rem; }

    .tour-btn {
      min-height: 44px;
      padding: 0.55rem 1.05rem;
      background: transparent;
      border: 1px solid var(--line);
      font-family: var(--mono);
      font-size: 0.6875rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--ink);
      cursor: pointer;
      transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
    }

    .tour-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
    .tour-btn:disabled { opacity: 0.4; cursor: default; }

    .tour-btn.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }

    .tour-btn.primary:hover:not(:disabled) {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--paper);
    }

    /* --------------------------------------------------------- player */

    body.is-playing { overflow: hidden; }

    .player {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      flex-direction: column;
      background: var(--paper);
    }

    .player-bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      padding: 0.45rem clamp(1rem, 3vw, 2rem);
      border-bottom: 1px solid var(--line);
    }

    .player-close {
      justify-self: start;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.8125rem;
      line-height: 1;
      cursor: pointer;
      transition: color 0.2s ease, background-color 0.2s ease, border-color 0.2s ease;
    }

    .player-close:hover {
      color: var(--paper);
      background: var(--accent);
      border-color: var(--accent);
    }

    .player-title {
      display: grid;
      justify-items: center;
      gap: 0.1rem;
      min-width: 0;
    }

    .player-kicker {
      font-family: var(--mono);
      font-size: 0.5625rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .player-name {
      max-width: 44vw;
      overflow: hidden;
      font-family: var(--serif);
      font-size: 1.125rem;
      line-height: 1.15;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .player-fallback {
      justify-self: end;
      font-family: var(--mono);
      font-size: 0.625rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .player-fallback:hover { color: var(--accent); }

    .player-stage {
      position: relative;
      flex: 1;
      min-height: 0;
    }

    .player-frame {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: var(--paper);
    }

    .player-loading {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      pointer-events: none;
      font-family: var(--mono);
      font-size: 0.6875rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .player-loading::after {
      content: "\u25AE";
      margin-left: 0.45rem;
      color: var(--accent);
      animation: blink 1.1s steps(2, start) infinite;
    }

    .player-stage.is-loaded .player-loading { display: none; }

    .player-note {
      position: absolute;
      top: clamp(1.5rem, 8vh, 4rem);
      left: 50%;
      transform: translateX(-50%);
      max-width: min(24rem, calc(100vw - 3rem));
      padding: 0.9rem 1.1rem;
      border: 1px solid var(--line);
      background: var(--paper);
      box-shadow: 0 16px 34px rgba(23, 19, 16, 0.14);
      font-family: var(--mono);
      font-size: 0.75rem;
      line-height: 1.65;
    }

    .player-note a {
      color: var(--accent);
      text-decoration: underline;
      text-underline-offset: 3px;
    }

    @media (max-width: 600px) {
      .player-kicker { display: none; }
      .player-name { max-width: 40vw; font-size: 1rem; }
      .player-fallback { font-size: 0.5625rem; letter-spacing: 0.1em; }
    }

    /* --------------------------------------------------------- motion */

    .rise {
      opacity: 0;
      transform: translateY(14px);
      animation: rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    .rise-1 { animation-delay: 0.05s; }
    .rise-2 { animation-delay: 0.15s; }
    .rise-3 { animation-delay: 0.25s; }
    .rise-4 { animation-delay: 0.35s; }

    @keyframes rise {
      to { opacity: 1; transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .rise { animation: none; opacity: 1; transform: none; }
      .ai-cursor { animation: none; }
      .chat-status.is-busy .dot { animation: none; }
      .chat-sidebar { transition: none; }
      .card-cover img { transition: none; }
      .player-close, .player-fallback { transition: none; }
      .player-loading::after { animation: none; }
      .tour { animation: none; }
    }
  </style>
</head>
<body${isStatic ? ' data-static="true"' : ''}>

  <header class="topbar">
    <nav class="topbar-nav" aria-label="Primary">
      <a href="#/games" class="nav-btn active" data-route="games" aria-current="page">Games</a>
      <a href="#/ai" class="nav-btn" data-route="ai">AI</a>
      <a href="#/chat" class="nav-btn" data-route="chat">Chat</a>
    </nav>
    <a class="wordmark" href="#/games">CookieUBG<span class="wordmark-dot">.</span></a>
  </header>

  <main>
    <section id="view-games" class="view games-view" aria-label="Games">
      <div class="games-inner">
        <div class="toolbar rise rise-1">
          <input id="zoneSearch" class="toolbar-input" type="search" placeholder="search games&hellip;" autocomplete="off" spellcheck="false" aria-label="Search games">
          <div class="catalog-picker" id="catalogPicker">
            <button id="catalogButton" class="catalog-button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="catalogMenu">
              <span id="catalogValue" class="catalog-value">GN-Math</span>
              <span class="catalog-chevron" aria-hidden="true"></span>
            </button>
            <div id="catalogMenu" class="catalog-menu" role="listbox" aria-label="Games catalog" hidden>
              <button class="catalog-option is-active" type="button" role="option" data-source="gn" aria-selected="true">
                <span class="catalog-option-name">GN-Math</span>
              </button>
              <button class="catalog-option" type="button" role="option" data-source="ugs" aria-selected="false">
                <span class="catalog-option-name">UGS</span>
              </button>
              <button class="catalog-option" type="button" role="option" data-source="seraph" aria-selected="false">
                <span class="catalog-option-name">Seraph</span>
              </button>
            </div>
          </div>
          <span id="gamesCount" class="games-count" role="status">loading&hellip;</span>
        </div>

        <div id="zoneGrid" class="zone-grid rise rise-2" role="list"></div>
        <p class="catalog-foot" id="catalogMeta"></p>
      </div>
    </section>

    <section id="view-ai" class="view app-view" aria-label="AI" hidden>
      <div class="chat-app" data-app="ai">
        <aside class="chat-sidebar" aria-label="AI chats">
          <div class="sidebar-head">
            <span class="sidebar-title">AI chats</span>
            <button id="aiNew" class="icon-btn" type="button" aria-label="New chat" title="New chat">+</button>
          </div>
          <div id="aiThreads" class="thread-list"></div>
        </aside>
        <div class="chat-main">
          <header class="chat-top">
            <button class="sidebar-toggle" type="button" data-sidebar-toggle aria-label="Show AI chats">&#9776;</button>
            <div class="chat-top-title">
              <span id="aiTitle" class="chat-top-name">New chat</span>
              <span id="aiState" class="chat-status" role="status"><span class="dot" aria-hidden="true"></span><span id="aiStateText">ready</span></span>
            </div>
            <button id="aiSettingsBtn" class="chat-settings-btn" type="button" aria-label="AI settings" aria-expanded="false" aria-controls="aiSettings">
              <span class="settings-dot" aria-hidden="true"></span><span class="settings-label">settings</span>
            </button>
          </header>
          <div id="aiSettings" class="chat-settings" hidden>
            <div class="chat-settings-inner">
              <div class="settings-block">
                <span class="field-label">your bubbles <span id="aiBubbleName" class="settings-value">ember</span></span>
                <div class="bubble-swatches" role="group" aria-label="Your AI bubble color">
                  <button class="bubble-swatch is-active" type="button" data-bubble="ember" style="--swatch: var(--accent)" aria-label="Ember" aria-pressed="true"></button>
                  <button class="bubble-swatch" type="button" data-bubble="ink" style="--swatch: #2a241d" aria-label="Ink" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="forest" style="--swatch: #345c45" aria-label="Forest" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="ocean" style="--swatch: #305d7a" aria-label="Ocean" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="plum" style="--swatch: #6e3c61" aria-label="Plum" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="gold" style="--swatch: #8a5a1e" aria-label="Gold" aria-pressed="false"></button>
                </div>
              </div>
              <div class="settings-block is-end">
                <span class="field-label">saved chats</span>
                <span class="settings-check"><span class="check-mark" aria-hidden="true">&#10003;</span> chats save in your browser</span>
                <button id="aiClearAll" class="settings-action" type="button">clear all chats</button>
              </div>
            </div>
            <p class="settings-note">no account, no sync.</p>
          </div>
          <div id="aiLog" class="message-list" role="log" aria-live="polite" aria-label="AI conversation"></div>
          <form id="aiForm" class="composer">
            <textarea id="aiInput" class="composer-input" rows="1" maxlength="6000" placeholder="Ask CrazyCookie AI&hellip;" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Ask CrazyCookie AI"></textarea>
            <button id="aiSend" class="send-btn" type="submit">Send</button>
          </form>
        </div>
        <button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close sidebar"></button>
      </div>
    </section>

    <section id="view-chat" class="view app-view" aria-label="Chat" hidden>
      <div class="chat-app" data-app="chat">
        <div class="chat-main">
          <header class="chat-top">
            <div class="chat-top-title">
              <span class="chat-top-name">Chat</span>
              <span id="chatLive" class="chat-status" role="status"><span class="dot" aria-hidden="true"></span><span id="chatLiveText">connecting&hellip;</span></span>
            </div>
            <button id="chatSettingsBtn" class="chat-settings-btn" type="button" aria-label="Chat settings" aria-expanded="false" aria-controls="chatSettings">
              <span class="settings-dot" aria-hidden="true"></span><span class="settings-label">settings</span>
            </button>
          </header>
          <div id="chatSettings" class="chat-settings" hidden>
            <div class="chat-settings-inner">
              <div class="settings-block settings-name">
                <label class="field-label" for="chatName">your name</label>
                <input id="chatName" class="name-input" type="text" maxlength="24" placeholder="anon" autocomplete="off" autocapitalize="off" spellcheck="false">
              </div>
              <div class="settings-block">
                <span class="field-label">your bubbles <span id="chatBubbleName" class="settings-value">ember</span></span>
                <div class="bubble-swatches" role="group" aria-label="Your bubble color">
                  <button class="bubble-swatch is-active" type="button" data-bubble="ember" style="--swatch: var(--accent)" aria-label="Ember" aria-pressed="true"></button>
                  <button class="bubble-swatch" type="button" data-bubble="ink" style="--swatch: #2a241d" aria-label="Ink" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="forest" style="--swatch: #345c45" aria-label="Forest" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="ocean" style="--swatch: #305d7a" aria-label="Ocean" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="plum" style="--swatch: #6e3c61" aria-label="Plum" aria-pressed="false"></button>
                  <button class="bubble-swatch" type="button" data-bubble="gold" style="--swatch: #8a5a1e" aria-label="Gold" aria-pressed="false"></button>
                </div>
              </div>
              <div class="settings-block is-end">
                <span class="field-label">local history</span>
                <button id="chatClear" class="settings-action" type="button">clear local history</button>
              </div>
            </div>
            <p class="settings-note">name, colors, and history save in this browser.</p>
          </div>
          <div id="chatLog" class="message-list" role="log" aria-live="polite" aria-label="Chat messages"></div>
          <form id="chatForm" class="composer">
            <textarea id="chatInput" class="composer-input" rows="1" maxlength="500" placeholder="Say something&hellip;" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Message" disabled></textarea>
            <button id="chatSend" class="send-btn" type="submit" disabled>Send</button>
          </form>
        </div>
      </div>
    </section>
  </main>

  <div id="player" class="player" role="dialog" aria-modal="true" aria-label="Game player" hidden>
    <div class="player-bar">
      <button id="playerClose" class="player-close" type="button" aria-label="Close game">&times;</button>
      <div class="player-title">
        <span class="player-kicker">now playing</span>
        <span id="playerName" class="player-name">&mdash;</span>
      </div>
      <a id="playerFallback" class="player-fallback" href="#" target="_blank" rel="noopener noreferrer">open directly&#8599;</a>
    </div>
    <div id="playerStage" class="player-stage">
      <iframe id="playerFrame" class="player-frame" title="Game" allow="autoplay; fullscreen; gamepad"></iframe>
      <div class="player-loading" aria-hidden="true">booting</div>
      <div id="playerNote" class="player-note" hidden>
        the game wouldn't load here &mdash; <a id="playerNoteLink" href="#" target="_blank" rel="noopener noreferrer">open it directly&#8599;</a>
      </div>
    </div>
  </div>

  <div id="tour" class="tour" role="dialog" aria-modal="true" aria-label="Welcome tour" hidden>
    <div class="tour-card">
      <div class="tour-head">
        <span class="tour-kicker" id="tourKicker">tour 01 &middot; hello</span>
        <span class="tour-progress" id="tourProgress">01 / 04</span>
      </div>
      <p class="tour-map" aria-hidden="true"><span data-map="home">cookieubg.</span><span>&middot;</span><span data-map="games">games</span><span>&middot;</span><span data-map="ai">ai</span><span>&middot;</span><span data-map="chat">chat</span></p>
      <div class="tour-body">
        <section class="tour-slide" data-step="0">
          <h2 class="tour-title">Three things live up here.</h2>
          <p class="tour-copy"><strong>CookieUBG</strong> is a shelf of games, a resident AI, and a live chat, served from one worker file. no accounts, no cookies &mdash; your chats and name stay in your browser.</p>
        </section>
        <section class="tour-slide" data-step="1" hidden>
          <h2 class="tour-title">Pick a game.</h2>
          <p class="tour-copy">pick a shelf &mdash; <strong>GN-Math, UGS or Seraph</strong> &mdash; then search it and click a cover. games open right here in an overlay: the small &times; top-left (or <span class="k">esc</span>) steps out, and a direct link sits in the bar if a game refuses to be framed.</p>
        </section>
        <section class="tour-slide" data-step="2" hidden>
          <h2 class="tour-title">Ask the resident.</h2>
          <p class="tour-copy"><strong>CrazyCookie AI</strong> lives in the AI tab. every conversation is saved in this browser only &mdash; start a new one from the sidebar, pick up an old thread, and use settings for bubble color or to clear everything.</p>
        </section>
        <section class="tour-slide" data-step="3" hidden>
          <h2 class="tour-title">Say something.</h2>
          <p class="tour-copy">open <strong>chat settings</strong> to set a name &mdash; it saves locally &mdash; then pick a bubble color and say hi. messages travel through a small polling room to everyone online, while your browser keeps the history.</p>
        </section>
      </div>
      <div class="tour-foot">
        <button id="tourSkip" class="tour-skip" type="button">skip tour</button>
        <div class="tour-nav">
          <button id="tourPrev" class="tour-btn" type="button" disabled>&larr; prev</button>
          <button id="tourNext" class="tour-btn primary" type="button">next &rarr;</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    (function () {
      'use strict';

      /* router — #/games, #/ai, #/chat and #/play/<id>; games is home */
      var ROUTES = ['games', 'ai', 'chat'];
      var PLAY_ROUTE = /^play\\/(.+)$/;
      var BASE_TITLE = document.title;

      function currentRoute() {
        return location.hash.replace(/^#\\/?/, '') || 'games';
      }

      function showView(route) {
        var known = ROUTES.indexOf(route) > -1 ? route : 'games';
        document.body.setAttribute('data-route', known);
        if (known === 'ai') aiStart();
        if (known === 'chat') chatStart();
        for (var i = 0; i < ROUTES.length; i++) {
          var key = ROUTES[i];
          document.getElementById('view-' + key).hidden = key !== known;
          var btn = document.querySelector('.nav-btn[data-route="' + key + '"]');
          if (btn) {
            btn.classList.toggle('active', key === known);
            if (key === known) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
          }
        }
        closeSidebars();
        window.scrollTo(0, 0);
        /* entering either room always lands on the newest message */
        if (known === 'ai') aiScroll(true);
        if (known === 'chat') chatScrollBottom();
      }

      function applyRoute() {
        var route = currentRoute();
        var playMatch = PLAY_ROUTE.exec(route);

        if (playMatch) {
          var playId = playMatch[1];
          try { playId = decodeURIComponent(playId); } catch (e) { /* keep raw */ }
          showView('games');

          var wanted = catalogForId(playId);
          if (wanted && wanted !== state.source) {
            state.pendingPlay = playId;
            loadCatalog(wanted);
            return;
          }

          if (!state.zones.length) { state.pendingPlay = playId; return; }
          var found = null;
          for (var i = 0; i < state.zones.length; i++) {
            if (String(state.zones[i].id) === playId) { found = state.zones[i]; break; }
          }
          if (found) openPlayer(found);
          else if (player.open) closePlayer(true);
          else location.replace('#/games');
          return;
        }

        showView(route);
        closePlayer(true);
      }

      window.addEventListener('hashchange', applyRoute);

      /* player — an iframe overlay with a direct-link escape hatch.
         some hosts refuse to be framed; the bar link and the note cover them. */
      var player = { open: false, id: null, timer: 0, seq: 0 };
      var playerEl = document.getElementById('player');
      var playerStage = document.getElementById('playerStage');
      var playerFrame = document.getElementById('playerFrame');
      var playerName = document.getElementById('playerName');
      var playerNote = document.getElementById('playerNote');
      var playerNoteLink = document.getElementById('playerNoteLink');
      var playerCloseBtn = document.getElementById('playerClose');
      var playerFallbackLink = document.getElementById('playerFallback');
      var lastFocus = null;

      function stopLoadWatch() {
        if (player.timer) { clearTimeout(player.timer); player.timer = 0; }
      }

      function armLoadWatch() {
        stopLoadWatch();
        player.timer = setTimeout(showPlayerNote, 8000);
      }

      function showPlayerNote() {
        if (!player.open) return;
        playerNote.hidden = false;
      }

      function handleFrameLoad() {
        if (!player.open) return; /* teardown ping from about:blank */
        playerStage.classList.add('is-loaded');
        /* a readable frame still parked at about:blank means the host refused
           to be framed; an unreadable one is either a cross-origin game or a
           silent refusal — indistinguishable, so the bar link covers both */
        try {
          var doc = playerFrame.contentDocument;
          if (doc && doc.location.href === 'about:blank' && !playerFrame.hasAttribute('srcdoc')) {
            showPlayerNote();
          }
        } catch (e) { /* cross-origin: the game is in there */ }
        stopLoadWatch();
      }

      function trapTab(container, e) {
        var items = container.querySelectorAll('button, a[href], input, select, textarea');
        var visible = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].offsetParent !== null) visible.push(items[i]);
        }
        if (!visible.length) return;
        var first = visible[0];
        var last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }

      function openPlayer(zone) {
        if (player.open && player.id === zone.id) return;
        stopLoadWatch();
        lastFocus = document.activeElement;
        player.open = true;
        player.id = zone.id;
        var seq = ++player.seq;
        playerName.textContent = zone.name;
        playerFrame.title = zone.name;
        playerFallbackLink.href = zone.url;
        playerNoteLink.href = zone.url;
        playerNote.hidden = true;
        playerStage.classList.remove('is-loaded');
        /* repo games arrive as text/plain, which a frame renders as source
           code — fetch and inject them via srcdoc instead; external URLs
           still take the direct path */
        if (zone.srcdoc || zone.url.indexOf(GN.html) === 0) {
          fetch(zone.url, { signal: AbortSignal.timeout(10000) })
            .then(function (res) {
              if (!res.ok) throw new Error('game HTTP ' + res.status);
              return res.text();
            })
            .then(function (html) {
              if (!player.open || player.seq !== seq) return;
              playerFrame.removeAttribute('src');
              playerFrame.srcdoc = html;
            })
            .catch(function () {
              if (player.open && player.seq === seq) showPlayerNote();
            });
        } else {
          playerFrame.removeAttribute('srcdoc');
          playerFrame.src = zone.url;
        }
        playerEl.hidden = false;
        document.body.classList.add('is-playing');
        armLoadWatch();
        playerCloseBtn.focus();
      }

      function closePlayer(viaRoute) {
        if (!player.open) return;
        player.open = false;
        player.id = null;
        player.seq++;
        stopLoadWatch();
        playerFrame.removeAttribute('srcdoc');
        playerFrame.src = 'about:blank';
        playerEl.hidden = true;
        document.body.classList.remove('is-playing');
        document.title = BASE_TITLE;
        if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
        lastFocus = null;
        if (!viaRoute && PLAY_ROUTE.test(currentRoute())) location.hash = '#/games';
      }

      playerFrame.addEventListener('load', handleFrameLoad);
      playerCloseBtn.addEventListener('click', function () { closePlayer(); });

      document.addEventListener('keydown', function (e) {
        if (player.open) {
          if (e.key === 'Escape') { closePlayer(); return; }
          if (e.key === 'Tab') trapTab(playerEl, e);
          return;
        }
        if (tour.el.hidden) return;
        if (e.key === 'Escape') { tourClose(); return; }
        if (e.key === 'ArrowRight') { tourGo(1); return; }
        if (e.key === 'ArrowLeft') { tourGo(-1); return; }
        if (e.key === 'Tab') trapTab(tour.el, e);
      });

      /* catalog — the worker normalizes GN-Math, UGS and Seraph behind
         /zones.json?source=...; opened as a plain file (or any static host),
         GN-Math still falls back to a client-side pull. */
      var CATALOG_STORE = 'cookieubg:catalog';
      var CATALOG_LABELS = { gn: 'GN-Math', ugs: 'UGS', seraph: 'Seraph' };
      var state = { source: 'gn', zones: [], query: '', pendingPlay: null, loadSeq: 0 };
      var grid = document.getElementById('zoneGrid');
      var countEl = document.getElementById('gamesCount');
      var metaEl = document.getElementById('catalogMeta');
      var catalogPicker = document.getElementById('catalogPicker');
      var catalogButton = document.getElementById('catalogButton');
      var catalogMenu = document.getElementById('catalogMenu');
      var catalogValue = document.getElementById('catalogValue');

      var GN = {
        zones: 'https://cdn.jsdelivr.net/gh/freebuisness/assets@main/zones.json',
        covers: 'https://cdn.jsdelivr.net/gh/freebuisness/covers@main',
        html: 'https://cdn.jsdelivr.net/gh/freebuisness/html@main',
        stats: 'https://data.jsdelivr.com/v1/stats/packages/gh/freebuisness/html@main/files?period=year',
      };

      function isCatalogSource(source) {
        return Object.prototype.hasOwnProperty.call(CATALOG_LABELS, source);
      }

      function catalogLabel(source) {
        return CATALOG_LABELS[source] || CATALOG_LABELS.gn;
      }

      function catalogForId(id) {
        id = String(id);
        if (id.indexOf('ugs:') === 0) return 'ugs';
        if (id.indexOf('seraph:') === 0) return 'seraph';
        return /^\\d+$/.test(id) ? 'gn' : null;
      }

      try {
        var savedSource = localStorage.getItem(CATALOG_STORE);
        if (isCatalogSource(savedSource)) state.source = savedSource;
      } catch (e) { /* private mode */ }

      var bootPlay = PLAY_ROUTE.exec(currentRoute());
      if (bootPlay) {
        var bootId = bootPlay[1];
        try { bootId = decodeURIComponent(bootId); } catch (e) { /* keep raw */ }
        var bootSource = catalogForId(bootId);
        if (bootSource) state.source = bootSource;
      }

      function resolveTemplate(str) {
        return String(str).replace('{COVER_URL}', GN.covers).replace('{HTML_URL}', GN.html);
      }

      function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      }

      function padId(id) {
        var text = String(id);
        return /^\\d+$/.test(text) ? '#' + text.padStart(3, '0') : '#' + text;
      }

      function sourceTag(z) {
        if (z.source === 'ugs') return 'UGS';
        if (z.source === 'seraph') return 'SERAPH';
        return padId(z.id);
      }

      function fmtPlays(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\\.0$/, '') + 'M';
        if (n >= 1e3) return Math.round(n / 1e3) + 'K';
        return String(n);
      }

      function buildCard(z) {
        var card = el('a', 'card');
        card.href = '#/play/' + encodeURIComponent(z.id);
        card.setAttribute('role', 'listitem');
        card.setAttribute('aria-label', 'Play ' + z.name);

        var fig = el('figure', 'card-cover');
        fig.dataset.initial = (z.name.replace(/^\\W+/, '')[0] || '?').toUpperCase();
        if (z.cover) {
          var img = document.createElement('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.alt = z.name + ' cover';
          img.src = z.cover;
          img.addEventListener('error', function () {
            img.remove();
            fig.classList.add('noimg');
          });
          fig.appendChild(img);
        } else {
          fig.classList.add('noimg');
        }
        card.appendChild(fig);

        var info = el('div', 'card-info');
        info.appendChild(el('span', 'card-id', sourceTag(z)));
        if (z.plays) info.appendChild(el('span', 'card-plays', fmtPlays(z.plays) + ' plays'));
        card.appendChild(info);

        card.appendChild(el('h3', 'card-title', z.name));
        return card;
      }

      function sortedZones() {
        var list = state.zones.slice();
        var q = state.query.trim().toLowerCase();
        if (q) {
          list = list.filter(function (z) { return z.name.toLowerCase().indexOf(q) > -1; });
        }
        if (state.source === 'gn') {
          list.sort(function (a, b) {
            return (b.plays || 0) - (a.plays || 0) || a.name.localeCompare(b.name);
          });
        } else {
          list.sort(function (a, b) { return a.name.localeCompare(b.name); });
        }
        return list;
      }

      function gridState(cls, text) {
        grid.replaceChildren(el('p', 'grid-state' + (cls ? ' ' + cls : ''), text));
      }

      function applyView() {
        var list = sortedZones();
        countEl.textContent = list.length + ' / ' + state.zones.length + ' titles';
        if (!list.length) {
          gridState('is-empty', 'nothing matches \\u2014 try fewer letters');
          return;
        }
        var frag = document.createDocumentFragment();
        for (var i = 0; i < list.length; i++) frag.appendChild(buildCard(list[i]));
        grid.replaceChildren(frag);
      }

      function catalogReady() {
        if (!state.pendingPlay) return;
        state.pendingPlay = null;
        applyRoute();
      }

      function acceptCatalog(data, source) {
        if (!data || !Array.isArray(data.zones) || !data.zones.length) throw new Error('empty index');
        state.zones = data.zones.map(function (z) {
          z.source = z.source || data.source || source;
          return z;
        });
        applyView();
        if (metaEl) {
          var label = data.label || catalogLabel(source);
          var pulled = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : '';
          metaEl.textContent = 'index: ' + label +
            (pulled ? ' \\u00B7 pulled ' + pulled : '') + ' \\u00B7 cached at the edge';
        }
        catalogReady();
      }

      function loadCatalogDirect(seq) {
        Promise.all([
          fetch(GN.zones, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
          }).then(function (res) {
            if (!res.ok) throw new Error('zones HTTP ' + res.status);
            return res.json();
          }),
          fetch(GN.stats, { signal: AbortSignal.timeout(8000) })
            .then(function (res) { return res.ok ? res.json() : null; })
            .catch(function () { return null; }),
        ])
          .then(function (results) {
            if (seq !== state.loadSeq) return;
            var raw = Array.isArray(results[0]) ? results[0] : [];
            var stats = Array.isArray(results[1]) ? results[1] : [];
            var plays = {};
            for (var i = 0; i < stats.length; i++) {
              var file = stats[i] || {};
              var m = /\\/(\\d+)/.exec(file.name || '');
              var total = file.hits && file.hits.total;
              if (m && Number.isFinite(total)) {
                var id = Number(m[1]);
                if (!(id in plays) || total > plays[id]) plays[id] = total;
              }
            }
            var zones = [];
            for (var j = 0; j < raw.length; j++) {
              var z = raw[j];
              if (z && Number.isFinite(z.id) && z.id >= 0 &&
                  typeof z.name === 'string' && z.name.length > 0 &&
                  typeof z.url === 'string' && z.url.length > 0) {
                zones.push({
                  id: z.id,
                  name: z.name,
                  url: resolveTemplate(z.url),
                  cover: typeof z.cover === 'string' ? resolveTemplate(z.cover) : null,
                  plays: plays[z.id] || null,
                  source: 'gn',
                  srcdoc: true,
                });
              }
            }
            if (!zones.length) throw new Error('empty index');
            state.source = 'gn';
            syncCatalogPicker();
            state.zones = zones;
            applyView();
            if (metaEl) metaEl.textContent = 'index: GN-Math \\u00B7 pulled straight from the browser';
            catalogReady();
          })
          .catch(function () {
            if (seq !== state.loadSeq) return;
            gridState('is-error', 'the GN-Math index didn\\u2019t answer \\u2014 refresh to retry');
            countEl.textContent = 'offline';
          });
      }

      function loadCatalog(source) {
        source = isCatalogSource(source) ? source : (isCatalogSource(state.source) ? state.source : 'gn');
        state.source = source;
        var seq = ++state.loadSeq;
        state.zones = [];
        syncCatalogPicker();
        gridState('is-loading', 'loading ' + catalogLabel(source).toLowerCase());
        countEl.textContent = '\\u2014 titles';
        if (metaEl) metaEl.textContent = '';
        fetch('/zones.json?source=' + encodeURIComponent(source), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (seq !== state.loadSeq) return;
            acceptCatalog(data, source);
          })
          .catch(function () {
            if (seq !== state.loadSeq) return;
            if (source === 'gn') {
              loadCatalogDirect(seq);
              return;
            }
            gridState('is-error', 'the ' + catalogLabel(source) + ' shelf didn\\u2019t answer \\u2014 try another catalog');
            countEl.textContent = 'offline';
            if (metaEl) metaEl.textContent = 'index unavailable';
          });
      }

      function syncCatalogPicker() {
        if (!catalogValue || !catalogMenu) return;
        catalogValue.textContent = catalogLabel(state.source);
        var options = catalogMenu.querySelectorAll('.catalog-option');
        for (var i = 0; i < options.length; i++) {
          var on = options[i].getAttribute('data-source') === state.source;
          options[i].classList.toggle('is-active', on);
          options[i].setAttribute('aria-selected', on ? 'true' : 'false');
        }
      }

      function closeCatalogMenu() {
        if (!catalogPicker || !catalogMenu || catalogMenu.hidden) return;
        catalogMenu.hidden = true;
        catalogPicker.classList.remove('is-open');
        catalogButton.setAttribute('aria-expanded', 'false');
      }

      function openCatalogMenu() {
        if (!catalogPicker || !catalogMenu) return;
        catalogMenu.hidden = false;
        catalogPicker.classList.add('is-open');
        catalogButton.setAttribute('aria-expanded', 'true');
      }

      function chooseCatalog(source) {
        if (!isCatalogSource(source)) return;
        syncCatalogPicker();
        closeCatalogMenu();
        try { localStorage.setItem(CATALOG_STORE, source); } catch (e) { /* private mode */ }
        if (source === state.source) {
          if (!state.zones.length) loadCatalog(source);
          return;
        }
        state.pendingPlay = null;
        loadCatalog(source);
      }

      if (catalogButton && catalogMenu) {
        catalogButton.addEventListener('click', function (e) {
          e.stopPropagation();
          if (catalogMenu.hidden) openCatalogMenu();
          else closeCatalogMenu();
        });

        catalogButton.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openCatalogMenu();
            var active = catalogMenu.querySelector('.catalog-option.is-active') ||
              catalogMenu.querySelector('.catalog-option');
            if (active) active.focus();
          }
        });

        catalogMenu.addEventListener('click', function (e) {
          var option = e.target.closest ? e.target.closest('.catalog-option') : null;
          if (!option) return;
          chooseCatalog(option.getAttribute('data-source'));
          catalogButton.focus();
        });

        catalogMenu.addEventListener('keydown', function (e) {
          var options = Array.prototype.slice.call(catalogMenu.querySelectorAll('.catalog-option'));
          var index = options.indexOf(document.activeElement);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!options.length) return;
            var step = e.key === 'ArrowDown' ? 1 : -1;
            options[(index + step + options.length) % options.length].focus();
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            if (!options.length) return;
            options[e.key === 'Home' ? 0 : options.length - 1].focus();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            closeCatalogMenu();
            catalogButton.focus();
          }
        });

        catalogPicker.addEventListener('focusout', function (e) {
          if (!catalogPicker.contains(e.relatedTarget)) closeCatalogMenu();
        });

        document.addEventListener('click', function (e) {
          if (!catalogPicker.contains(e.target)) closeCatalogMenu();
        });
      }

      syncCatalogPicker();

      var searchTimer = 0;
      document.getElementById('zoneSearch').addEventListener('input', function (e) {
        clearTimeout(searchTimer);
        var input = e.target;
        searchTimer = setTimeout(function () {
          state.query = input.value;
          applyView();
        }, 140);
      });

      /* shared helpers ------------------------------------------------------ */
      function readStore(key, fallback) {
        try {
          var raw = localStorage.getItem(key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
      }

      function writeStore(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (e) { return false; }
      }

      function uid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }

      function closeSidebars() {
        var open = document.querySelectorAll('.chat-app.sidebar-open');
        for (var i = 0; i < open.length; i++) open[i].classList.remove('sidebar-open');
      }

      document.addEventListener('click', function (e) {
        var toggle = e.target.closest ? e.target.closest('[data-sidebar-toggle]') : null;
        if (toggle) {
          var app = toggle.closest('.chat-app');
          if (app) app.classList.toggle('sidebar-open');
          return;
        }
        if (e.target.closest && e.target.closest('[data-sidebar-close]')) closeSidebars();
      });

      function bindComposer(input, form) {
        function resize() {
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 144) + 'px';
        }
        input.addEventListener('input', resize);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        });
        resize();
      }

      /* chat — HTTP polling. A plain worker cannot share memory between
         isolates, so the room lives in the edge cache through /chat/poll
         and /chat/send. Local history and the name live in localStorage. */
      var CHAT_STORE = 'cookieubg:chat:v1';
      var CHAT_SEEN_KEY = 'cookieubg:chat:seen';
      var CHAT_CLEAR_KEY = 'cookieubg:chat:cleared';
      var CHAT_NAME_KEY = 'cookieubg:name';
      var CHAT_CLIENT_KEY = 'cookieubg:chat:client';
      var CHAT_BUBBLE_KEY = 'cookieubg:chat:bubble';
      var CHAT_POLL_MS = 2200;
      var CHAT_MAX_LOCAL = 200;
      var CHAT_TEXT_CAP = 500;
      var BUBBLE_PRESETS = {
        ember: { label: 'ember', color: '', ink: '' },
        ink: { label: 'ink', color: '#2a241d', ink: '#f4eee2' },
        forest: { label: 'forest', color: '#345c45', ink: '#f4eee2' },
        ocean: { label: 'ocean', color: '#305d7a', ink: '#f4eee2' },
        plum: { label: 'plum', color: '#6e3c61', ink: '#f4eee2' },
        gold: { label: 'gold', color: '#8a5a1e', ink: '#f4eee2' }
      };

      var chatRoot = document.querySelector('.chat-app[data-app="chat"]');
      var chatLog = document.getElementById('chatLog');
      var chatInput = document.getElementById('chatInput');
      var chatSendBtn = document.getElementById('chatSend');
      var chatNameInput = document.getElementById('chatName');
      var chatLiveEl = document.getElementById('chatLive');
      var chatLiveText = document.getElementById('chatLiveText');
      var chatSettingsBtn = document.getElementById('chatSettingsBtn');
      var chatSettingsEl = document.getElementById('chatSettings');
      var chatBubbleName = document.getElementById('chatBubbleName');
      var chatBubbleButtons = document.querySelectorAll('#chatSettings [data-bubble]');
      var chatTimeFmt = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      var chat = {
        started: false,
        timer: 0,
        gen: 0,
        seen: 0,
        online: 0,
        live: false,
        id: '',
        bubble: 'ember',
        messages: []
      };

      try {
        chat.id = localStorage.getItem(CHAT_CLIENT_KEY) || '';
        if (!chat.id) {
          chat.id = uid();
          localStorage.setItem(CHAT_CLIENT_KEY, chat.id);
        }
        chatNameInput.value = localStorage.getItem(CHAT_NAME_KEY) || '';
      } catch (e) { /* private mode */ }

      chatNameInput.addEventListener('input', function () {
        try { localStorage.setItem(CHAT_NAME_KEY, chatNameInput.value.slice(0, 24)); } catch (e) { /* private mode */ }
      });

      function bubbleApply(root, bubble, nameEl, buttons) {
        var preset = BUBBLE_PRESETS[bubble] || BUBBLE_PRESETS.ember;
        if (root) {
          if (preset.color) {
            root.style.setProperty('--bubble', preset.color);
            root.style.setProperty('--bubble-ink', preset.ink);
          } else {
            root.style.removeProperty('--bubble');
            root.style.removeProperty('--bubble-ink');
          }
        }
        if (nameEl) nameEl.textContent = preset.label;
        for (var i = 0; i < buttons.length; i++) {
          var picked = buttons[i].getAttribute('data-bubble') === bubble;
          buttons[i].classList.toggle('is-active', picked);
          buttons[i].setAttribute('aria-pressed', picked ? 'true' : 'false');
        }
      }

      function chatApplyBubble() {
        bubbleApply(chatRoot, chat.bubble, chatBubbleName, chatBubbleButtons);
      }

      function chatSetSettings(open) {
        chatSettingsEl.hidden = !open;
        chatSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      chat.bubble = readStore(CHAT_BUBBLE_KEY, 'ember');
      if (!BUBBLE_PRESETS[chat.bubble]) chat.bubble = 'ember';
      chatApplyBubble();

      chatSettingsBtn.addEventListener('click', function () {
        chatSetSettings(chatSettingsEl.hidden);
      });

      for (var cb = 0; cb < chatBubbleButtons.length; cb++) {
        chatBubbleButtons[cb].addEventListener('click', function () {
          chat.bubble = this.getAttribute('data-bubble');
          writeStore(CHAT_BUBBLE_KEY, chat.bubble);
          chatApplyBubble();
        });
      }

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !chatSettingsEl.hidden && !document.getElementById('view-chat').hidden) {
          chatSetSettings(false);
          chatSettingsBtn.focus();
        }
      });

      /* maxlength is the first line of defence; this also catches scripts,
         paste quirks and any browser that lets a value slip past it */
      chatInput.addEventListener('input', function () {
        if (chatInput.value.length > CHAT_TEXT_CAP) {
          chatInput.value = chatInput.value.slice(0, CHAT_TEXT_CAP);
        }
      });

      function chatUrl(path) {
        var override = new URLSearchParams(location.search).get('chat');
        var base = override ? override.replace(/\\/$/, '') : '';
        return base + path;
      }

      function chatSetLive(mode, count) {
        chatLiveEl.classList.toggle('is-on', mode === 'on');
        if (mode === 'on') {
          chatLiveText.textContent = (count || 1) + ' online \u00b7 live';
        } else if (mode === 'off') {
          chatLiveText.textContent = 'offline \u00b7 retrying\u2026';
        } else {
          chatLiveText.textContent = 'connecting\u2026';
        }
        chatInput.disabled = chatSendBtn.disabled = mode !== 'on';
      }

      function chatNearBottom() {
        return chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 90;
      }

      function chatScrollBottom() {
        chatLog.scrollTop = chatLog.scrollHeight;
      }

      function chatPersist() {
        writeStore(CHAT_STORE, chat.messages.slice(-CHAT_MAX_LOCAL));
      }

      function chatPersistSeen() {
        writeStore(CHAT_SEEN_KEY, chat.seen);
      }

      function chatEmptyState() {
        var wrap = el('div', 'empty-state');
        wrap.appendChild(el('h2', null, 'Say hi to the room.'));
        wrap.appendChild(el('p', null, 'No accounts, no sign-in. Your name and history stay in this browser.'));
        chatLog.appendChild(wrap);
      }

      function chatMessageNode(msg) {
        var line = el('div', 'msg' + (msg.mine ? ' own' : '') + (msg.pending ? ' is-pending' : '') + (msg.failed ? ' is-failed' : ''));
        line.dataset.id = msg.id;
        var meta = el('div', 'msg-meta');
        meta.appendChild(el('span', 'msg-name', msg.mine ? 'you' : (msg.name || 'anon')));
        var at = new Date(msg.at || Date.now());
        var time = el('span', null, chatTimeFmt.format(at));
        time.title = at.toLocaleString();
        meta.appendChild(time);
        line.appendChild(meta);
        line.appendChild(el('div', 'msg-bubble', msg.text));
        if (msg.failed) line.appendChild(el('div', 'msg-fail', msg.error || 'not sent \u00b7 try again when the room is back'));
        return line;
      }

      function chatRender() {
        var stick = chatNearBottom();
        chatLog.replaceChildren();
        if (!chat.messages.length) {
          chatEmptyState();
        } else {
          var frag = document.createDocumentFragment();
          for (var i = 0; i < chat.messages.length; i++) frag.appendChild(chatMessageNode(chat.messages[i]));
          chatLog.appendChild(frag);
        }
        if (stick) chatLog.scrollTop = chatLog.scrollHeight;
      }

      function chatSort() {
        chat.messages.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
        if (chat.messages.length > CHAT_MAX_LOCAL) chat.messages.splice(0, chat.messages.length - CHAT_MAX_LOCAL);
      }

      function chatMerge(items) {
        var known = {};
        for (var i = 0; i < chat.messages.length; i++) known[chat.messages[i].id] = true;
        var changed = false;
        for (var j = 0; j < items.length; j++) {
          var raw = items[j];
          if (!raw || typeof raw.text !== 'string' || !raw.id) continue;
          if (known[raw.id]) continue;
          var id = String(raw.id);
          chat.messages.push({
            id: id,
            name: String(raw.name || 'anon').slice(0, 24),
            text: String(raw.text).slice(0, 500),
            at: Number(raw.at) || Date.now(),
            mine: id.indexOf(chat.id + ':') === 0
          });
          known[id] = true;
          changed = true;
        }
        if (changed) {
          chatSort();
          chatPersist();
        }
        return changed;
      }

      function chatPollOnce(since) {
        return fetch(chatUrl('/chat/poll') + '?since=' + encodeURIComponent(since) + '&id=' + encodeURIComponent(chat.id), {
          headers: { accept: 'application/json' },
          cache: 'no-store'
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (!data || !Array.isArray(data.messages)) throw new Error('bad room');
            return data;
          });
      }

      function chatPoll() {
        if (!chat.started) return;
        var gen = chat.gen;
        chatPollOnce(chat.seen)
          .then(function (data) {
            if (gen !== chat.gen) return;
            chat.live = true;
            chat.online = data.online || 0;
            if (data.reset) {
              chat.seen = typeof data.seq === 'number' ? data.seq : 0;
            } else if (typeof data.seq === 'number' && data.seq > chat.seen) {
              chat.seen = data.seq;
            }
            chatPersistSeen();
            chatSetLive('on', chat.online);
            if (chatMerge(data.messages)) chatRender();
          })
          .catch(function () {
            if (gen !== chat.gen) return;
            chat.live = false;
            chatSetLive('off');
          })
          .then(function () {
            if (gen !== chat.gen) return;
            chat.timer = setTimeout(chatPoll, chat.live ? CHAT_POLL_MS : 4000);
          });
      }

      /* clearing hides the room history already in this browser, then records
         the room's current sequence so old messages do not come back on the
         next poll or after a reload */
      function chatClearLocal() {
        var gen = ++chat.gen;
        var clearId = uid();
        if (chat.timer) {
          clearTimeout(chat.timer);
          chat.timer = 0;
        }
        chat.messages = [];
        writeStore(CHAT_CLEAR_KEY, { id: clearId, seq: chat.seen });
        try { localStorage.removeItem(CHAT_STORE); } catch (e) { /* private mode */ }
        chatPersist();
        chatPersistSeen();
        chatRender();
        chatPollOnce(0)
          .then(function (data) {
            if (gen !== chat.gen) return;
            chat.live = true;
            chat.online = data.online || 0;
            if (typeof data.seq === 'number') chat.seen = data.seq;
            chatPersistSeen();
            writeStore(CHAT_CLEAR_KEY, { id: clearId, seq: chat.seen });
            chatSetLive('on', chat.online);
          })
          .catch(function () {
            if (gen !== chat.gen) return;
            chat.live = false;
            chatSetLive('off');
          })
          .then(function () {
            if (gen !== chat.gen) return;
            chat.timer = setTimeout(chatPoll, chat.live ? CHAT_POLL_MS : 4000);
          });
      }

      window.addEventListener('storage', function (e) {
        if (e.key !== CHAT_CLEAR_KEY || !e.newValue) return;
        var marker = null;
        try { marker = JSON.parse(e.newValue); } catch (err) { /* ignore */ }
        if (!marker || typeof marker !== 'object') return;
        var through = Number(marker.seq);
        if (!Number.isFinite(through) || through < 0) through = 0;
        chat.gen++;
        if (chat.timer) {
          clearTimeout(chat.timer);
          chat.timer = 0;
        }
        chat.messages = [];
        chat.seen = Math.max(chat.seen, through);
        try { localStorage.removeItem(CHAT_STORE); } catch (err) { /* private mode */ }
        chatPersist();
        chatPersistSeen();
        if (!chat.started) return;
        chatRender();
        chatSetLive(chat.live ? 'on' : 'wait', chat.online);
        chat.timer = setTimeout(chatPoll, 250);
      });

      function chatStart() {
        if (chat.started) return;
        chat.started = true;
        chat.seen = Math.max(0, Number(readStore(CHAT_SEEN_KEY, 0)) || 0);
        var saved = readStore(CHAT_STORE, []);
        if (Array.isArray(saved)) {
          chat.messages = saved.filter(function (m) {
            return m && typeof m.id === 'string' && typeof m.text === 'string';
          }).map(function (m) {
            return {
              id: m.id,
              name: String(m.name || 'anon').slice(0, 24),
              text: String(m.text).slice(0, 500),
              at: Number(m.at) || Date.now(),
              mine: !!m.mine || String(m.id).indexOf(chat.id + ':') === 0,
              failed: !!m.failed,
              error: typeof m.error === 'string' ? m.error.slice(0, 160) : ''
            };
          });
          chatSort();
        }
        chatRender();
        chatSetLive('wait');
        chatPoll();
      }

      function chatPost(msg) {
        return fetch(chatUrl('/chat/send'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: msg.id, client: chat.id, name: msg.name, text: msg.text })
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) {
              var err = new Error((data && data.error) || ('HTTP ' + res.status));
              err.status = res.status;
              err.retryAfter = data && data.retryAfter;
              throw err;
            }
            return data;
          });
        });
      }

      document.getElementById('chatForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var text = chatInput.value.trim().slice(0, CHAT_TEXT_CAP);
        if (!text || !chat.live) return;
        var msg = {
          id: chat.id + ':' + uid(),
          name: chatNameInput.value.trim() || 'anon',
          text: text,
          at: Date.now(),
          mine: true,
          pending: true
        };
        chat.messages.push(msg);
        chatSort();
        chatPersist();
        chatRender();
        chatInput.value = '';
        chatInput.style.height = 'auto';
        chatPost(msg)
          .then(function () {
            msg.pending = false;
            chatRender();
          })
          .catch(function (err) {
            msg.pending = false;
            msg.failed = true;
            if (err && err.status === 429) {
              msg.error = 'not sent \u00b7 wait ' + (err.retryAfter || 5) + 's between messages';
            } else if (err && err.status === 413) {
              msg.error = 'not sent \u00b7 messages max out at 500 characters';
            }
            chatRender();
          });
      });

      document.getElementById('chatClear').addEventListener('click', function () {
        if (!window.confirm('Clear chat history saved in this browser?')) return;
        chatClearLocal();
      });

      bindComposer(chatInput, document.getElementById('chatForm'));

      /* ai — talks to the worker's /ai endpoint, which alone holds the
         Inception key. Threads live in localStorage; the reply streams
         as SSE and diffusing snapshots repaint the bubble as the answer
         sharpens into place. */
      var AI_STORE = 'cookieubg:ai:v1';
      var AI_ACTIVE = 'cookieubg:ai:active';
      var AI_CLEAR_KEY = 'cookieubg:ai:cleared';
      var AI_BUBBLE_KEY = 'cookieubg:ai:bubble';
      var AI_MAX_THREADS = 40;
      var AI_MAX_MESSAGES = 100;
      var AI_MAX_TURNS = 24;

      var aiRoot = document.querySelector('.chat-app[data-app="ai"]');
      var aiLog = document.getElementById('aiLog');
      var aiInput = document.getElementById('aiInput');
      var aiSendBtn = document.getElementById('aiSend');
      var aiStateEl = document.getElementById('aiState');
      var aiStateText = document.getElementById('aiStateText');
      var aiTitleEl = document.getElementById('aiTitle');
      var aiThreadsEl = document.getElementById('aiThreads');
      var aiSettingsBtn = document.getElementById('aiSettingsBtn');
      var aiSettingsEl = document.getElementById('aiSettings');
      var aiBubbleName = document.getElementById('aiBubbleName');
      var aiBubbleButtons = document.querySelectorAll('#aiSettings [data-bubble]');
      var ai = { started: false, threads: [], activeId: '', busy: false, abort: null, epoch: 0, bubble: 'ember' };

      function aiNewThread() {
        var now = Date.now();
        return { id: uid(), title: 'New chat', messages: [], createdAt: now, updatedAt: now };
      }

      function aiFind(id) {
        for (var i = 0; i < ai.threads.length; i++) {
          if (ai.threads[i].id === id) return ai.threads[i];
        }
        return null;
      }

      function aiActive() {
        return aiFind(ai.activeId) || ai.threads[0] || null;
      }

      function aiPersist() {
        ai.threads.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        if (ai.threads.length > AI_MAX_THREADS) {
          var active = aiActive();
          ai.threads = ai.threads.slice(0, AI_MAX_THREADS);
          if (active && ai.threads.indexOf(active) === -1) ai.threads.push(active);
        }
        for (var i = 0; i < ai.threads.length; i++) {
          var msgs = ai.threads[i].messages;
          if (msgs.length > AI_MAX_MESSAGES) msgs.splice(0, msgs.length - AI_MAX_MESSAGES);
        }
        if (!writeStore(AI_STORE, ai.threads)) {
          /* quota hit — drop the oldest threads until the rest fit */
          while (ai.threads.length > 1) {
            ai.threads.pop();
            if (writeStore(AI_STORE, ai.threads)) break;
          }
          if (!aiFind(ai.activeId) && ai.threads.length) ai.activeId = ai.threads[0].id;
        }
        writeStore(AI_ACTIVE, ai.activeId);
      }

      function aiSetState(mode, text) {
        aiStateEl.classList.toggle('is-on', mode === 'on');
        aiStateEl.classList.toggle('is-busy', mode === 'busy');
        aiStateText.textContent = text;
      }

      function aiWipeSaved() {
        try {
          localStorage.removeItem(AI_STORE);
          localStorage.removeItem(AI_ACTIVE);
        } catch (e) { /* private mode */ }
      }

      function aiApplyBubble() {
        bubbleApply(aiRoot, ai.bubble, aiBubbleName, aiBubbleButtons);
      }

      function aiSetSettings(open) {
        aiSettingsEl.hidden = !open;
        aiSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      ai.bubble = readStore(AI_BUBBLE_KEY, 'ember');
      if (!BUBBLE_PRESETS[ai.bubble]) ai.bubble = 'ember';
      aiApplyBubble();

      aiSettingsBtn.addEventListener('click', function () {
        aiSetSettings(aiSettingsEl.hidden);
      });

      for (var ab = 0; ab < aiBubbleButtons.length; ab++) {
        aiBubbleButtons[ab].addEventListener('click', function () {
          ai.bubble = this.getAttribute('data-bubble');
          writeStore(AI_BUBBLE_KEY, ai.bubble);
          aiApplyBubble();
        });
      }

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !aiSettingsEl.hidden && !document.getElementById('view-ai').hidden) {
          aiSetSettings(false);
          aiSettingsBtn.focus();
        }
      });

      function aiUrl() {
        var override = new URLSearchParams(location.search).get('ai');
        return override || '/ai';
      }

      function aiTitleFor(text) {
        return text.trim().slice(0, 42) || 'New chat';
      }

      function aiRenderThreads() {
        aiThreadsEl.replaceChildren();
        for (var i = 0; i < ai.threads.length; i++) {
          var thread = ai.threads[i];
          var item = el('div', 'thread-item' + (thread.id === ai.activeId ? ' is-active' : ''));
          item.setAttribute('role', 'button');
          item.setAttribute('tabindex', '0');
          item.setAttribute('data-thread', thread.id);
          item.appendChild(el('span', 'thread-name', thread.title || 'New chat'));
          var del = el('button', 'thread-del', '\u00d7');
          del.type = 'button';
          del.setAttribute('data-del', thread.id);
          del.setAttribute('aria-label', 'Delete ' + (thread.title || 'chat'));
          item.appendChild(del);
          aiThreadsEl.appendChild(item);
        }
      }

      function aiEmptyState() {
        var wrap = el('div', 'empty-state');
        wrap.appendChild(el('h2', null, 'How can I help?'));
        wrap.appendChild(el('p', null, 'Ask anything. Every chat is saved in this browser, so you can pick it back up from the sidebar.'));
        aiLog.appendChild(wrap);
      }

      function aiMessageNode(msg) {
        var own = msg.role === 'user';
        var line = el('div', 'msg' + (own ? ' own' : ''));
        line.setAttribute('data-msg-id', msg.id || '');
        var meta = el('div', 'msg-meta');
        meta.appendChild(el('span', 'msg-name', own ? 'you' : 'CrazyCookie AI'));
        var at = new Date(msg.at || Date.now());
        var time = el('span', null, chatTimeFmt.format(at));
        time.title = at.toLocaleString();
        meta.appendChild(time);
        line.appendChild(meta);
        line.appendChild(el('div', 'msg-bubble', msg.content || ''));
        return line;
      }

      function aiScroll(force) {
        if (force || aiLog.scrollTop + aiLog.clientHeight >= aiLog.scrollHeight - 90) {
          aiLog.scrollTop = aiLog.scrollHeight;
        }
      }

      function aiRenderMessages() {
        var thread = aiActive();
        aiLog.replaceChildren();
        aiTitleEl.textContent = thread ? (thread.title || 'New chat') : 'New chat';
        if (!thread || !thread.messages.length) {
          aiEmptyState();
          return;
        }
        var frag = document.createDocumentFragment();
        for (var i = 0; i < thread.messages.length; i++) frag.appendChild(aiMessageNode(thread.messages[i]));
        aiLog.appendChild(frag);
        aiScroll(true);
      }

      function aiOpen(id) {
        if (!aiFind(id)) return;
        if (id !== ai.activeId && ai.busy) aiStop();
        ai.activeId = id;
        aiPersist();
        aiRenderThreads();
        aiRenderMessages();
        closeSidebars();
      }

      function aiDelete(id) {
        var thread = aiFind(id);
        if (!thread) return;
        if (!window.confirm('Delete "' + (thread.title || 'this chat') + '"?')) return;
        if (ai.busy && ai.activeId === id) aiStop();
        ai.threads = ai.threads.filter(function (t) { return t.id !== id; });
        if (!ai.threads.length) ai.threads.push(aiNewThread());
        if (ai.activeId === id) ai.activeId = ai.threads[0].id;
        aiPersist();
        aiRenderThreads();
        aiRenderMessages();
      }

      function aiStop() {
        if (ai.abort) ai.abort.abort();
      }

      function aiPaint(bubble, text, streaming) {
        bubble.textContent = text;
        if (streaming) {
          var cursor = document.createElement('span');
          cursor.className = 'ai-cursor';
          cursor.setAttribute('aria-hidden', 'true');
          bubble.appendChild(cursor);
        }
        aiScroll(false);
      }

      async function aiAsk(text) {
        var epoch = ai.epoch;
        var thread = aiActive();
        if (!thread || ai.busy) return;

        var now = Date.now();
        thread.messages.push({ id: uid(), role: 'user', content: text, at: now });
        if (thread.title === 'New chat') thread.title = aiTitleFor(text);
        var assistant = { id: uid(), role: 'assistant', content: '', at: now };
        thread.messages.push(assistant);
        thread.updatedAt = now;

        ai.busy = true;
        ai.abort = new AbortController();
        aiSendBtn.textContent = 'Stop';
        aiSetState('busy', 'thinking\u2026');
        aiPersist();
        aiRenderThreads();
        aiRenderMessages();

        var bubble = null;
        var line = aiLog.querySelector('[data-msg-id="' + assistant.id + '"]');
        if (line) {
          bubble = line.querySelector('.msg-bubble');
          if (bubble) bubble.textContent = '\u2026';
        }

        var history = thread.messages
          .filter(function (m) { return m.content && (m.role === 'user' || m.role === 'assistant'); })
          .slice(-AI_MAX_TURNS)
          .map(function (m) { return { role: m.role, content: m.content }; });

        var reply = '';
        try {
          var res = await fetch(aiUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: history }),
            signal: ai.abort.signal
          });

          if (!res.ok) {
            var detail = await res.text();
            throw new Error(detail.slice(0, 240) || ('http ' + res.status));
          }

          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            var frames = buffer.split(/\\r?\\n\\r?\\n/);
            buffer = frames.pop();
            for (var f = 0; f < frames.length; f++) {
              var lines = frames[f].split(/\\r?\\n/);
              var dataLines = [];
              for (var l = 0; l < lines.length; l++) {
                if (lines[l].indexOf('data:') === 0) dataLines.push(lines[l].slice(5).trim());
              }
              var data = dataLines.join('\\n');
              if (!data || data === '[DONE]') continue;
              try {
                var parsed = JSON.parse(data);
                var piece = parsed.choices && parsed.choices[0] && parsed.choices[0].delta
                  ? (parsed.choices[0].delta.content || '')
                  : '';
                if (piece) {
                  reply = piece; // diffusing snapshots carry the full text so far
                  assistant.content = reply;
                  if (thread.id === ai.activeId && bubble) aiPaint(bubble, reply, true);
                }
              } catch (err) { /* partial frame — ignore */ }
            }
          }

          if (!reply) {
            assistant.content = '(the model returned nothing)';
            if (thread.id === ai.activeId && bubble) aiPaint(bubble, assistant.content, false);
          } else if (thread.id === ai.activeId && bubble) {
            aiPaint(bubble, reply, false);
          }
          if (epoch === ai.epoch) aiSetState('on', 'ready');
        } catch (err) {
          if (err && err.name === 'AbortError') {
            if (!reply) {
              var at = thread.messages.indexOf(assistant);
              if (at > -1) thread.messages.splice(at, 1);
              if (epoch === ai.epoch && thread.id === ai.activeId) aiRenderMessages();
            } else if (thread.id === ai.activeId && bubble) {
              aiPaint(bubble, reply, false);
            }
            if (epoch === ai.epoch) aiSetState('on', 'stopped');
          } else {
            assistant.content = 'Could not reach the AI \u2014 ' + String(err && err.message ? err.message : err);
            if (thread.id === ai.activeId && bubble) aiPaint(bubble, assistant.content, false);
            if (epoch === ai.epoch) aiSetState('off', 'error');
          }
        } finally {
          ai.busy = false;
          ai.abort = null;
          aiSendBtn.textContent = 'Send';
          if (epoch === ai.epoch) {
            thread.updatedAt = Date.now();
            aiPersist();
            aiRenderThreads();
            if (thread.id === ai.activeId) aiScroll(false);
          }
        }
      }

      function aiLoad() {
        var saved = readStore(AI_STORE, []);
        if (Array.isArray(saved)) {
          for (var i = 0; i < saved.length; i++) {
            var t = saved[i];
            if (!t || typeof t.id !== 'string' || !Array.isArray(t.messages)) continue;
            var messages = [];
            for (var j = 0; j < t.messages.length; j++) {
              var m = t.messages[j];
              if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
              messages.push({
                id: typeof m.id === 'string' ? m.id : uid(),
                role: m.role,
                content: m.content,
                at: Number(m.at) || Date.now()
              });
            }
            ai.threads.push({
              id: t.id,
              title: typeof t.title === 'string' && t.title ? t.title : 'New chat',
              messages: messages,
              createdAt: Number(t.createdAt) || Date.now(),
              updatedAt: Number(t.updatedAt) || Date.now()
            });
          }
        }
        if (!ai.threads.length) ai.threads.push(aiNewThread());
        var active = readStore(AI_ACTIVE, '');
        ai.activeId = aiFind(active) ? active : ai.threads[0].id;
      }

      function aiStart() {
        if (ai.started) return;
        ai.started = true;
        aiLoad();
        aiRenderThreads();
        aiRenderMessages();
        aiSetState('on', 'ready');
        bindComposer(aiInput, document.getElementById('aiForm'));
      }

      aiThreadsEl.addEventListener('click', function (e) {
        var del = e.target.closest ? e.target.closest('[data-del]') : null;
        if (del) {
          e.stopPropagation();
          aiDelete(del.getAttribute('data-del'));
          return;
        }
        var item = e.target.closest ? e.target.closest('[data-thread]') : null;
        if (item) aiOpen(item.getAttribute('data-thread'));
      });

      aiThreadsEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var item = e.target.closest ? e.target.closest('[data-thread]') : null;
        if (item) {
          e.preventDefault();
          aiOpen(item.getAttribute('data-thread'));
        }
      });

      document.getElementById('aiNew').addEventListener('click', function () {
        if (ai.busy) aiStop();
        var thread = aiNewThread();
        ai.threads.unshift(thread);
        ai.activeId = thread.id;
        aiPersist();
        aiRenderThreads();
        aiRenderMessages();
        closeSidebars();
        aiInput.focus();
      });

      document.getElementById('aiClearAll').addEventListener('click', function () {
        if (!window.confirm('Delete every AI chat saved in this browser?')) return;
        if (ai.busy) aiStop();
        ai.epoch++;
        aiWipeSaved();
        ai.threads = [aiNewThread()];
        ai.activeId = ai.threads[0].id;
        aiPersist();
        aiRenderThreads();
        aiRenderMessages();
        aiSetState('on', 'ready');
        writeStore(AI_CLEAR_KEY, Date.now());
      });

      window.addEventListener('storage', function (e) {
        if (e.key !== AI_CLEAR_KEY) return;
        if (ai.busy) aiStop();
        ai.epoch++;
        ai.threads = [aiNewThread()];
        ai.activeId = ai.threads[0].id;
        if (!ai.started) return;
        aiPersist();
        aiRenderThreads();
        aiRenderMessages();
        aiSetState('on', 'ready');
      });

      document.getElementById('aiForm').addEventListener('submit', function (e) {
        e.preventDefault();
        if (ai.busy) { aiStop(); return; }
        var text = aiInput.value.trim();
        if (!text) return;
        aiInput.value = '';
        aiInput.style.height = 'auto';
        aiAsk(text);
      });

      /* tour — four cards on first paint. skip sits bottom-left,
         prev/next bottom-right. IndexedDB remembers the visit, so the
         tour only greets you once per browser; no cache, it plays. */
      var TOUR_STEPS = 4;
      var TOUR_KICKERS = [
        'tour 01 \u00B7 hello',
        'tour 02 \u00B7 games',
        'tour 03 \u00B7 ai',
        'tour 04 \u00B7 chat'
      ];
      var TOUR_MAPS = ['home', 'games', 'ai', 'chat'];
      var tour = { el: document.getElementById('tour'), step: 0 };

      function tourSeen() {
        return new Promise(function (resolve) {
          var done = false;
          var settle = function (v) { if (!done) { done = true; resolve(v); } };
          setTimeout(function () { settle(false); }, 800); /* db stuck: play it */
          try {
            var req = indexedDB.open('cookieubg', 1);
            req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
            req.onerror = req.onblocked = function () { settle(false); };
            req.onsuccess = function () {
              var db = req.result;
              var get = db.transaction('kv').objectStore('kv').get('tour-seen');
              get.onsuccess = function () { db.close(); settle(get.result === true); };
              get.onerror = function () { db.close(); settle(false); };
            };
          } catch (e) { settle(false); }
        });
      }

      function tourMarkSeen() {
        try {
          var req = indexedDB.open('cookieubg', 1);
          req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
          req.onsuccess = function () {
            var db = req.result;
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(true, 'tour-seen');
            tx.oncomplete = function () { db.close(); };
          };
        } catch (e) { /* private mode, etc. — tour just returns next visit */ }
      }

      function tourPaint() {
        var slides = tour.el.querySelectorAll('.tour-slide');
        for (var i = 0; i < slides.length; i++) slides[i].hidden = i !== tour.step;
        document.getElementById('tourKicker').textContent = TOUR_KICKERS[tour.step];
        document.getElementById('tourProgress').textContent =
          (tour.step < 9 ? '0' : '') + (tour.step + 1) + ' / ' +
          (TOUR_STEPS < 10 ? '0' : '') + TOUR_STEPS;
        var marks = tour.el.querySelectorAll('[data-map]');
        for (var j = 0; j < marks.length; j++) {
          marks[j].classList.toggle('is-here',
            marks[j].getAttribute('data-map') === TOUR_MAPS[tour.step]);
        }
        document.getElementById('tourPrev').disabled = tour.step === 0;
        document.getElementById('tourNext').textContent =
          tour.step === TOUR_STEPS - 1 ? 'done' : 'next \u2192';
      }

      function tourGo(dir) {
        var next = Math.min(TOUR_STEPS - 1, Math.max(0, tour.step + dir));
        if (next === tour.step) return;
        tour.step = next;
        tourPaint();
        document.getElementById('tourNext').focus();
      }

      function tourClose() {
        tour.el.hidden = true;
        tourMarkSeen();
      }

      function tourOpen() {
        tour.el.hidden = false;
        tour.step = 0;
        tourPaint();
        document.getElementById('tourNext').focus();
      }

      document.getElementById('tourSkip').addEventListener('click', tourClose);
      document.getElementById('tourPrev').addEventListener('click', function () { tourGo(-1); });
      document.getElementById('tourNext').addEventListener('click', function () {
        if (tour.step === TOUR_STEPS - 1) tourClose();
        else tourGo(1);
      });

      applyRoute();
      loadCatalog();
      tourSeen().then(function (seen) { if (!seen) tourOpen(); });
    })();
  </script>
</body>
</html>`;
}

/* --------------------------------------------------------------------- ai */

/**
 * Inception Labs (mercury diffusion LLMs) — OpenAI-compatible API.
 * docs: https://docs.inceptionlabs.ai · api: https://api.inceptionlabs.ai/v1
 *
 * Notes from the docs that shape this call:
 *  - auth is a standard Bearer header; the key only ever lives here, on
 *    the server — the browser never sees it
 *  - mercury-3 is the chat model this key can use; temperature is
 *    constrained to 0.5–1.0 (0.75 is the model default)
 *  - `diffusing: true` is the native mercury trick: the SSE stream sends
 *    full-text snapshots at each denoising step, which the client paints
 *    over the previous one — text refines in blocks instead of typing
 *    out token by token
 *  - the stream is plain SSE (`data: {chunk}` … `data: [DONE]`), and the
 *    worker passes it straight through, unbuffered
 */
const AI = {
  url: 'https://api.inceptionlabs.ai/v1/chat/completions',
  model: 'mercury-3',
  // prefer a bound secret; fall back to the file constant so a bare
  // `wrangler deploy cookieubg.js` works with no configuration
  key: (env) => (env && env.INCEPTION_API_KEY) || 'sk_fb29da2727c5ccc3d1353bcf0eba617fb7f5723a0cd0652dc5c84603003a0882',
  system:
    'You are CrazyCookie AI, the resident AI of CookieUBG, a tiny arcade at the edge of the internet. '
    + 'Be sharp, warm and brief — plain text, no markdown headers. Keep answers tight unless asked to go deep.',
  maxTokens: 8192,
  maxTurns: 24, // messages kept in the upstream conversation
  charCap: 6000, // per-message cap before upstream sees it
};

async function aiResponse(request, env) {
  if (request.method !== 'POST') {
    return new Response('POST required', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad json', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
    });
  }

  const turns = (Array.isArray(body && body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-AI.maxTurns)
    .map((m) => ({ role: m.role, content: m.content.slice(0, AI.charCap) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    return new Response('nothing to answer', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
    });
  }

  let upstream;
  try {
    upstream = await fetch(AI.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + AI.key(env),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: AI.model,
        messages: [{ role: 'system', content: AI.system }, ...turns],
        stream: true,
        diffusing: true,
        temperature: 0.75,
        max_completion_tokens: AI.maxTokens,
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return new Response('the brain is unreachable: ' + String(err && err.message ? err.message : err), {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
    });
  }

  if (!upstream.ok || !upstream.body) {
    let detail = '';
    try {
      detail = (await upstream.text()).slice(0, 400);
    } catch {
      /* keep the empty detail */
    }
    return new Response('upstream ' + upstream.status + (detail ? ' — ' + detail : ''), {
      status: upstream.status === 401 || upstream.status === 429 ? upstream.status : 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
    });
  }

  // straight pass-through: the browser parses the SSE itself, so tokens
  // land the moment the model denoises them
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    },
  });
}

/* ----------------------------------------------------------------- worker */

const worker = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/zones.json') return catalogResponse(request, env, ctx);
    if (pathname === '/chat/poll') return chatPoll(request);
    if (pathname === '/chat/send') return chatSend(request);
    if (pathname === '/ai') return aiResponse(request, env);
    if (pathname === '/favicon.ico') {
      return new Response(null, {
        status: 204,
        headers: { 'cache-control': 'public, max-age=86400' },
      });
    }

    let html = null;
    if (pathname === '/') html = renderLauncher();
    else if (pathname === '/app' || pathname === '/app/') html = renderDocument(request.cf);
    if (html === null) return notFoundResponse();

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
      },
    });
  },
};

export { renderDocument };
export default worker;

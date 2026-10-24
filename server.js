'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
// Load a local .env file without an external dependency. Real hosting should use its Secrets UI.
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && !value.startsWith('#')) process.env[match[1]] = value;
  }
} catch {}
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const DEFAULT_MODEL = 'gemini-3.8-flash';
const ALLOWED_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash'
]);
const MAX_BODY_BYTES = 160 * 1024;
const MAX_PROMPT_CHARS = 70_000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestCounts = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function send(res, status, data, extraHeaders = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com data:; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extraHeaders
  });
  res.end(body);
}

function clientIp(req) {
  // Use the socket address; do not trust user-controlled X-Forwarded-For by default.
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, res) {
  const now = Date.now();
  const ip = clientIp(req);
  let item = requestCounts.get(ip);
  if (!item || now - item.startedAt >= WINDOW_MS) item = { startedAt: now, count: 0 };
  item.count += 1;
  requestCounts.set(ip, item);
  if (requestCounts.size > 5000) {
    for (const [key, value] of requestCounts) {
      if (now - value.startedAt >= WINDOW_MS) requestCounts.delete(key);
    }
  }
  if (item.count > MAX_REQUESTS_PER_WINDOW) {
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - item.startedAt)) / 1000));
    send(res, 429, { error: { message: 'Too many requests. Please wait before trying again.' } }, { 'Retry-After': String(retryAfter) });
    return false;
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request must contain valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function generate(req, res) {
  if (!rateLimit(req, res)) return;
  if (!API_KEY) {
    send(res, 503, { error: { message: 'Server API key is not configured. Set GEMINI_API_KEY and restart the server.' } });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    if (!res.headersSent && !res.destroyed) send(res, err.status || 400, { error: { message: err.message || 'Invalid request.' } });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(res, 400, { error: { message: 'Request must be a JSON object.' } });
    return;
  }

  const model = typeof body.model === 'string' && ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
  const userText = body.contents?.[0]?.parts?.[0]?.text;
  if (typeof userText !== 'string' || !userText.trim()) {
    send(res, 400, { error: { message: 'A non-empty prompt is required.' } });
    return;
  }
  if (userText.length > MAX_PROMPT_CHARS) {
    send(res, 413, { error: { message: `Prompt is too long. Maximum length is ${MAX_PROMPT_CHARS} characters.` } });
    return;
  }

  const requestedTemp = Number(body.generationConfig?.temperature ?? 0.5);
  const temperature = Number.isFinite(requestedTemp) ? Math.min(1, Math.max(0, requestedTemp)) : 0.5;
  const requestedTokens = Number(body.generationConfig?.maxOutputTokens ?? 16000);
  const maxOutputTokens = Number.isFinite(requestedTokens) ? Math.min(16000, Math.max(512, Math.floor(requestedTokens))) : 16000;
  const upstreamPayload = {
    systemInstruction: {
      parts: [{ text: 'You are a meticulous cinematic production assistant. Treat the user brief as authoritative. Preserve supplied dialogue and action order. Return valid JSON only; never claim an action succeeded unless it did.' }]
    },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens }
  };

  let upstream;
  try {
    upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(upstreamPayload),
      signal: AbortSignal.timeout(180000)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    send(res, timedOut ? 504 : 502, { error: { message: timedOut ? 'AI request timed out. Try fewer scenes or a shorter prompt.' : 'Could not connect to the AI service. Check the server internet connection and retry.' } });
    return;
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    send(res, 502, { error: { message: 'AI service returned an unreadable response.' } });
    return;
  }
  // Forward the provider status and response shape used by the existing UI, without logging the key or prompt.
  if (!upstream.ok) {
    const providerMessage = data?.error?.message || `AI service returned HTTP ${upstream.status}.`;
    send(res, upstream.status, { error: { message: providerMessage } });
    return;
  }
  send(res, 200, data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true, configured: Boolean(API_KEY), model: DEFAULT_MODEL });
    return;
  }
  if (url.pathname === '/api/generate') {
    if (req.method !== 'POST') {
      send(res, 405, { error: { message: 'Method not allowed.' } }, { Allow: 'POST' });
      return;
    }
    await generate(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: { message: 'Method not allowed.' } }, { Allow: 'GET, HEAD' });
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const fullPath = path.resolve(ROOT, relative);
  if (!fullPath.startsWith(ROOT + path.sep) && fullPath !== path.join(ROOT, 'index.html')) {
    send(res, 403, 'Forbidden');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(fullPath);
    if (!stat.isFile()) throw new Error('Not a file');
  } catch {
    send(res, 404, 'Not found');
    return;
  }
  const type = MIME[path.extname(fullPath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': fullPath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com data:; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(fullPath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`AI Cinematic Studio running at http://localhost:${PORT}`);
  console.log(`Gemini API key configured: ${API_KEY ? 'yes' : 'no (set GEMINI_API_KEY)'}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

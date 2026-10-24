const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

function request(port, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

test('minimum server smoke tests', async t => {
  const port = 31000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GEMINI_API_KEY: '' }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await request(port, '/api/health'); if (r.status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.equal(ready, true, 'server should start');
  const health = await request(port, '/api/health');
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.text).ok, true); assert.equal(JSON.parse(health.text).configured, false);
  const page = await request(port, '/');
  assert.equal(page.status, 200); assert.match(page.text, /AI Cinematic Storyboard & Script Studio/); assert.ok(page.text.length > 30000, 'index.html must not be blank');
  const method = await request(port, '/api/generate', 'GET');
  assert.equal(method.status, 405);
  const noKey = await request(port, '/api/generate', 'POST', { model: 'gemini-2.5-flash', contents: [{ role: 'user', parts: [{ text: 'test' }] }] });
  assert.equal(noKey.status, 503);
});

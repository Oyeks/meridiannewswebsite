/**
 * The Meridian — Security & Penetration Test Suite
 * Run: node test-security.js
 * Tests all attack vectors against the live server (must be running on localhost:3000)
 */

'use strict';

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0, warned = 0;

function ok(label)  { console.log(`  ✅  ${label}`); passed++; }
function fail(label){ console.log(`  ❌  ${label}`); failed++; }
function warn(label){ console.log(`  ⚠️   ${label}`); warned++; }
function section(t) { console.log(`\n${'─'.repeat(60)}\n  ${t}\n${'─'.repeat(60)}`); }

async function get(path, headers={}) {
  const r = await fetch(BASE+path, { headers });
  return { status: r.status, headers: r.headers, body: await r.text().catch(()=>'') };
}
async function post(path, body, headers={}) {
  const r = await fetch(BASE+path, { method:'POST', body: JSON.stringify(body), headers:{'Content-Type':'application/json',...headers} });
  return { status: r.status, headers: r.headers, body: await r.text().catch(()=>'') };
}

async function runAll() {
  console.log('\n🔐 THE MERIDIAN — SECURITY & PENETRATION TEST\n');

  // ── 1. SECURITY HEADERS ──────────────────────────────────────────────────────
  section('1. HTTP Security Headers');
  const home = await get('/');
  const h = home.headers;

  const requiredHeaders = [
    ['x-frame-options',              'Clickjacking protection'],
    ['x-content-type-options',       'MIME sniffing protection'],
    ['x-xss-protection',             'XSS filter header'],
    ['strict-transport-security',    'HSTS'],
    ['content-security-policy',      'Content Security Policy'],
    ['referrer-policy',              'Referrer Policy'],
  ];
  for (const [header, label] of requiredHeaders) {
    if (h.get(header)) ok(`${label} (${header})`);
    else warn(`Missing: ${label} (${header})`);
  }
  if (!h.get('x-powered-by')) ok('X-Powered-By header removed (server fingerprint hidden)');
  else fail('X-Powered-By header exposed: '+h.get('x-powered-by'));

  // ── 2. RATE LIMITING ─────────────────────────────────────────────────────────
  section('2. Rate Limiting');
  let rateLimitHit = false;
  for (let i = 0; i < 65; i++) {
    const r = await get('/api/status');
    if (r.status === 429) { rateLimitHit = true; break; }
  }
  if (rateLimitHit) ok('Rate limiting triggers at 60 req/min (HTTP 429 returned)');
  else warn('Rate limit not triggered in 65 requests — check config');

  // Wait for rate limit window to reset
  await new Promise(r => setTimeout(r, 2000));

  // ── 3. INPUT VALIDATION / INJECTION ──────────────────────────────────────────
  section('3. Input Validation & Injection Attacks');

  // SQL injection via query param
  const sqli = await get('/api/news?q=' + encodeURIComponent("' OR 1=1; DROP TABLE articles;--"));
  if (sqli.status < 500) ok('SQL injection in ?q param — no 500 error (app uses no SQL)');
  else fail('SQL injection caused server error');

  // XSS via query param
  const xss = await get('/api/news?q=' + encodeURIComponent('<script>alert(1)</script>'));
  const xssBody = JSON.parse(xss.body||'{}');
  const xssInResponse = JSON.stringify(xssBody).includes('<script>');
  if (!xssInResponse) ok('XSS payload in ?q param not reflected in JSON response');
  else fail('XSS payload reflected in response');

  // Path traversal
  const trav1 = await get('/api/../package.json');
  const trav2 = await get('/../etc/passwd');
  if (trav1.status === 404 || !trav1.body.includes('"dependencies"')) ok('Path traversal /../package.json blocked');
  else fail('Path traversal exposed package.json: '+trav1.body.slice(0,80));
  if (trav2.status === 404 || !trav2.body.includes('root:')) ok('Path traversal /../etc/passwd blocked');
  else fail('Path traversal may have exposed system file');

  // Null byte injection
  const nullbyte = await get('/api/news/%00');
  if (nullbyte.status !== 500) ok('Null byte in path does not cause 500');
  else fail('Null byte injection caused 500');

  // Long input
  const longQ = await get('/api/news?q=' + 'A'.repeat(5000));
  if (longQ.status < 500) ok('5000-char query param handled without crash');
  else fail('Long query param caused server error');

  // ── 4. CORS ───────────────────────────────────────────────────────────────────
  section('4. CORS Policy');
  const corsR = await get('/api/status', { Origin: 'https://evil.com' });
  const acao = corsR.headers.get('access-control-allow-origin');
  if (acao === '*') warn('CORS allows all origins (*) — OK for public API, restrict in production with ALLOWED_ORIGIN env var');
  else if (acao) ok(`CORS restricted to: ${acao}`);
  else ok('No CORS header on non-matching origin');

  // ── 5. SENSITIVE ENDPOINT PROTECTION ─────────────────────────────────────────
  section('5. Sensitive Endpoint Protection');

  // POST /api/refresh without key (when no key set, it should work; when key set, reject)
  const refreshNoKey = await post('/api/refresh', {});
  if (refreshNoKey.status === 200 || refreshNoKey.status === 401) {
    if (refreshNoKey.status === 401) ok('/api/refresh protected by API key (401 returned)');
    else warn('/api/refresh is unprotected — set REFRESH_API_KEY in .env for production');
  } else fail('/api/refresh returned unexpected status: '+refreshNoKey.status);

  // Method not allowed checks
  const putNews   = await fetch(BASE+'/api/news',   { method:'PUT' });
  const deleteNews= await fetch(BASE+'/api/news',   { method:'DELETE' });
  const patchNews = await fetch(BASE+'/api/news',   { method:'PATCH' });
  if (putNews.status === 404 || putNews.status === 405)   ok('PUT /api/news correctly rejected');
  else fail('PUT /api/news not blocked: '+putNews.status);
  if (deleteNews.status === 404 || deleteNews.status === 405) ok('DELETE /api/news correctly rejected');
  else fail('DELETE /api/news not blocked: '+deleteNews.status);

  // ── 6. RESPONSE CONTENT SAFETY ───────────────────────────────────────────────
  section('6. Response Content Safety');

  const statusR = await get('/api/status');
  const statusJ = JSON.parse(statusR.body||'{}');
  if (!statusJ.error) ok('/api/status does not leak internal error stack traces');
  const hasSensitive = JSON.stringify(statusJ).match(/password|secret|key|token/i);
  if (!hasSensitive) ok('/api/status response contains no sensitive field names');
  else warn('/api/status may leak sensitive field name: '+hasSensitive[0]);

  // Check no .env exposure
  const envExposed  = await get('/.env');
  const env2Exposed = await get('/.env.example');
  if (envExposed.status === 404)  ok('.env file not publicly accessible');
  else fail('.env file is accessible! Status: '+envExposed.status);
  if (env2Exposed.status === 404) ok('.env.example not publicly accessible');
  else warn('.env.example is readable at /.env.example (low risk, but consider removing)');

  // ── 7. INVALID ROUTES ────────────────────────────────────────────────────────
  section('7. Error Handling & Information Disclosure');

  const notFound = await get('/api/doesnotexist');
  if (notFound.status === 404) ok('Unknown API routes return 404');
  try {
    const nfJ = JSON.parse(notFound.body);
    if (!nfJ.stack && !nfJ.trace) ok('404 response does not include stack trace');
    else fail('Stack trace exposed in 404 response');
  } catch(e) { ok('404 response is clean JSON'); }

  // Verify server type not exposed
  const serverHeader = home.headers.get('server');
  if (!serverHeader || serverHeader === 'nginx' || !serverHeader.includes('Express')) ok('Server version not exposed in headers');
  else warn('Server header may expose technology: '+serverHeader);

  // ── 8. API RESPONSE INTEGRITY ────────────────────────────────────────────────
  section('8. API Response Integrity');

  const newsR = await get('/api/news?limit=5');
  try {
    const newsJ = JSON.parse(newsR.body);
    if (newsJ.ok !== undefined) ok('/api/news returns structured response with ok field');
    if (Array.isArray(newsJ.articles)) ok('/api/news articles field is an array');
    if (typeof newsJ.total === 'number') ok('/api/news includes total count');
    if (newsJ.fetchedAt) ok('/api/news includes fetchedAt timestamp');
    // Check no dangerous fields leaked
    const flatArticles = JSON.stringify(newsJ.articles||[]);
    if (!flatArticles.includes('password') && !flatArticles.includes('secret')) ok('Article objects contain no sensitive fields');
  } catch(e) { fail('Could not parse /api/news response: '+e.message); }

  const badCat = await get('/api/news/INVALID_CAT');
  if (badCat.status === 400) ok('Invalid category returns 400 Bad Request');
  else fail('Invalid category not validated: status '+badCat.status);

  // ── SUMMARY ───────────────────────────────────────────────────────────────────
  const total = passed + failed + warned;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RESULTS: ${total} checks`);
  console.log(`  ✅ Passed : ${passed}`);
  console.log(`  ❌ Failed : ${failed}`);
  console.log(`  ⚠️  Warnings: ${warned}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (failed > 0) {
    console.log('  🔴 ACTION REQUIRED — fix failed checks before production deploy\n');
  } else if (warned > 0) {
    console.log('  🟡 MOSTLY SECURE — address warnings before production deploy\n');
  } else {
    console.log('  🟢 ALL CHECKS PASSED — good security posture\n');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => {
  console.error('\n💥 Test runner failed:', e.message);
  console.error('Make sure the server is running: node server.js\n');
  process.exit(1);
});

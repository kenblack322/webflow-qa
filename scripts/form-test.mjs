#!/usr/bin/env node
// Test Webflow forms without sending anything: fill with test data, submit, intercept the outgoing
// request in the browser, answer it with a fake 200 and record the payload locally.
// --live lets the request through (real submission, needs user approval).

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleConsent } from './consent.mjs';

const opt = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const url = opt('--url');
const live = process.argv.includes('--live') && process.argv.includes('--confirm');
const only = opt('--form', null);
const out = opt('--out', null);
const email = opt('--email', `qa-test+${Date.now()}@example.com`);
if (!url) {
  console.error('Usage: node scripts/form-test.mjs --url <page> [--form 0] [--out file.json] [--live --confirm]\nDefault: submissions are intercepted locally and never reach the server.');
  process.exit(2);
}

const TEST_TEXT = 'QA test submission, please ignore';
const ANALYTICS = /google-analytics|googletagmanager|analytics\.google|doubleclick|facebook\.com\/tr|hotjar|clarity\.ms|segment\.io|sentry|datadog|bat\.bing|linkedin\.com\/px|tiktok|cookiebot|usercentrics|onetrust/i;

function parseBody(req) {
  const raw = req.postData() || '';
  const ct = req.headers()['content-type'] || '';
  try {
    if (ct.includes('application/json')) return JSON.parse(raw);
    if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    if (ct.includes('multipart/form-data')) {
      const fields = {};
      for (const m of raw.matchAll(/name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n--/g)) fields[m[1]] = m[2];
      return fields;
    }
  } catch { /* fall through */ }
  return raw.slice(0, 2000);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

let armed = false;
const captured = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  const isSubmit = armed && !ANALYTICS.test(req.url()) && (req.method() !== 'GET' || req.resourceType() === 'document' && req.url().includes('?'));
  if (!isSubmit) return route.continue();
  captured.push({ url: req.url(), method: req.method(), contentType: req.headers()['content-type'] || null, payload: req.method() === 'GET' ? Object.fromEntries(new URL(req.url()).searchParams) : parseBody(req) });
  if (live) return route.continue();
  if (req.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Intercepted by Webflow QA</body></html>' });
  const origin = req.headers()['origin'] || new URL(url).origin;
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 200, msg: 'ok' }) });
});

await page.goto(url, { waitUntil: 'load', timeout: 45000 });
await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
await handleConsent(page, 'accept');

const formCount = await page.locator('form').count();
const results = [];

for (let i = 0; i < formCount; i++) {
  if (only !== null && String(i) !== only) continue;
  const form = page.locator('form').nth(i);
  const meta = await form.evaluate((f) => ({
    name: f.dataset.name || f.getAttribute('name') || f.id || null,
    action: f.getAttribute('action'),
    method: (f.getAttribute('method') || 'get').toLowerCase(),
    wfPage: f.dataset.wfPageId || document.documentElement.dataset.wfPage || null,
    wfElement: f.dataset.wfElementId || null,
    search: f.getAttribute('role') === 'search' || !!f.querySelector('input[type="search"]') || /search/i.test(f.getAttribute('action') || ''),
  }));
  const r = { index: i, ...meta, status: null, notes: [], requests: [] };
  if (meta.search) { r.status = 'skipped'; r.notes.push('Search form'); results.push(r); continue; }

  await form.scrollIntoViewIfNeeded().catch(() => {});
  if (!(await form.isVisible().catch(() => false))) { r.status = 'skipped'; r.notes.push('Not visible (modal, tab or hidden by interaction)'); results.push(r); continue; }
  if (await form.locator('.g-recaptcha, iframe[src*="recaptcha"], .cf-turnstile, iframe[src*="hcaptcha"]').count()) r.notes.push('CAPTCHA present, the server would require a token');

  const radios = new Set();
  const filled = {};
  for (const field of await form.locator('input, textarea, select').all()) {
    if (!(await field.isVisible().catch(() => false))) continue;
    const tag = await field.evaluate((el) => el.tagName.toLowerCase());
    const type = (await field.getAttribute('type')) || tag;
    const name = (await field.getAttribute('name')) || (await field.getAttribute('data-name')) || type;
    const n = name.toLowerCase();
    if (['submit', 'hidden', 'button', 'file', 'image', 'reset'].includes(type)) continue;
    if (type === 'checkbox') { await field.check({ force: true }).catch(() => {}); filled[name] = true; continue; }
    if (type === 'radio') { if (!radios.has(name)) { await field.check({ force: true }).catch(() => {}); radios.add(name); filled[name] = await field.getAttribute('value'); } continue; }
    if (tag === 'select') { const opts = await field.locator('option').all(); if (opts.length > 1) { await field.selectOption({ index: 1 }).catch(() => {}); filled[name] = await field.inputValue().catch(() => null); } continue; }
    let value = TEST_TEXT;
    if (type === 'email' || n.includes('mail')) value = email;
    else if (type === 'tel' || /phone|tel|telefon|mobil/.test(n)) value = '+49 30 12345678';
    else if (type === 'number') value = '1';
    else if (type === 'url') value = 'https://example.com';
    else if (type === 'date') value = '2030-01-01';
    else if (/vorname|first/.test(n)) value = 'QA';
    else if (/nachname|last|surname/.test(n)) value = 'Test';
    else if (/name/.test(n)) value = 'QA Test';
    else if (/zip|plz|postal/.test(n)) value = '10115';
    await field.fill(value).then(() => { filled[name] = value; }).catch(() => r.notes.push(`Could not fill ${name}`));
  }
  r.filled = filled;

  const before = captured.length;
  armed = true;
  const submit = form.locator('[type="submit"], button:not([type="button"]), .w-button').first();
  if (await submit.count()) await submit.click().catch(() => r.notes.push('Submit click failed'));
  else await form.evaluate((f) => f.requestSubmit()).catch(() => r.notes.push('No submit control'));

  // Webflow toggles .w-form-done / .w-form-fail siblings; newer form elements may use variants.
  const state = await page.waitForFunction((idx) => {
    const f = document.querySelectorAll('form')[idx];
    const scope = f?.parentElement || document;
    const vis = (el) => el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
    if (vis(scope.querySelector('.w-form-done'))) return 'success';
    if (vis(scope.querySelector('.w-form-fail'))) return 'failed';
    if (f && !vis(f) && scope.innerText.trim()) return 'form-hidden-after-submit';
    return false;
  }, i, { timeout: 12000 }).then((h) => h.jsonValue()).catch(() => null);
  armed = false;

  r.requests = captured.slice(before);
  if (state) r.status = state;
  else {
    const invalid = await form.evaluate((f) => [...f.querySelectorAll(':invalid')].map((el) => el.name || el.type)).catch(() => []);
    r.status = invalid.length ? 'validation-blocked' : (r.requests.length ? 'sent-no-ui-feedback' : 'nothing-sent');
    if (invalid.length) r.notes.push(`Browser validation blocked: ${invalid.join(', ')}`);
  }
  r.successText = (await page.evaluate((idx) => (document.querySelectorAll('form')[idx]?.parentElement?.querySelector('.w-form-done, .w-form-fail')?.innerText || '').trim().slice(0, 200), i).catch(() => '')) || null;

  // Payload sanity: every filled field should arrive in the request.
  const sent = r.requests.map((q) => JSON.stringify(q.payload)).join(' ');
  const missing = Object.entries(filled).filter(([, v]) => typeof v === 'string' && v && !sent.includes(JSON.stringify(v).slice(1, -1))).map(([k]) => k);
  if (r.requests.length && missing.length) r.notes.push(`Filled but not found in payload: ${missing.join(', ')}`);
  if (r.requests.length) r.endpoint = r.requests[0].url.replace(/\?.*$/, '');
  results.push(r);

  if (i < formCount - 1) { await page.goto(url, { waitUntil: 'load' }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await handleConsent(page, 'accept'); }
}

await browser.close();
const report = { url, mode: live ? 'live' : 'intercepted', email, forms: formCount, results };
if (out) { await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, JSON.stringify(report, null, 2)); }
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Form test: ${url} (${report.mode}${live ? '' : ', nothing was sent'})`);
  for (const r of results) {
    console.log(`\n## Form ${r.index}: ${r.name ?? 'unnamed'} → ${r.status}`);
    if (r.wfPage || r.wfElement) console.log(`Webflow: page ${r.wfPage ?? '—'}, element ${r.wfElement ?? '—'}`);
    if (r.endpoint) console.log(`Endpoint: ${r.requests[0].method} ${r.endpoint}`);
    if (r.successText) console.log(`Message shown: "${r.successText}"`);
    r.notes.forEach((n) => console.log(`Note: ${n}`));
    for (const q of r.requests) {
      const p = typeof q.payload === 'object' ? q.payload : { raw: q.payload };
      const fields = Object.entries(p).filter(([k]) => k.startsWith('fields['));
      const metaKeys = Object.entries(p).filter(([k]) => !k.startsWith('fields['));
      console.log('\n| Field | Sent value |\n|---|---|');
      (fields.length ? fields : metaKeys).forEach(([k, v]) => console.log(`| ${k.replace(/^fields\[(.*)\]$/, '$1')} | ${String(v).slice(0, 120)} |`));
      if (fields.length) console.log(`\nMeta: ${metaKeys.map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' · ')}`);
    }
    if (!r.requests.length && r.status !== 'skipped') console.log('No request was sent.');
  }
  if (out) console.log(`\nFull JSON: ${out}`);
}

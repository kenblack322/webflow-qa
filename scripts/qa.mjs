#!/usr/bin/env node
// Webflow QA — Layer 1 (deterministic) audit.
// Crawls a Webflow site with Playwright, runs HTML/runtime/a11y/responsive checks,
// and writes findings that carry Webflow IDs so fixes can be applied via Webflow MCP.

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { render } from './render.mjs';
import { handleConsent, isPreConsentViolation } from './consent.mjs';

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {
    url: null,
    scope: 'sitemap',
    pages: [],
    maxPages: 25,
    env: 'auto',
    widths: [1920, 1440, 991, 767, 479],
    imageKb: 300,
    externalLinks: true,
    psi: 3,
    redirects: null,
    out: 'reports',
    stage: null,
    screens: 'issues',
    consent: 'accept',
  };
  for (let i = 2; i < argv.length; i++) {
    const [k, v] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], argv[i + 1]];
    const take = () => { if (!argv[i].includes('=')) i++; return v; };
    switch (k) {
      case '--url': args.url = take(); break;
      case '--scope': args.scope = take(); break;
      case '--pages': args.pages = take().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--max-pages': args.maxPages = Number(take()); break;
      case '--env': args.env = take(); break;
      case '--widths': args.widths = take().split(',').map(Number); break;
      case '--image-kb': args.imageKb = Number(take()); break;
      case '--no-external': args.externalLinks = false; break;
      case '--psi': args.psi = Number(take()); break;
      case '--redirects': args.redirects = take(); break;
      case '--out': args.out = take(); break;
      case '--stage': args.stage = take(); break;
      case '--screens': args.screens = take(); break;
      case '--consent': args.consent = take(); break;
      default: break;
    }
  }
  if (!args.url) {
    console.error('Usage: node scripts/qa.mjs --url https://site.webflow.io [--scope sitemap|single|list] [--pages /a,/b] [--max-pages 25] [--env staging|production|auto] [--redirects file.csv] [--psi 3] [--no-external] [--screens issues|all|none] [--consent accept|decline|none]');
    process.exit(2);
  }
  if (!/^https?:\/\//.test(args.url)) args.url = 'https://' + args.url;
  args.url = args.url.replace(/\/+$/, '');
  return args;
}

const args = parseArgs(process.argv);
let origin = new URL(args.url).origin;
let host = new URL(args.url).host;
let env;
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
let outDir;

// ---------- Findings ----------

// fix.via values tell the fixing phase which Webflow MCP area handles the issue:
// page-settings | element | style | cms | asset | site-settings | custom-code | redirects | manual
const findings = [];
function add(f) {
  findings.push({
    id: `F${String(findings.length + 1).padStart(4, '0')}`,
    severity: 'medium',
    page: null,
    wf: null,
    ...f,
  });
}

// ---------- Helpers ----------

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 WebflowQA/0.1';

async function http(url, { method = 'GET', redirect = 'manual', timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, redirect, signal: ctrl.signal, headers: { 'user-agent': UA } });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function followChain(url) {
  const chain = [];
  let current = url;
  const seen = new Set();
  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(current)) return { chain, status: 'loop', final: current };
    seen.add(current);
    let res;
    try {
      res = await http(current, { method: 'HEAD' });
      if ([403, 405, 501].includes(res.status)) res = await http(current, { method: 'GET' });
    } catch (e) {
      return { chain, status: 'error', error: String(e.name === 'AbortError' ? 'timeout' : e.message), final: current };
    }
    chain.push({ url: current, status: res.status });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    return { chain, status: res.status, final: current };
  }
  return { chain, status: 'too-many-redirects', final: current };
}

async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeUrl(u) {
  const x = new URL(u);
  x.hash = '';
  return x.href.replace(/\/$/, '') || x.href;
}

function slugFor(url) {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '') || 'home';
  return p.replace(/[^a-z0-9-]+/gi, '_').slice(0, 80);
}

// ---------- Site-level discovery ----------

async function fetchText(url) {
  try {
    const res = await http(url, { redirect: 'follow' });
    return { status: res.status, text: res.ok ? await res.text() : '', headers: res.headers };
  } catch (e) {
    return { status: 0, text: '', error: e.message };
  }
}

async function discoverPages() {
  const robots = await fetchText(origin + '/robots.txt');
  const sitemapUrls = [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!sitemapUrls.length) sitemapUrls.push(origin + '/sitemap.xml');

  if (robots.status !== 200) {
    add({ check: 'robots-missing', phase: 'Complete SEO setup', severity: 'low', message: `robots.txt returned ${robots.status}`, fix: { via: 'site-settings', hint: 'SEO settings → robots.txt' } });
  } else if (env === 'production' && /^\s*disallow:\s*\/\s*$/im.test(robots.text)) {
    add({ check: 'robots-disallow-all', phase: 'Complete launch preparation', severity: 'critical', message: 'robots.txt disallows the whole site on production', fix: { via: 'site-settings', hint: 'SEO settings → robots.txt / disable subdomain indexing' } });
  }

  const locs = [];
  let sitemapOk = false;
  const queue = [...sitemapUrls];
  const visited = new Set();
  while (queue.length && visited.size < 20) {
    const sm = queue.shift();
    if (visited.has(sm)) continue;
    visited.add(sm);
    const r = await fetchText(sm);
    if (r.status !== 200 || !r.text.includes('<')) continue;
    sitemapOk = true;
    const found = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    if (/<sitemapindex/i.test(r.text)) queue.push(...found);
    else locs.push(...found);
  }
  if (!sitemapOk) {
    add({ check: 'sitemap-missing', phase: 'Complete SEO setup', severity: env === 'production' ? 'high' : 'medium', message: 'No reachable sitemap.xml', fix: { via: 'site-settings', hint: 'SEO settings → Auto-generate sitemap' } });
  }

  // Sitemaps on staging often list the custom domain; rewrite to the audited host.
  const pages = locs.map((l) => {
    try {
      const u = new URL(l);
      if (u.host !== host) add({ check: 'sitemap-foreign-host', phase: 'Complete SEO setup', severity: 'info', message: `Sitemap lists ${u.host}, audited host is ${host}`, detail: l, dedupeKey: 'sitemap-foreign-host' });
      return origin + u.pathname;
    } catch { return null; }
  }).filter(Boolean);

  return { sitemapOk, pages: [...new Set(pages.map(normalizeUrl))] };
}

// ---------- In-page DOM audit (runs in the browser) ----------

function domAudit() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const desc = (el) => {
    const cls = [...el.classList].filter((c) => !c.startsWith('w-')).slice(0, 3).join('.');
    const txt = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return { tag: el.tagName.toLowerCase(), classes: [...el.classList], selector: el.tagName.toLowerCase() + (cls ? '.' + cls : ''), text: txt, wId: el.getAttribute('data-w-id') || null, id: el.id || null };
  };
  const meta = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) ?? null;

  const html = document.documentElement;
  const ctx = document.createElement('canvas').getContext('2d');
  const px = (text, font) => { ctx.font = font; return Math.round(ctx.measureText(text || '').width); };

  const title = document.title || '';
  const description = meta('meta[name="description"]');

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({ level: Number(h.tagName[1]), text: h.innerText.trim().replace(/\s+/g, ' ').slice(0, 120), visible: vis(h), el: desc(h) }));

  const ids = {};
  document.querySelectorAll('[id]').forEach((el) => { ids[el.id] = (ids[el.id] || 0) + 1; });

  const links = [...document.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), abs: a.href, name: (a.innerText || a.getAttribute('aria-label') || a.querySelector('img[alt]')?.alt || a.getAttribute('title') || '').trim(), visible: vis(a), el: desc(a) }));

  const images = [...document.querySelectorAll('img')].map((img) => {
    const r = img.getBoundingClientRect();
    return {
      src: img.currentSrc || img.src,
      alt: img.getAttribute('alt'),
      hasSrcset: img.hasAttribute('srcset'),
      loading: img.getAttribute('loading'),
      naturalWidth: img.naturalWidth,
      renderedWidth: Math.round(r.width),
      top: Math.round(r.top + window.scrollY),
      emptySrc: !img.getAttribute('src') && !img.getAttribute('srcset') && !img.getAttribute('data-src'),
      broken: img.complete && img.naturalWidth === 0 && !!img.getAttribute('src'),
      visible: vis(img),
      el: desc(img),
    };
  });

  const videos = [...document.querySelectorAll('video')].map((v) => ({ autoplay: v.autoplay, muted: v.muted || v.hasAttribute('muted'), playsinline: v.hasAttribute('playsinline'), el: desc(v) }));

  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
    try { const d = JSON.parse(s.textContent); return { ok: true, types: [].concat(d).flatMap((x) => x['@graph'] ? x['@graph'].map((g) => g['@type']) : [x['@type']]), hasContext: [].concat(d).every((x) => !!x['@context']) }; }
    catch (e) { return { ok: false, error: e.message, snippet: s.textContent.slice(0, 120) }; }
  });

  const headScripts = [...document.head.querySelectorAll('script[src]')].map((s) => ({ src: s.src, async: s.async, defer: s.defer, type: s.type }));
  const allScripts = [...document.querySelectorAll('script[src]')].map((s) => s.src);
  const inline = [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent).join('\n');

  // Client-First structure: every section_ wrapper should contain padding-global and a container-*.
  const isSectionClass = (el) => [...el.classList].some((c) => c.startsWith('section_'));
  const sections = [...document.querySelectorAll('section, [class*="section_"]')]
    .filter((s) => (s.tagName === 'SECTION' || isSectionClass(s)) && !s.closest('nav, footer, .w-nav') && vis(s))
    .map((s) => ({
      el: desc(s),
      tag: s.tagName.toLowerCase(),
      sectionClass: isSectionClass(s),
      hasPaddingGlobal: !!s.querySelector('[class*="padding-global"]'),
      hasContainer: !!s.querySelector('[class*="container-"]'),
    }));

  const classUse = {};
  const comboDepth = [];
  document.querySelectorAll('[class]').forEach((el) => {
    const own = [...el.classList].filter((c) => !c.startsWith('w-'));
    own.forEach((c) => { classUse[c] = (classUse[c] || 0) + 1; });
    if (own.length > 4) comboDepth.push({ ...desc(el), count: own.length });
  });

  // Webflow CMS signals: empty bound fields and empty lists.
  const emptyBinds = [...document.querySelectorAll('.w-dyn-bind-empty')].map(desc);
  const emptyLists = [...document.querySelectorAll('.w-dyn-list')].filter((l) => !l.querySelector('.w-dyn-item')).map((l) => ({ ...desc(l), hasEmptyState: !!l.querySelector('.w-dyn-empty') && vis(l.querySelector('.w-dyn-empty')) }));

  const bodyText = document.body.innerText;

  const textEls = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seenParents = new Set();
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const p = n.parentElement;
    if (!p || seenParents.has(p) || !n.textContent.trim()) continue;
    seenParents.add(p);
    if (!vis(p)) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    textEls.push({ fontSize: fs, el: desc(p) });
  }

  return {
    wf: { site: html.getAttribute('data-wf-site'), page: html.getAttribute('data-wf-page'), collection: html.getAttribute('data-wf-collection'), itemSlug: html.getAttribute('data-wf-item-slug') },
    lang: html.getAttribute('lang'),
    title, titlePx: px(title, '20px Arial'),
    description, descriptionPx: px(description, '14px Arial'),
    canonical: meta('link[rel="canonical"]', 'href'),
    robotsMeta: meta('meta[name="robots"]'),
    og: { title: meta('meta[property="og:title"]'), description: meta('meta[property="og:description"]'), image: meta('meta[property="og:image"]'), type: meta('meta[property="og:type"]') },
    twitter: { card: meta('meta[name="twitter:card"]'), title: meta('meta[name="twitter:title"]'), image: meta('meta[name="twitter:image"]') },
    favicon: meta('link[rel="shortcut icon"], link[rel="icon"]', 'href'),
    webclip: meta('link[rel="apple-touch-icon"]', 'href'),
    headings, dupIds: Object.entries(ids).filter(([, n]) => n > 1).map(([id, n]) => ({ id, n })),
    links, images, videos, jsonld, headScripts, allScripts,
    analytics: {
      gtm: (allScripts.join(' ') + inline).match(/GTM-[A-Z0-9]+/g) || [],
      ga4: (allScripts.join(' ') + inline).match(/G-[A-Z0-9]{6,}/g) || [],
      gtmScriptTags: allScripts.filter((s) => s.includes('googletagmanager.com/gtm.js')).length,
      gtagScriptTags: allScripts.filter((s) => s.includes('googletagmanager.com/gtag/js')).length,
      gtagSrcs: allScripts.filter((s) => s.includes('googletagmanager.com/')),
      dataLayer: Array.isArray(window.dataLayer) ? window.dataLayer.length : null,
      consent: /cookiebot|onetrust|usercentrics|cookieyes|fs-cc|fs-consent|finsweet.*cookie|iubenda|termly|complianz|klaro|consentmanager|cookieinformation|CookieInformation|coiOverlay/i.test(allScripts.join(' ') + inline + document.body.innerHTML.slice(0, 200000)),
    },
    webflowBadge: !!document.querySelector('.w-webflow-badge'),
    forms: [...document.querySelectorAll('form')].filter((f) => f.getAttribute('role') !== 'search' && !f.querySelector('input[type="search"]')).length,
    webflowIoLinks: [...document.querySelectorAll('a[href*=".webflow.io"]')].map(desc),
    sections, classUse, comboDepth, emptyBinds, emptyLists,
    textEls,
    bodyText,
    altList: [...document.querySelectorAll('img')].map((i) => ({ src: i.currentSrc || i.src, alt: i.getAttribute('alt') })),
  };
}

function layoutAudit(width) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const desc = (el) => {
    const cls = [...el.classList].filter((c) => !c.startsWith('w-')).slice(0, 3).join('.');
    return { selector: el.tagName.toLowerCase() + (cls ? '.' + cls : ''), classes: [...el.classList], text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50) };
  };
  const vw = document.documentElement.clientWidth;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== 'visible') return true;
    }
    return false;
  };
  const overflow = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!vis(el)) return;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') return;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
      const parentOver = el.parentElement && (() => { const pr = el.parentElement.getBoundingClientRect(); return pr.right > vw + 1 || pr.left < -1; })();
      if (!parentOver) overflow.push({ ...desc(el), right: Math.round(r.right), left: Math.round(r.left), top: Math.round(r.top + window.scrollY) });
    }
  });
  const taps = [];
  if (width <= 767) {
    document.querySelectorAll('a, button, input, select, textarea, [role="button"]').forEach((el) => {
      if (!vis(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) taps.push({ ...desc(el), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY) });
    });
  }
  return {
    hScroll: document.documentElement.scrollWidth > vw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    vw,
    overflow: overflow.slice(0, 15),
    taps: taps.slice(0, 20),
  };
}

// ---------- Per-page audit ----------

const DEFAULT_TEXT = [
  /lorem ipsum/i, /dolor sit amet/i, /This is some text inside of a div block/i, /^Heading$/m, /^Text Link$/m,
  /^Button Text$/m, /Thank you! Your submission has been received!/, /Oops! Something went wrong while submitting the form/,
  /\bTODO\b/, /\bTBD\b/, /\bplaceholder\b/i, /^Untitled/m, /\[\s*(insert|add)\b/i,
];
const DEFAULT_FORM_MSG = new Set(['Thank you! Your submission has been received!', 'Oops! Something went wrong while submitting the form.']);
const GENERIC_TITLES = /^(home|about|contact|blog|page|untitled|services|index)$/i;

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });
}

async function keyboardWalk(page) {
  const seq = [];
  const noFocusStyle = [];
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const pick = (cs) => [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.color, cs.textDecorationLine].join('|');
      const focused = pick(getComputedStyle(el));
      el.blur();
      const blurred = pick(getComputedStyle(el));
      el.focus({ preventScroll: true });
      const cls = [...el.classList].filter((c) => !c.startsWith('w-')).slice(0, 3).join('.');
      return { key: el.tagName + '#' + (el.id || '') + '.' + cls + ':' + (el.innerText || '').slice(0, 30), selector: el.tagName.toLowerCase() + (cls ? '.' + cls : ''), classes: [...el.classList], changed: focused !== blurred };
    });
    if (!info) continue;
    seq.push(info.key);
    if (!info.changed && !noFocusStyle.some((n) => n.selector === info.selector)) noFocusStyle.push(info);
  }
  const tail = seq.slice(-12);
  // Focus inside an iframe (video, widget, CMP) looks stuck from the parent document; not a trap.
  const trap = tail.length >= 12 && new Set(tail).size <= 2 && !tail.every((k) => k.startsWith('IFRAME'));
  return { trap, trapAt: trap ? tail[tail.length - 1] : null, noFocusStyle: noFocusStyle.slice(0, 15), focusables: new Set(seq).size };
}

async function auditPage(browser, url, idx) {
  const slug = slugFor(url);
  const pageFind = (f) => add({ page: url, ...f });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  const consoleMsgs = [];
  const failed = [];
  const responses = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => consoleMsgs.push({ type: 'exception', text: String(e.message).slice(0, 300) }));
  page.on('requestfailed', (r) => failed.push({ url: r.url(), error: r.failure()?.errorText }));
  let consentDone = false;
  const preConsentHits = [];
  page.on('request', (r) => { if (!consentDone && isPreConsentViolation(r.url())) preConsentHits.push(r.url().replace(/\?.*$/, '')); });
  page.on('response', (r) => {
    responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType(), size: Number(r.headers()['content-length'] || 0), ctype: r.headers()['content-type'] || '' });
  });

  let mainRes;
  try {
    mainRes = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  } catch (e) {
    pageFind({ check: 'page-load-failed', phase: 'Complete self-review', severity: 'critical', message: `Page failed to load: ${e.message.split('\n')[0]}`, fix: { via: 'manual' } });
    await ctx.close();
    return null;
  }

  const status = mainRes?.status();
  const xRobots = mainRes?.headers()['x-robots-tag'] || null;
  if (status >= 400) pageFind({ check: 'page-status', phase: 'Complete self-review', severity: 'critical', message: `Page returns HTTP ${status}`, fix: { via: 'manual' } });

  // Give tags a moment to fire on their own, then answer the consent banner.
  await page.waitForTimeout(1500);
  const consent = await handleConsent(page, args.consent);
  consentDone = true;
  await scrollThrough(page);
  const d = await page.evaluate(domAudit);
  if (consent.vendor) d.analytics.consent = true;
  const wf = { siteId: d.wf.site, pageId: d.wf.page, collectionId: d.wf.collection, itemSlug: d.wf.itemSlug };
  const pf = (f) => pageFind({ wf, ...f });
  if (consent.vendor && preConsentHits.length) pf({ check: 'tracking-before-consent', phase: 'Configure scripts and analytics', severity: 'high', message: `Tracking sends data before consent (${[...new Set(preConsentHits.map((u) => new URL(u).host))].join(', ')})`, detail: [...new Set(preConsentHits)].slice(0, 10), fix: { via: 'custom-code', hint: `Gate tags behind ${consent.vendor} consent (Consent Mode v2 default denied, or load scripts on consent)` } });
  if (consent.action === 'not-found' || consent.action === 'error') pf({ check: 'consent-not-dismissed', phase: 'Configure scripts and analytics', severity: 'info', message: `Could not answer the ${consent.vendor ?? ''} consent banner; checks may be partly covered`, fix: { via: 'manual' }, dedupeKey: 'consent-not-dismissed' });
  const isCmsTemplate = !!wf.collectionId;
  const seoFix = isCmsTemplate
    ? { via: 'cms', hint: `SEO fields bound on the collection template, item "${wf.itemSlug}"` }
    : { via: 'page-settings', hint: 'Page settings → SEO / Open Graph' };

  // SEO metadata
  if (!d.title) pf({ check: 'title-missing', phase: 'Complete SEO setup', severity: 'high', message: 'Missing <title>', fix: seoFix });
  else {
    if (d.titlePx > 580) pf({ check: 'title-too-long', phase: 'Complete SEO setup', severity: 'medium', message: `Title is ~${d.titlePx}px wide (limit ~580px), will truncate in SERP`, detail: d.title, fix: seoFix });
    if (d.title.length < 15 || GENERIC_TITLES.test(d.title.trim())) pf({ check: 'title-default', phase: 'Complete SEO setup', severity: 'high', message: `Title looks like a Webflow default/generic value: "${d.title}"`, fix: seoFix });
  }
  if (!d.description) pf({ check: 'description-missing', phase: 'Complete SEO setup', severity: 'high', message: 'Missing meta description', fix: seoFix });
  else if (d.descriptionPx > 920) pf({ check: 'description-too-long', phase: 'Complete SEO setup', severity: 'low', message: `Description is ~${d.descriptionPx}px wide (limit ~920px)`, detail: d.description, fix: seoFix });
  else if (d.description.length < 70) pf({ check: 'description-too-short', phase: 'Complete SEO setup', severity: 'low', message: `Description is only ${d.description.length} chars`, detail: d.description, fix: seoFix });

  const missingOg = Object.entries(d.og).filter(([k, v]) => !v && k !== 'type').map(([k]) => 'og:' + k);
  if (!d.twitter.card) missingOg.push('twitter:card');
  if (missingOg.length) pf({ check: 'social-tags-missing', phase: 'Complete SEO setup', severity: missingOg.includes('og:image') ? 'medium' : 'low', message: `Missing ${missingOg.join(', ')}`, fix: seoFix });

  if (!d.canonical) pf({ check: 'canonical-missing', phase: 'Complete SEO setup', severity: 'medium', message: 'No canonical link', fix: { via: 'site-settings', hint: 'SEO settings → Global canonical tag URL' } });
  else if (env === 'production' && normalizeUrl(new URL(d.canonical, url).href) !== normalizeUrl(url)) pf({ check: 'canonical-not-self', phase: 'Complete SEO setup', severity: 'medium', message: `Canonical points elsewhere: ${d.canonical}`, fix: seoFix });

  const noindex = /noindex/i.test(d.robotsMeta || '') || /noindex/i.test(xRobots || '');
  if (noindex && env === 'production') pf({ check: 'noindex-on-production', phase: 'Complete launch preparation', severity: 'critical', message: 'Page is noindex on production', detail: { meta: d.robotsMeta, header: xRobots }, fix: { via: 'page-settings', hint: 'Page settings → Sitemap indexing / custom code noindex meta' } });

  if (/favicon\.ico$/.test(d.favicon || '') && /website-files\.com\/img\//.test(d.favicon || '')) pf({ check: 'favicon-default', phase: 'Complete SEO setup', severity: 'medium', message: 'Webflow default favicon', fix: { via: 'site-settings', hint: 'General → Icons' }, dedupeKey: 'favicon-default' });
  if (!d.webclip || /webclip\.png$/.test(d.webclip) && /website-files\.com\/img\//.test(d.webclip)) pf({ check: 'webclip-default', phase: 'Complete SEO setup', severity: 'low', message: 'Webflow default or missing webclip', fix: { via: 'site-settings', hint: 'General → Icons' }, dedupeKey: 'webclip-default' });

  d.jsonld.forEach((j) => {
    if (!j.ok) pf({ check: 'jsonld-invalid', phase: 'Complete SEO setup', severity: 'high', message: `Invalid JSON-LD: ${j.error}`, detail: j.snippet, fix: { via: 'custom-code', hint: 'Page settings → Custom code (head)' } });
    else if (!j.hasContext || j.types.some((t) => !t)) pf({ check: 'jsonld-incomplete', phase: 'Complete SEO setup', severity: 'medium', message: 'JSON-LD without @context or @type', fix: { via: 'custom-code' } });
  });

  // Structure
  if (!d.lang) pf({ check: 'lang-missing', phase: 'Complete accessibility review', severity: 'high', message: 'Missing <html lang>', fix: { via: 'site-settings', hint: 'Settings → Localization / custom code' }, dedupeKey: 'lang-missing' });
  const h1s = d.headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) pf({ check: 'h1-count', phase: 'Complete SEO setup', severity: 'high', message: `Page has ${h1s.length} <h1>`, detail: h1s.map((h) => h.el), fix: { via: 'element', hint: 'Change heading tag level' } });
  d.headings.forEach((h, i) => {
    const prev = d.headings[i - 1];
    if (prev && h.level > prev.level + 1) pf({ check: 'heading-skip', phase: 'Complete accessibility review', severity: 'low', message: `Heading jumps h${prev.level} → h${h.level}: "${h.text}"`, element: h.el, fix: { via: 'element', hint: `Set tag to h${prev.level + 1} and keep the visual style via class` } });
    if (!h.text) pf({ check: 'heading-empty', phase: 'Complete self-review', severity: 'medium', message: `Empty h${h.level}`, element: h.el, fix: { via: 'element' } });
  });
  d.dupIds.forEach((x) => pf({ check: 'duplicate-id', phase: 'Follow animation and code standards', severity: 'medium', message: `id="${x.id}" used ${x.n} times`, fix: { via: 'element', hint: 'Element settings → ID' } }));

  // Links
  d.links.forEach((l) => {
    if (!l.visible) return;
    const jsControlled = l.el.classes.some((c) => /^w-(lightbox|tab-link|dropdown-toggle|nav-button|slider-|button$)/.test(c)) && !l.el.classes.includes('w-button') || l.el.classes.some((c) => /^w-lightbox$/.test(c));
    if ((l.href === null || l.href === '' || l.href === '#') && !jsControlled) pf({ check: 'link-empty', phase: 'Complete self-review', severity: 'medium', message: `Link with href="${l.href ?? ''}"`, element: l.el, fix: { via: 'element', hint: 'Link settings → URL' } });
    if (!l.name) pf({ check: 'link-no-name', phase: 'Complete accessibility review', severity: 'high', message: 'Link without accessible name', element: l.el, fix: { via: 'element', hint: 'Add aria-label attribute or visible text' } });
    if (l.href?.startsWith('mailto:') && !/^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(l.href)) pf({ check: 'mailto-malformed', phase: 'Configure forms and integrations', severity: 'high', message: `Malformed ${l.href}`, element: l.el, fix: { via: 'element' } });
    if (l.href?.startsWith('tel:') && !/^tel:\+?[0-9()\-.\s]{6,}$/.test(decodeURIComponent(l.href))) pf({ check: 'tel-malformed', phase: 'Configure forms and integrations', severity: 'high', message: `Malformed ${l.href}`, element: l.el, fix: { via: 'element', hint: 'Use tel:+<country><number> without spaces' } });
  });
  if (env === 'production' && d.webflowIoLinks.length) pf({ check: 'links-to-staging', phase: 'Complete final validation', severity: 'high', message: `${d.webflowIoLinks.length} links point to *.webflow.io`, detail: d.webflowIoLinks, fix: { via: 'element' } });

  // Images & media
  const imgResp = new Map(responses.filter((r) => r.type === 'image').map((r) => [r.url, r]));
  d.images.forEach((img) => {
    const base = { element: img.el, detail: { src: img.src } };
    if (img.alt === null) pf({ ...base, check: 'img-alt-missing', phase: 'Complete accessibility review', severity: 'high', message: 'Image without alt attribute', fix: { via: img.src.includes('website-files.com') ? 'asset' : 'element', hint: 'Set alt on the asset (or element alt override); decorative → mark decorative' } });
    if (img.emptySrc && img.visible) pf({ ...base, check: 'img-empty-src', phase: 'Validate CMS', severity: 'medium', message: 'Visible image with empty src (likely unbound or empty CMS image field)', fix: { via: 'cms', hint: 'Fill the image field or hide the image when empty' } });
    if (img.broken) pf({ ...base, check: 'img-broken', phase: 'Complete self-review', severity: 'high', message: 'Broken image source', fix: { via: 'element' } });
    const r = imgResp.get(img.src);
    if (r && r.size > args.imageKb * 1024) pf({ ...base, check: 'img-heavy', phase: 'Optimise media', severity: r.size > args.imageKb * 3072 ? 'high' : 'medium', message: `Image is ${Math.round(r.size / 1024)} KB (limit ${args.imageKb} KB)`, fix: { via: 'asset', hint: 'Re-export as WebP and replace asset' } });
    if (/\.(png|jpe?g|gif|bmp|tiff?)(\?|$)/i.test(img.src) && !/\.svg/i.test(img.src)) pf({ ...base, check: 'img-legacy-format', phase: 'Optimise media', severity: 'low', message: 'Raster image not in WebP/AVIF', fix: { via: 'asset', hint: 'Convert to WebP (Assets panel → convert, or cwebp + re-upload)' } });
    if (img.visible && img.renderedWidth > 0 && img.naturalWidth > img.renderedWidth * 2.5 && img.naturalWidth > 800) pf({ ...base, check: 'img-oversized', phase: 'Optimise media', severity: 'low', message: `Intrinsic ${img.naturalWidth}px, rendered ${img.renderedWidth}px`, fix: { via: 'asset', hint: 'Upload a smaller version or enable responsive images' } });
    if (img.visible && !img.hasSrcset && img.renderedWidth > 400 && !/\.svg/i.test(img.src)) pf({ ...base, check: 'img-no-srcset', phase: 'Optimise media', severity: 'low', message: 'Large image without srcset', fix: { via: 'element', hint: 'Image settings → Responsive images on' } });
    if (img.top > 1200 && img.loading !== 'lazy') pf({ ...base, check: 'img-not-lazy', phase: 'Optimise media', severity: 'low', message: 'Below-the-fold image not lazy loaded', fix: { via: 'element', hint: 'Image settings → Load: Lazy' } });
  });
  d.videos.forEach((v) => {
    if (v.autoplay && (!v.muted || !v.playsinline)) pf({ check: 'video-autoplay-attrs', phase: 'Optimise media', severity: 'high', message: `Autoplay video missing ${[!v.muted && 'muted', !v.playsinline && 'playsinline'].filter(Boolean).join(' + ')}`, element: v.el, fix: { via: 'element' } });
  });

  // CMS signals
  if (d.emptyBinds.length) pf({ check: 'cms-empty-field', phase: 'Validate CMS', severity: 'medium', message: `${d.emptyBinds.length} bound CMS fields render empty`, detail: d.emptyBinds.slice(0, 10), fix: { via: 'cms', hint: wf.collectionId ? `Fill fields on item "${wf.itemSlug}"` : 'Fill fields on the referenced items or add conditional visibility' } });
  d.emptyLists.forEach((l) => { if (!l.hasEmptyState) pf({ check: 'cms-empty-list', phase: 'Validate CMS', severity: 'medium', message: 'Collection list renders no items and no empty state', element: l, fix: { via: 'element', hint: 'Design the Empty state or add conditional visibility' } }); });

  // Content placeholders
  const textHits = DEFAULT_TEXT.map((re) => d.bodyText.match(re)?.[0]).filter((s) => s && !DEFAULT_FORM_MSG.has(s));
  if (textHits.length) pf({ check: 'placeholder-text', phase: 'Complete self-review', severity: 'high', message: `Placeholder text found: ${[...new Set(textHits)].join(' | ')}`, fix: { via: 'element' } });
  const formDefault = DEFAULT_FORM_MSG.size && [...DEFAULT_FORM_MSG].some((m) => d.bodyText.includes(m));
  if (formDefault) pf({ check: 'form-default-messages', phase: 'Configure forms and integrations', severity: 'low', message: 'Form success/error messages are Webflow defaults', fix: { via: 'element' } });

  // Typography
  const small = d.textEls.filter((t) => t.fontSize < 11.5);
  if (small.length) pf({ check: 'text-too-small', phase: 'Follow typography and spacing system', severity: 'medium', message: `${small.length} text elements below 12px at 1440`, detail: small.slice(0, 10).map((t) => ({ ...t.el, fontSize: t.fontSize })), fix: { via: 'style' } });

  // Client-First structure
  d.sections.forEach((s) => {
    if (s.sectionClass && /^(h[1-6]|p|span|a|img)$/.test(s.tag)) { pf({ check: 'cf-section-class-misuse', phase: 'Build reusable components', severity: 'low', message: `section_ class used on <${s.tag}>`, element: s.el, fix: { via: 'style', hint: 'Rename to <section>_<element> (e.g. who_title)' } }); return; }
    if (s.sectionClass && s.tag !== 'section') pf({ check: 'cf-section-tag', phase: 'Complete accessibility review', severity: 'low', message: `section_ wrapper rendered as <${s.tag}> instead of <section>`, element: s.el, fix: { via: 'element', hint: 'Element settings → Tag: section' } });
    if (!s.hasPaddingGlobal || !s.hasContainer) pf({ check: 'cf-section-wrappers', phase: 'Follow animation and code standards', severity: 'low', message: `Section missing ${[!s.hasPaddingGlobal && 'padding-global', !s.hasContainer && 'container-*'].filter(Boolean).join(' + ')}`, element: s.el, fix: { via: 'element', hint: 'Wrap content: section_ > padding-global > container-*' } });
  });
  d.comboDepth.forEach((e) => pf({ check: 'cf-combo-depth', phase: 'Build reusable components', severity: 'low', message: `Element stacks ${e.count} classes`, element: e, fix: { via: 'style', hint: 'Move utility values into the element class, set single class, remove orphan combo' } }));

  // Performance (DOM level)
  d.headScripts.filter((s) => !s.async && !s.defer && s.type !== 'module' && !/jquery|webflow\.[a-z0-9]+\.js|webfont\.js/i.test(s.src)).forEach((s) => pf({ check: 'render-blocking-script', phase: 'Complete performance review', severity: 'medium', message: `Render-blocking script in <head>: ${s.src}`, fix: { via: 'custom-code', hint: 'Add defer/async or move to footer' } }));
  const totalKb = Math.round(responses.reduce((a, r) => a + r.size, 0) / 1024);
  if (totalKb > 3000) pf({ check: 'page-weight', phase: 'Complete performance review', severity: totalKb > 6000 ? 'high' : 'medium', message: `Page weight ~${totalKb} KB (sum of content-length after full scroll, includes video streams)`, fix: { via: 'manual' } });

  // Analytics
  const a = d.analytics;
  const tagIds = a.gtagSrcs.map((s) => new URL(s).searchParams.get('id'));
  const malformed = tagIds.filter((id) => id && !/^(G|GTM|AW|DC|GT|UA)-[A-Z0-9-]+$/.test(id));
  if (malformed.length) pf({ check: 'analytics-malformed-id', phase: 'Configure scripts and analytics', severity: 'high', message: `Google tag loaded with malformed ID: ${malformed.join(', ')}`, detail: a.gtagSrcs, fix: { via: 'custom-code', hint: 'Remove the duplicate snippet or fix the ID (Site settings → Custom code / Integrations → Google Analytics)' } });
  if (a.gtmScriptTags > 1 || a.gtagScriptTags > 1 || new Set(a.gtm).size > 1) pf({ check: 'analytics-duplicate', phase: 'Configure scripts and analytics', severity: 'high', message: `Google tag loaded ${a.gtmScriptTags + a.gtagScriptTags} times`, detail: a.gtagSrcs, fix: { via: 'custom-code', hint: 'Keep one: either Webflow Integrations GA field or a custom-code snippet' } });

  // Runtime
  const errs = consoleMsgs.filter((m) => m.type !== 'warning');
  if (errs.length) pf({ check: 'console-errors', phase: 'Follow animation and code standards', severity: 'high', message: `${errs.length} console errors/exceptions`, detail: errs.slice(0, 10), fix: { via: 'custom-code' } });
  const warns = consoleMsgs.filter((m) => m.type === 'warning');
  if (warns.length) pf({ check: 'console-warnings', phase: 'Follow animation and code standards', severity: 'low', message: `${warns.length} console warnings`, detail: warns.slice(0, 10), fix: { via: 'custom-code' } });
  const bad = responses.filter((r) => r.status >= 400).map((r) => ({ url: r.url, status: r.status })).concat(failed.filter((f) => !/ERR_ABORTED/.test(f.error || '')));
  if (bad.length) pf({ check: 'failed-requests', phase: 'Complete self-review', severity: 'high', message: `${bad.length} failed network requests`, detail: bad.slice(0, 15), fix: { via: 'manual' } });

  // Accessibility (axe-core)
  const ownRules = new Set(['page-has-heading-one', 'heading-order', 'html-has-lang', 'duplicate-id', 'duplicate-id-active', 'duplicate-id-aria', 'image-alt', 'link-name']);
  try {
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    const sev = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' };
    axe.violations.filter((v) => !ownRules.has(v.id)).forEach((v) => pf({
      check: `axe:${v.id}`, phase: 'Complete accessibility review', severity: sev[v.impact] || 'medium',
      message: `${v.help} (${v.nodes.length} nodes)`,
      detail: v.nodes.slice(0, 8).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.split('\n').slice(0, 3).join(' ') })),
      fix: { via: v.id === 'color-contrast' ? 'style' : 'element', hint: v.helpUrl },
    }));
  } catch (e) {
    pf({ check: 'axe-failed', phase: 'Complete accessibility review', severity: 'info', message: `axe run failed: ${e.message}`, fix: { via: 'manual' } });
  }

  // Keyboard
  const kb = await keyboardWalk(page);
  if (kb.trap) pf({ check: 'keyboard-trap', phase: 'Complete accessibility review', severity: 'critical', message: `Keyboard focus appears trapped at ${kb.trapAt}`, fix: { via: 'custom-code' } });
  if (kb.noFocusStyle.length) pf({ check: 'focus-not-visible', phase: 'Complete accessibility review', severity: 'medium', message: `${kb.noFocusStyle.length} focusable elements show no visible focus change`, detail: kb.noFocusStyle.map((n) => ({ selector: n.selector, classes: n.classes })), fix: { via: 'style', hint: 'Add :focus-visible state on the class' } });

  // Responsive checks run on the DOM at every width. Screenshots are evidence only:
  // 'issues' (default) = one viewport shot around the first offending element, 'all' = full pages, 'none'.
  const shotDir = path.join(outDir, 'screens', slug);
  await fs.mkdir(shotDir, { recursive: true });
  const shots = [];
  const shoot = async (w, top, tag) => {
    if (args.screens === 'none') return null;
    const vh = page.viewportSize().height;
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y)), top - vh / 3);
    await page.waitForTimeout(400);
    const file = path.join(shotDir, `${w}-${tag}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    const rel = path.relative(outDir, file);
    shots.push(rel);
    return rel;
  };
  const layout = {};
  for (const w of args.widths) {
    await page.setViewportSize({ width: w, height: w <= 479 ? 812 : 900 });
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    await handleConsent(page, args.consent, { waitMs: 0 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await scrollThrough(page);
    const l = await page.evaluate(layoutAudit, w);
    layout[w] = l;
    const firstOver = l.overflow[0];
    const overShot = (l.hScroll || l.overflow.length) && firstOver && args.screens !== 'all' ? await shoot(w, firstOver.top, 'overflow') : null;
    const tapShot = l.taps.length && args.screens !== 'all' ? await shoot(w, l.taps[0].top, 'taps') : null;
    if (l.hScroll) pf({ evidence: overShot, check: 'horizontal-scroll', phase: 'Follow responsive best practice', severity: 'high', message: `Horizontal scroll at ${w}px (scrollWidth ${l.scrollWidth} > ${l.vw})`, detail: l.overflow, breakpoint: w, fix: { via: 'style', hint: `Fix width/overflow on the listed classes at the ${w}px breakpoint` } });
    else if (l.overflow.length) pf({ evidence: overShot, check: 'element-overflow', phase: 'Follow responsive best practice', severity: 'medium', message: `${l.overflow.length} elements extend past the viewport at ${w}px`, detail: l.overflow, breakpoint: w, fix: { via: 'style' } });
    if (l.taps.length) pf({ evidence: tapShot, check: 'tap-target-small', phase: 'Follow responsive best practice', severity: 'medium', message: `${l.taps.length} tap targets under 24×24px at ${w}px`, detail: l.taps, breakpoint: w, fix: { via: 'style' } });
    if (args.screens === 'all') {
      await page.screenshot({ path: path.join(shotDir, `${w}.png`), fullPage: true }).catch(() => {});
      shots.push(path.join('screens', slug, `${w}.png`));
    }
  }

  await fs.mkdir(path.join(outDir, 'text'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'text', `${slug}.txt`), d.bodyText);

  await ctx.close();
  console.log(`  [${idx + 1}] ${url} — done`);
  return {
    url, slug, status, wf, title: d.title, description: d.description,
    headings: d.headings.map((h) => `h${h.level}: ${h.text}`),
    links: d.links.map((l) => ({ href: l.href, abs: l.abs })),
    altList: d.altList, classUse: d.classUse, analytics: d.analytics,
    webflowBadge: d.webflowBadge,
    forms: d.forms,
    shots,
    consent,
  };
}

// ---------- Site-level checks ----------

async function checkLinks(pages) {
  const internal = new Map();
  const external = new Map();
  for (const p of pages) {
    for (const l of p.links) {
      if (!l.abs || !/^https?:/.test(l.abs)) continue;
      const u = normalizeUrl(l.abs);
      const target = new URL(u).origin === origin ? internal : external;
      if (!target.has(u)) target.set(u, new Set());
      target.get(u).add(p.url);
    }
  }
  const check = async ([u, from], isInternal) => {
    const r = await followChain(u);
    const fromList = [...from].slice(0, 5);
    if (r.status === 'loop') add({ check: 'redirect-loop', phase: 'Configure redirects', severity: 'critical', message: `Redirect loop: ${u}`, detail: r.chain, pages: fromList, fix: { via: 'redirects' } });
    else if (r.status === 'too-many-redirects') add({ check: 'redirect-chain', phase: 'Configure redirects', severity: 'high', message: `>10 redirects: ${u}`, detail: r.chain, pages: fromList, fix: { via: 'redirects' } });
    else if (r.status === 'error') add({ check: isInternal ? 'link-broken-internal' : 'link-broken-external', phase: 'Complete self-review', severity: isInternal ? 'high' : 'low', message: `${u} → ${r.error}`, pages: fromList, fix: { via: 'element', hint: 'Update link URL on the listed pages' } });
    else if (r.status >= 400 && !(isInternal === false && [401, 403, 429, 999].includes(r.status))) add({ check: isInternal ? 'link-broken-internal' : 'link-broken-external', phase: 'Complete self-review', severity: isInternal ? 'high' : 'medium', message: `${u} → HTTP ${r.status}`, pages: fromList, fix: { via: 'element', hint: 'Update link URL on the listed pages' } });
    else if (r.chain.length > 2) add({ check: 'redirect-chain', phase: 'Configure redirects', severity: 'medium', message: `Redirect chain (${r.chain.length - 1} hops): ${u}`, detail: r.chain, pages: fromList, fix: { via: isInternal ? 'element' : 'manual', hint: 'Link directly to the final URL' } });
    else if (isInternal && r.chain.length === 2) add({ check: 'internal-link-redirects', phase: 'Configure redirects', severity: 'low', message: `Internal link redirects: ${u} → ${r.final}`, pages: fromList, fix: { via: 'element', hint: 'Link directly to the final URL' } });
  };
  console.log(`Checking ${internal.size} internal and ${args.externalLinks ? external.size : 0} external links…`);
  await pool([...internal], 8, (e) => check(e, true));
  if (args.externalLinks) await pool([...external], 8, (e) => check(e, false));
}

async function checkDeclaredRedirects() {
  if (!args.redirects) return;
  const raw = await fs.readFile(args.redirects, 'utf8');
  const rows = raw.split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''))).filter((r) => r[0]?.startsWith('/'));
  await pool(rows, 6, async ([from, to]) => {
    const r = await followChain(origin + from);
    const first = r.chain[0];
    const expected = to ? new URL(to, origin).href.replace(/\/$/, '') : null;
    if (!first || ![301, 308].includes(first.status)) add({ check: 'redirect-not-live', phase: 'Configure redirects', severity: 'high', message: `${from} returns ${first?.status ?? r.status}, expected 301 → ${to}`, fix: { via: 'redirects', hint: 'Site settings → Publishing → 301 redirects' } });
    else if (expected && r.final.replace(/\/$/, '') !== expected) add({ check: 'redirect-wrong-target', phase: 'Configure redirects', severity: 'high', message: `${from} ends at ${r.final}, expected ${to}`, detail: r.chain, fix: { via: 'redirects' } });
  });
}

function checkDuplicatesAndNaming(pages, fullCrawl) {
  const byTitle = {};
  const byDesc = {};
  pages.forEach((p) => {
    if (p.title) (byTitle[p.title] ||= []).push(p.url);
    if (p.description) (byDesc[p.description] ||= []).push(p.url);
  });
  Object.entries(byTitle).filter(([, u]) => u.length > 1).forEach(([t, u]) => add({ check: 'title-duplicate', phase: 'Complete SEO setup', severity: 'medium', message: `${u.length} pages share title "${t}"`, pages: u, fix: { via: 'page-settings' } }));
  Object.entries(byDesc).filter(([, u]) => u.length > 1).forEach(([t, u]) => add({ check: 'description-duplicate', phase: 'Complete SEO setup', severity: 'medium', message: `${u.length} pages share description`, detail: t, pages: u, fix: { via: 'page-settings' } }));

  if (env === 'production' && pages.some((p) => p.webflowBadge)) add({ check: 'webflow-badge', phase: 'Complete launch preparation', severity: 'medium', message: 'Made in Webflow badge visible on production', fix: { via: 'site-settings', hint: 'Requires paid site plan; General → hide badge' } });
  if (!pages.some((p) => p.analytics.gtm.length || p.analytics.ga4.length)) add({ check: 'analytics-missing', phase: 'Configure scripts and analytics', severity: env === 'production' ? 'high' : 'info', message: 'No GTM or GA4 found on any audited page', fix: { via: 'custom-code' } });
  if (!pages.some((p) => p.analytics.consent)) add({ check: 'consent-missing', phase: 'Configure scripts and analytics', severity: env === 'production' ? 'high' : 'info', message: 'No known consent banner detected', fix: { via: 'custom-code' } });
  if (pages.some((p) => (p.analytics.gtm.length || p.analytics.ga4.length) && p.analytics.dataLayer === null)) add({ check: 'datalayer-missing', phase: 'Configure scripts and analytics', severity: 'medium', message: 'Tracking IDs present but window.dataLayer is not initialised', fix: { via: 'custom-code' } });

  // Client-First naming
  const classes = {};
  pages.forEach((p) => Object.entries(p.classUse).forEach(([c, n]) => { classes[c] = (classes[c] || 0) + n; }));
  const bad = [];
  const thirdParty = /^(fs[-_]|iconify|swiper|splide|glide|slick|lenis|gsap|lottie|cky-|cc-|ot-|onetrust|cookiebot|hs-|hubspot|jotform|calendly|fancybox|plyr|vimeo|ytp-|embedly|w-)/;
  Object.keys(classes).filter((c) => !thirdParty.test(c)).forEach((c) => {
    const reasons = [];
    if (/[A-Z]/.test(c)) reasons.push('uppercase');
    if (/__|--/.test(c)) reasons.push('double separator (BEM-style)');
    if ((c.match(/_/g) || []).length > 1) reasons.push('more than one underscore');
    if (/^[-_]|[-_]$/.test(c)) reasons.push('leading/trailing separator');
    if (/\s|[^a-zA-Z0-9_-]/.test(c)) reasons.push('invalid character');
    if (/^(div-block|text-block|heading|link-block|image|paragraph|button|container|section|columns|column|grid|quick-stack|form-block|link)(-\d+)?$/.test(c) && /-\d+$/.test(c)) reasons.push('Webflow auto-generated name');
    if (reasons.length) bad.push({ class: c, uses: classes[c], reasons });
  });
  if (bad.length) add({ check: 'cf-class-naming', phase: 'Build reusable components', severity: 'low', message: `${bad.length} class names break Client-First conventions`, detail: bad.slice(0, 60), fix: { via: 'style', hint: 'Rename via MCP data_style_tool; check custom code/JS references first' } });

  return { classes, fullCrawl };
}

async function checkOrphanClasses(classes, fullCrawl, firstPageUrl) {
  if (!fullCrawl) return;
  const res = await fetchText(firstPageUrl);
  const cssHref = res.text.match(/<link[^>]+href="([^"]+website-files\.com[^"]+\.css)"/)?.[1] || res.text.match(/<link[^>]+href="([^"]+\.webflow\.[^"]*\.css)"/)?.[1];
  if (!cssHref) return;
  const css = (await fetchText(new URL(cssHref, firstPageUrl).href)).text;
  const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)].map((m) => m[1]).filter((c) => !c.startsWith('w-') && !/^(is-|hide|text-|heading-|padding-|margin-|spacer-|max-width-|container-|button|icon-|layer|align-|overflow-|z-index|pointer-|aspect-|background-color|form_|fs-)/.test(c)));
  const orphans = [...defined].filter((c) => !classes[c]);
  if (orphans.length) add({ check: 'cf-orphan-classes', phase: 'Build reusable components', severity: 'info', message: `${orphans.length} custom classes defined in CSS but unused on crawled pages (utilities excluded; verify in Style manager → Clean up)`, detail: orphans.slice(0, 100), fix: { via: 'style', hint: 'Remove unused styles via MCP after checking CMS templates and unaudited pages' } });
}

async function runPsi(urls) {
  const out = [];
  for (const u of urls.slice(0, args.psi)) {
    for (const strategy of ['mobile', 'desktop']) {
      const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(u)}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo`;
      try {
        const res = await http(api, { redirect: 'follow', timeout: 120000 });
        if (!res.ok) { out.push({ url: u, strategy, error: `PSI HTTP ${res.status}` }); continue; }
        const j = await res.json();
        const lh = j.lighthouseResult;
        const score = (k) => Math.round((lh.categories[k]?.score ?? 0) * 100);
        const audit = (k) => lh.audits[k]?.displayValue || null;
        const field = j.loadingExperience?.metrics || {};
        const r = {
          url: u, strategy,
          scores: { performance: score('performance'), accessibility: score('accessibility'), bestPractices: score('best-practices'), seo: score('seo') },
          lab: { LCP: audit('largest-contentful-paint'), CLS: audit('cumulative-layout-shift'), TBT: audit('total-blocking-time'), FCP: audit('first-contentful-paint') },
          field: { LCP: field.LARGEST_CONTENTFUL_PAINT_MS?.category, CLS: field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category, INP: field.INTERACTION_TO_NEXT_PAINT?.category },
          opportunities: ['render-blocking-resources', 'unused-javascript', 'unused-css-rules', 'total-byte-weight', 'modern-image-formats', 'uses-responsive-images'].map((k) => ({ id: k, value: audit(k) })).filter((o) => o.value),
        };
        out.push(r);
        const threshold = strategy === 'mobile' ? 70 : 85;
        if (r.scores.performance < threshold) add({ page: u, check: 'lighthouse-performance', phase: 'Complete performance review', severity: r.scores.performance < 50 ? 'high' : 'medium', message: `Lighthouse ${strategy} performance ${r.scores.performance} (< ${threshold})`, detail: r, fix: { via: 'manual' } });
      } catch (e) {
        out.push({ url: u, strategy, error: e.message });
      }
    }
  }
  return out;
}

// ---------- Report ----------

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// Per-element checks are merged into one finding per page so the report stays readable.
const AGGREGATE = {
  'img-alt-missing': 'images without alt attribute',
  'img-empty-src': 'visible images with empty src',
  'img-broken': 'broken image sources',
  'img-heavy': `images above the size limit`,
  'img-legacy-format': 'raster images not in WebP/AVIF',
  'img-oversized': 'images much larger than rendered size',
  'img-no-srcset': 'large images without srcset',
  'img-not-lazy': 'below-the-fold images not lazy loaded',
  'duplicate-id': 'duplicate element IDs',
  'link-empty': 'links with empty or # href',
  'link-no-name': 'links without accessible name',
  'heading-skip': 'skipped heading levels',
  'heading-empty': 'empty headings',
  'render-blocking-script': 'render-blocking scripts in <head>',
  'cf-section-wrappers': 'sections missing padding-global / container-*',
  'cf-combo-depth': 'elements stacking more than 4 classes',
  'video-autoplay-attrs': 'autoplay videos missing muted/playsinline',
  'cf-section-tag': 'section_ wrappers not rendered as <section>',
  'cf-section-class-misuse': 'section_ classes used on non-wrapper elements',
};

function aggregate() {
  const groups = new Map();
  const rest = [];
  for (const f of findings) {
    if (!AGGREGATE[f.check]) { rest.push(f); continue; }
    const key = f.check + '|' + f.page;
    if (!groups.has(key)) groups.set(key, { ...f, items: [], severity: f.severity });
    const g = groups.get(key);
    if (SEV_ORDER[f.severity] < SEV_ORDER[g.severity]) g.severity = f.severity;
    const item = { message: f.message, ...(f.element ? { element: f.element } : {}), ...(f.detail ? { detail: f.detail } : {}) };
    const sig = JSON.stringify(item.detail?.src ?? item);
    if (!g.items.some((x) => JSON.stringify(x.detail?.src ?? x) === sig)) g.items.push(item);
  }
  for (const g of groups.values()) {
    g.message = `${g.items.length} ${AGGREGATE[g.check]}`;
    delete g.element;
    delete g.detail;
    rest.push(g);
  }
  findings.length = 0;
  rest.forEach((f, i) => findings.push({ ...f, id: `F${String(i + 1).padStart(4, '0')}` }));
}

function dedupe() {
  const seen = new Set();
  for (let i = findings.length - 1; i >= 0; i--) {
    const k = findings[i].dedupeKey;
    if (!k) continue;
    if (seen.has(k)) findings.splice(i, 1);
    else seen.add(k);
  }
}

function summaryMd(pages, psi) {
  const byPhase = {};
  findings.forEach((f) => { (byPhase[f.phase] ||= []).push(f); });
  const counts = Object.fromEntries(Object.keys(SEV_ORDER).map((s) => [s, findings.filter((f) => f.severity === s).length]));
  let md = `# Webflow QA — Layer 1 results\n\n- Site: ${origin} (${env})\n- Pages audited: ${pages.length}\n- Webflow site ID: ${pages.find((p) => p.wf.siteId)?.wf.siteId ?? 'n/a'}\n- Findings: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}\n\n`;
  if (psi.length) {
    md += `## Lighthouse (PageSpeed Insights)\n\n| URL | Strategy | Perf | A11y | BP | SEO | LCP | CLS | TBT | Field INP |\n|---|---|---|---|---|---|---|---|---|---|\n`;
    psi.forEach((r) => { md += r.error ? `| ${r.url} | ${r.strategy} | ${r.error} |||||||| \n` : `| ${r.url} | ${r.strategy} | ${r.scores.performance} | ${r.scores.accessibility} | ${r.scores.bestPractices} | ${r.scores.seo} | ${r.lab.LCP} | ${r.lab.CLS} | ${r.lab.TBT} | ${r.field.INP ?? '—'} |\n`; });
    md += '\n';
  }
  Object.entries(byPhase).forEach(([phase, list]) => {
    md += `## ${phase}\n\n`;
    list.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]).forEach((f) => {
      md += `- **${f.severity}** \`${f.check}\` ${f.message}${f.page ? ` — ${new URL(f.page).pathname}` : ''}${f.pages ? ` — ${f.pages.length} page(s)` : ''} → fix via \`${f.fix?.via ?? 'manual'}\` (${f.id})\n`;
    });
    md += '\n';
  });
  return md;
}

// ---------- Main ----------

(async () => {
  const entry = await followChain(args.url + '/');
  if (entry.final && /^https?:/.test(entry.final)) {
    const finalOrigin = new URL(entry.final).origin;
    if (finalOrigin !== origin) console.log(`Note: ${origin} redirects to ${finalOrigin}, auditing the final host.`);
    origin = finalOrigin;
    host = new URL(finalOrigin).host;
  }
  env = args.env !== 'auto' ? args.env : (host.endsWith('.webflow.io') ? 'staging' : 'production');
  outDir = path.resolve(args.out, host, stamp);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Webflow QA → ${origin} (${env})\nOutput: ${outDir}`);

  const { pages: sitemapPages } = await discoverPages();
  let targets;
  if (args.scope === 'single') targets = [origin + '/'];
  else if (args.scope === 'list') targets = args.pages.map((p) => (p.startsWith('http') ? origin + new URL(p).pathname : origin + (p.startsWith('/') ? p : '/' + p)));
  else targets = sitemapPages.length ? sitemapPages : [origin + '/'];
  const fullCrawl = args.scope === 'sitemap' && targets.length <= args.maxPages;
  targets = targets.slice(0, args.maxPages);
  console.log(`Auditing ${targets.length} page(s)…`);

  const browser = await chromium.launch();
  const pages = [];
  for (let i = 0; i < targets.length; i++) {
    const r = await auditPage(browser, targets[i], i);
    if (r) pages.push(r);
  }
  await browser.close();

  await checkLinks(pages);
  await checkDeclaredRedirects();
  const { classes } = checkDuplicatesAndNaming(pages, fullCrawl);
  await checkOrphanClasses(classes, fullCrawl, targets[0]);
  console.log(args.psi ? `Running PageSpeed Insights on ${Math.min(args.psi, targets.length)} page(s)…` : 'PSI skipped');
  const psi = args.psi ? await runPsi(targets) : [];

  dedupe();
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  aggregate();

  // Inputs for the Claude (Layer 2) review.
  const review = {
    altText: pages.flatMap((p) => p.altList.map((a) => ({ page: p.url, ...a }))),
    headings: Object.fromEntries(pages.map((p) => [p.url, p.headings])),
    classInventory: classes,
    pagesWithForms: pages.filter((p) => p.forms).map((p) => ({ url: p.url, forms: p.forms })),
    pages: pages.map((p) => ({ url: p.url, slug: p.slug, wf: p.wf, title: p.title, description: p.description, screenshots: p.shots, text: `text/${p.slug}.txt` })),
  };

  await fs.writeFile(path.join(outDir, 'findings.json'), JSON.stringify({ site: origin, env, generated: new Date().toISOString(), pagesAudited: pages.length, options: { psi: args.psi, redirects: !!args.redirects, stage: args.stage, scope: args.scope }, findings }, null, 2));
  await fs.writeFile(path.join(outDir, 'review-inputs.json'), JSON.stringify(review, null, 2));
  await fs.writeFile(path.join(outDir, 'psi.json'), JSON.stringify(psi, null, 2));
  await fs.writeFile(path.join(outDir, 'summary.md'), summaryMd(pages, psi));
  const { md } = await render(outDir, { stage: args.stage });
  console.log('\n' + md);
  console.log(`\nDone. ${findings.length} findings.\n${outDir}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

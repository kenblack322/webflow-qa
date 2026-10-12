#!/usr/bin/env node
// Download raster images flagged by qa.mjs and convert them to WebP locally with cwebp.
// Output: <report>/webp/*.webp + manifest.json for the upload/rebind step via Webflow MCP.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const reportDir = process.argv[2];
if (!reportDir) {
  console.error('Usage: node scripts/webp.mjs reports/<host>/<timestamp> [--checks img-legacy-format,img-heavy,img-oversized] [--max-width 2560]');
  process.exit(2);
}
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const checks = opt('--checks', 'img-legacy-format,img-heavy,img-oversized').split(',');
const maxWidth = Number(opt('--max-width', 2560));

const { findings } = JSON.parse(await fs.readFile(path.join(reportDir, 'findings.json'), 'utf8'));
const review = JSON.parse(await fs.readFile(path.join(reportDir, 'review-inputs.json'), 'utf8'));
const altBySrc = new Map(review.altText.map((a) => [a.src, a.alt]));

// Read pixel width from the file header (PNG, JPEG, GIF, WebP) without platform tools.
function imageWidth(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf.toString('ascii', 0, 3) === 'GIF') return buf.readUInt16LE(6);
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return 1 + buf.readUIntLE(24, 3);
    if (chunk === 'VP8L') return 1 + (buf.readUInt16LE(21) & 0x3fff);
    return buf.readUInt16LE(26) & 0x3fff;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return buf.readUInt16BE(i + 7);
      i += 2 + len;
    }
  }
  return 0;
}

// Webflow serves responsive variants as name-p-800.jpg; the asset original has no -p-NNN suffix.
const original = (src) => src.replace(/-p-\d+(\.[a-z]+)(\?.*)?$/i, '$1');

const images = new Map();
for (const f of findings.filter((x) => checks.includes(x.check))) {
  for (const it of f.items || [{ detail: f.detail, element: f.element }]) {
    const src = it.detail?.src;
    if (!src || /\.(svg|webp|avif)(\?|$)/i.test(src)) continue;
    const key = original(src);
    if (!images.has(key)) images.set(key, { src: key, seenAs: new Set(), pages: new Set(), checks: new Set(), alt: altBySrc.get(src) ?? null, element: it.element || null, wf: f.wf || null });
    const img = images.get(key);
    img.seenAs.add(src);
    if (f.page) img.pages.add(f.page);
    img.checks.add(f.check);
  }
}

const outDir = path.join(reportDir, 'webp');
await fs.mkdir(path.join(outDir, 'src'), { recursive: true });
const manifest = [];

for (const img of images.values()) {
  const name = decodeURIComponent(new URL(img.src).pathname.split('/').pop()).replace(/^[0-9a-f]{24}_/, '');
  const srcFile = path.join(outDir, 'src', name);
  const webpFile = path.join(outDir, name.replace(/\.[a-z]+$/i, '.webp'));
  try {
    const res = await fetch(img.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(srcFile, Buffer.from(await res.arrayBuffer()));
    const width = imageWidth(await fs.readFile(srcFile));
    const isPng = /\.png$/i.test(name);
    const args = isPng ? ['-q', '90', '-alpha_q', '100'] : ['-q', '80'];
    if (width > maxWidth) args.push('-resize', String(maxWidth), '0');
    execFileSync('cwebp', [...args, srcFile, '-o', webpFile], { stdio: 'ignore' });
    const before = (await fs.stat(srcFile)).size;
    const after = (await fs.stat(webpFile)).size;
    if (after >= before * 0.95) {
      await fs.rm(webpFile);
      manifest.push({ src: img.src, skipped: true, reason: `WebP not smaller (${Math.round(before / 1024)} → ${Math.round(after / 1024)} KB); keep original or replace with SVG`, pages: [...img.pages] });
      console.log(`${name}: skipped, WebP not smaller`);
      continue;
    }
    const md5 = crypto.createHash('md5').update(await fs.readFile(webpFile)).digest('hex');
    manifest.push({
      src: img.src, seenAs: [...img.seenAs], file: webpFile, fileName: path.basename(webpFile), md5,
      kbBefore: Math.round(before / 1024), kbAfter: Math.round(after / 1024), width, resizedTo: width > maxWidth ? maxWidth : null,
      alt: img.alt, pages: [...img.pages], checks: [...img.checks], element: img.element, wf: img.wf,
    });
    console.log(`${name}: ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB`);
  } catch (e) {
    manifest.push({ src: img.src, error: e.message });
    console.log(`${name}: failed (${e.message})`);
  }
}

await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const ok = manifest.filter((m) => !m.error && !m.skipped);
const saved = ok.reduce((a, m) => a + m.kbBefore - m.kbAfter, 0);
console.log(`\n${ok.length}/${manifest.length} converted, ~${saved} KB saved\n${path.join(outDir, 'manifest.json')}`);

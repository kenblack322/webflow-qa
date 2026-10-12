#!/usr/bin/env node
// Render the checklist from findings.json (+ review.json, forms/*.json) into fixed-format
// checklist.json, checklist.md and checklist.html. Output format never depends on the model.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// type: auto = covered by scripts, review = Claude (Layer 2), process = team step, not auditable from the site.
export const CHECKLIST = [
  ['Before Starting', 'Review approved designs', 'process'],
  ['Before Starting', 'Review responsive specifications', 'process'],
  ['Before Starting', 'Confirm project access', 'process'],
  ['Before Starting', 'Decide build approach', 'process'],
  ['Before Starting', 'Duplicate existing website', 'process'],
  ['Before Starting', 'Define build strategy', 'process'],
  ['Before Starting', 'Configure project foundation', 'process'],
  ['During Development', 'Build reusable components', 'auto', ['Build reusable components']],
  ['During Development', 'Implement CMS correctly', 'auto', ['Validate CMS']],
  ['During Development', 'Follow typography and spacing system', 'auto', ['Follow typography and spacing system']],
  ['During Development', 'Optimise media', 'auto', ['Optimise media']],
  ['During Development', 'Follow responsive best practice', 'auto', ['Follow responsive best practice']],
  ['During Development', 'Follow accessibility best practice', 'auto', ['Complete accessibility review']],
  ['During Development', 'Configure forms and integrations', 'auto', ['Configure forms and integrations']],
  ['During Development', 'Follow animation and code standards', 'auto', ['Follow animation and code standards']],
  ['Before Internal QA', 'Complete build', 'process'],
  ['Before Internal QA', 'Compare build against Figma', 'review'],
  ['Before Internal QA', 'Validate typography and spacing', 'auto', ['Follow typography and spacing system']],
  ['Before Internal QA', 'Validate CMS', 'auto', ['Validate CMS']],
  ['Before Internal QA', 'Test forms and integrations', 'auto', ['Configure forms and integrations']],
  ['Before Internal QA', 'Assess redirect requirements', 'review'],
  ['Before Internal QA', 'Configure redirects', 'auto', ['Configure redirects']],
  ['Before Internal QA', 'Complete SEO setup', 'auto', ['Complete SEO setup']],
  ['Before Internal QA', 'Configure scripts and analytics', 'auto', ['Configure scripts and analytics']],
  ['Before Internal QA', 'Complete accessibility review', 'auto', ['Complete accessibility review']],
  ['Before Internal QA', 'Complete performance review', 'auto', ['Complete performance review']],
  ['Before Internal QA', 'Document approved deviations', 'process'],
  ['Before Internal QA', 'Complete self-review', 'auto', ['Complete self-review']],
  ['Before Internal QA', 'Notify Project Manager', 'process'],
  ['Before Client QA', 'Address internal QA feedback', 'auto', ['*']],
  ['Before Client QA', 'Update staging', 'process'],
  ['Before Client QA', 'Confirm client QA readiness', 'auto', ['*blockers']],
  ['Before Launch', 'Duplicate final website', 'process'],
  ['Before Launch', 'Transfer website', 'process'],
  ['Before Launch', 'Complete launch preparation', 'auto', ['Complete launch preparation']],
  ['Before Launch', 'Complete final validation', 'auto', ['Complete final validation', 'Complete self-review']],
];

const STAGES = ['Before Starting', 'During Development', 'Before Internal QA', 'Before Client QA', 'Before Launch'];
const STAGE_SCOPE = {
  'internal-qa': ['During Development', 'Before Internal QA'],
  'client-qa': ['During Development', 'Before Internal QA', 'Before Client QA'],
  launch: ['During Development', 'Before Internal QA', 'Before Client QA', 'Before Launch'],
  live: ['During Development', 'Before Internal QA', 'Before Client QA', 'Before Launch'],
};
const SEV = ['critical', 'high', 'medium', 'low', 'info'];
export const MCP_FIXABLE = new Set(['page-settings', 'cms', 'asset', 'element', 'style', 'custom-code']);
const FIX_LABEL = {
  'page-settings': 'MCP · page settings', cms: 'MCP · CMS', asset: 'MCP · assets', element: 'MCP · elements',
  style: 'MCP · styles', 'custom-code': 'MCP · custom code', 'site-settings': 'Manual · site settings',
  redirects: 'Manual · redirects', manual: 'Manual',
};
const STATUS = {
  pass: { md: '✅ Pass', label: 'Pass', tone: 'success' },
  open: { md: '❌ Open', label: 'Open', tone: 'danger' },
  partial: { md: '🟡 Partial', label: 'Partial', tone: 'warning' },
  unchecked: { md: '⚪ Not checked', label: 'Not checked', tone: 'neutral' },
  review: { md: '👁 Needs review', label: 'Needs review', tone: 'accent' },
  process: { md: '— Process', label: 'Process', tone: 'neutral' },
};

const short = (f) => {
  const where = f.page ? ` (${new URL(f.page).pathname})` : f.pages?.length ? ` (${f.pages.length} pages)` : '';
  return f.message.replace(/\s+/g, ' ').slice(0, 90) + where;
};

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function render(reportDir, { stage } = {}) {
  const data = await readJson(path.join(reportDir, 'findings.json'), null);
  if (!data) throw new Error(`No findings.json in ${reportDir}`);
  const opts = data.options || {};
  const scopeStage = stage || opts.stage || (data.env === 'production' ? 'live' : 'internal-qa');

  // review.json: Claude's Layer 2 results. Entries either close an item (status only) or add issues.
  // [{ "item": "<checklist item>", "status": "pass|open|unchecked", "severity": "high", "message": "...", "page": "https://...", "fix": "style" }]
  const review = await readJson(path.join(reportDir, 'review.json'), []);
  const reviewFindings = review.filter((r) => r.message && r.item).map((r, i) => ({
    id: `R${String(i + 1).padStart(3, '0')}`, check: 'review', severity: r.severity || 'medium',
    phase: r.item, page: r.page || null, message: r.message, fix: { via: r.fix || 'manual' }, fromReview: true,
  }));
  const reviewStatus = Object.fromEntries(review.filter((r) => r.item && r.status && !r.message).map((r) => [r.item, r.status]));

  // forms/*.json from form-test.mjs.
  const formFindings = [];
  let formsTested = false;
  try {
    for (const f of await fs.readdir(path.join(reportDir, 'forms'))) {
      const ft = await readJson(path.join(reportDir, 'forms', f), null);
      if (!ft) continue;
      formsTested = true;
      for (const r of ft.results || []) {
        if (r.status === 'success' && !r.notes.length) continue;
        if (r.status === 'skipped') continue;
        formFindings.push({ id: `FT${formFindings.length + 1}`, check: 'form-test', severity: r.status === 'success' ? 'low' : 'high', phase: 'Configure forms and integrations', page: ft.url, message: `Form "${r.name}": ${r.status}${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`, fix: { via: 'element' } });
      }
    }
  } catch { /* no forms dir */ }

  const dismissed = new Set(review.filter((r) => r.dismiss).map((r) => r.dismiss));
  const all = [...data.findings, ...formFindings, ...reviewFindings].filter((f) => f.severity !== 'info' && !dismissed.has(f.id));

  const rows = CHECKLIST.map(([stg, item, type, from = []]) => {
    let list = [];
    if (from[0] === '*') list = all;
    else if (from[0] === '*blockers') list = all.filter((f) => ['critical', 'high'].includes(f.severity));
    else list = all.filter((f) => from.includes(f.phase) || f.phase === item);
    list.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));

    let status = type === 'process' ? 'process' : list.length ? 'open' : type === 'review' ? 'review' : 'pass';
    let note = null;
    if (status === 'pass' && item === 'Configure redirects' && !opts.redirects) { status = 'unchecked'; note = 'No redirect map provided'; }
    if (status === 'pass' && item === 'Complete performance review' && !opts.psi) { status = 'partial'; note = 'Lighthouse skipped, DOM checks only'; }
    if (status === 'pass' && /forms/i.test(item) && !formsTested) { status = 'partial'; note = 'Markup only, form submit not tested'; }
    if (reviewStatus[item] && !list.length) { status = reviewStatus[item]; note = null; }

    const worst = list[0]?.severity || null;
    const fixes = [...new Set(list.map((f) => f.fix?.via || 'manual'))];
    const what = list.slice(0, 3).map(short);
    if (list.length > 3) what.push(`+${list.length - 3} more`);
    return {
      stage: stg, item, type, status, worst, note,
      issues: list.length,
      fixable: list.filter((f) => MCP_FIXABLE.has(f.fix?.via)).length,
      what, fix: fixes.map((v) => FIX_LABEL[v] || v),
      fixShort: [list.filter((f) => MCP_FIXABLE.has(f.fix?.via)).length && `MCP ${list.filter((f) => MCP_FIXABLE.has(f.fix?.via)).length}`, list.filter((f) => !MCP_FIXABLE.has(f.fix?.via)).length && `Manual ${list.filter((f) => !MCP_FIXABLE.has(f.fix?.via)).length}`].filter(Boolean).join(' · '),
      findingIds: list.map((f) => f.id),
    };
  });

  const inScope = STAGE_SCOPE[scopeStage] || STAGE_SCOPE['internal-qa'];
  const visible = rows.filter((r) => inScope.includes(r.stage) && r.type !== 'process');
  const processCount = rows.filter((r) => inScope.includes(r.stage) && r.type === 'process').length + rows.filter((r) => r.stage === 'Before Starting').length;
  const counts = {
    blockers: all.filter((f) => ['critical', 'high'].includes(f.severity)).length,
    open: visible.filter((r) => r.status === 'open').length,
    passed: visible.filter((r) => r.status === 'pass').length,
    fixable: all.filter((f) => MCP_FIXABLE.has(f.fix?.via)).length,
    manual: all.filter((f) => !MCP_FIXABLE.has(f.fix?.via)).length,
  };
  const manualList = all.filter((f) => !MCP_FIXABLE.has(f.fix?.via));
  const meta = { site: data.site, env: data.env, stage: scopeStage, pages: data.pagesAudited, generated: data.generated };

  await fs.writeFile(path.join(reportDir, 'checklist.json'), JSON.stringify({ meta, counts, rows, manual: manualList.map(short) }, null, 2));
  const md = renderMd(meta, counts, visible, processCount, manualList);
  const html = renderHtml(meta, counts, visible, processCount, manualList);
  await fs.writeFile(path.join(reportDir, 'checklist.md'), md);
  await fs.writeFile(path.join(reportDir, 'checklist.html'), html);
  return { md, html, counts, rows };
}

function renderMd(meta, counts, rows, processCount, manualList) {
  const host = new URL(meta.site).host;
  let md = `**${host}** · ${meta.env} · ${meta.pages} page(s) · ${counts.blockers} blockers · ${counts.open} open · ${counts.passed} passed\n\n`;
  for (const stg of STAGES) {
    const list = rows.filter((r) => r.stage === stg);
    if (!list.length) continue;
    md += `**${stg}**\n\n| Checklist item | Status | What's wrong | Fix |\n|---|---|---|---|\n`;
    for (const r of list) {
      const st = STATUS[r.status].md + (r.status === 'open' ? ` ${r.issues}` : '') + (r.worst && r.status === 'open' ? ` · ${r.worst}` : '');
      const mdEsc = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|');
      const what = (r.what.length ? r.what.map(mdEsc).join('<br>') : r.note ? mdEsc(r.note) : '');
      md += `| ${r.item} | ${st} | ${what} | ${r.fixShort} |\n`;
    }
    md += '\n';
  }
  md += `${processCount} process items (planning, handover, transfer) are not auditable from the site.\n\n`;
  if (manualList.length) md += `**Needs manual action**\n\n${manualList.map((f) => `- ${short(f).replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('\n')}\n\n`;
  md += `**Fixable via Webflow MCP: ${counts.fixable}** · Manual: ${counts.manual}\n`;
  return md;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderHtml(meta, counts, rows, processCount, manualList) {
  const host = new URL(meta.site).host;
  const tone = (t) => (t === 'neutral' ? 'background:var(--surface-1);color:var(--text-secondary)' : `background:var(--bg-${t});color:var(--text-${t})`);
  const card = (label, value, color) => `<div style="background:var(--surface-1);border-radius:var(--radius);padding:12px"><div style="font-size:13px;color:var(--text-secondary)">${label}</div><div style="font-size:24px;font-weight:500${color ? `;color:var(--text-${color})` : ''}">${value}</div></div>`;
  let h = `<style>
.qa-row{display:grid;grid-template-columns:minmax(0,1fr) 150px 130px;gap:8px;align-items:center;padding:8px 0;border-top:0.5px solid var(--border);font-size:14px;cursor:pointer}
.qa-chip{font-size:12px;padding:2px 8px;border-radius:var(--radius);justify-self:start;white-space:nowrap}
.qa-fix{font-size:12px;color:var(--text-muted)}
.qa-what{font-size:13px;color:var(--text-secondary);padding:0 0 10px 22px;line-height:1.6}
.qa-stage{font-size:13px;color:var(--text-secondary);margin:1.25rem 0 4px;font-weight:500}
details summary{list-style:none}details summary::-webkit-details-marker{display:none}
</style>
<h2 class="sr-only">QA checklist for ${esc(host)}: ${counts.open} items open, ${counts.passed} passed, ${counts.fixable} issues fixable via Webflow MCP.</h2>
<div style="font-size:13px;color:var(--text-secondary);margin:0 0 8px">${esc(host)} · ${esc(meta.env)} · ${meta.pages} page(s)</div>
<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 1rem">${card('Blockers', counts.blockers, counts.blockers ? 'danger' : null)}${card('Open items', counts.open)}${card('Fixable via MCP', counts.fixable)}${card('Manual', counts.manual)}</div>
`;
  for (const stg of STAGES) {
    const list = rows.filter((r) => r.stage === stg);
    if (!list.length) continue;
    h += `<div class="qa-stage">${esc(stg)}</div>\n`;
    for (const r of list) {
      const s = STATUS[r.status];
      const chip = `${s.label}${r.status === 'open' ? ` · ${r.issues}` : ''}${r.worst && r.status === 'open' ? ` · ${r.worst}` : ''}`;
      const detail = r.what.length ? r.what : r.note ? [r.note] : [];
      const fix = r.fixShort;
      h += `<details${r.worst === 'critical' ? ' open' : ''}><summary class="qa-row"><span>${detail.length ? '<i class="ti ti-chevron-down" style="font-size:14px" aria-hidden="true"></i> ' : '<span style="display:inline-block;width:18px"></span>'}${esc(r.item)}</span><span class="qa-chip" style="${tone(s.tone)}">${esc(chip)}</span><span class="qa-fix">${esc(fix)}</span></summary>${detail.length ? `<div class="qa-what">${detail.map(esc).join('<br>')}${r.fix.length ? `<br><span style="color:var(--text-muted)">${esc(r.fix.join(', '))}</span>` : ''}</div>` : ''}</details>\n`;
    }
  }
  h += `<div style="font-size:13px;color:var(--text-muted);margin:12px 0 0">${processCount} process items (planning, handover, transfer) aren't auditable from the site</div>\n`;
  if (manualList.length) h += `<div class="qa-stage">Needs manual action</div><div class="qa-what" style="padding-left:0">${manualList.map((f) => esc(short(f))).join('<br>')}</div>\n`;
  h += `<div style="display:flex;gap:8px;margin:1rem 0 0;flex-wrap:wrap"><button onclick="sendPrompt('Fix the ${counts.fixable} open items via Webflow MCP, batch by batch')">Fix ${counts.fixable} items via Webflow MCP ↗</button><button onclick="sendPrompt('Let me pick which items to fix')">Pick items ↗</button></div>\n`;
  return h;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node scripts/render.mjs reports/<host>/<timestamp> [--stage internal-qa|client-qa|launch|live]'); process.exit(2); }
  const i = process.argv.indexOf('--stage');
  const { md } = await render(dir, { stage: i > -1 ? process.argv[i + 1] : undefined });
  console.log(md);
  console.log(`HTML: ${path.join(dir, 'checklist.html')}`);
}

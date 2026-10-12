---
name: webflow-qa
description: QA audit of a Webflow site against the build checklist (SEO, structure, media, links, CMS, accessibility, performance, runtime, responsive, content, analytics, Client-First). Shows the checklist status in chat and fixes open items via Webflow MCP. Use when the user wants to audit, QA, review or check a Webflow site, or at the start of any session in this repo.
---

# Webflow QA

The user-facing result is **the checklist in chat** (what's closed, what's open) followed by an offer to fix through Webflow MCP. Files in `reports/` are working data for Claude (screenshots, text dumps, findings), not something the user has to open.

```
Phase 0  Intake    questionnaire
Phase 1  Audit     node scripts/qa.mjs           → checklist table + findings (working data)
Phase 2  Review    Claude: screenshots, copy, alt, naming, Figma → review.json
Phase 3  Show      node scripts/render.mjs → checklist verbatim + "Fix N items via Webflow MCP?"
Phase 4  Fix       Webflow MCP batch by batch, re-audit, show the updated checklist
```

## Language

Default English (greeting, questionnaire, checklist). In chat, reply in the language the user writes in.

## Phase 0 — Intake

Skip anything the user already gave earlier in the chat.

1. If there's no URL yet, ask in plain text: "Which site should I audit? Paste the URL (staging *.webflow.io or live domain)." Accept only a full `http(s)://` URL; otherwise ask again.
2. One `AskUserQuestion` call with exactly these three questions:

| header | question | options |
|---|---|---|
| Scope | Which pages should I audit? | Whole sitemap (Recommended) · Homepage only · Specific pages |
| Stage | Which checklist stage is this? | Before Internal QA (Recommended) · Before Client QA · Before Launch · Live site check |
| Figma | Compare the build against Figma? To compare, choose "Other" and paste the frame link(s), one per line. | No comparison · Yes — I'll paste links next |

3. Follow-ups, only when needed:
   - **Specific pages** → ask for the list of paths, one per line.
   - **Figma** — links come from the "Other" field, or ask for them if "Yes — I'll paste links next". Every link must match `https://(www.)figma.com/(design|file|proto)/<key>…node-id=…` (a frame link: right-click frame → Copy/Paste as → Copy link to selection). If any link is missing or invalid, **do not start the audit**: one more `AskUserQuestion` (header `Figma`, question "That's not a Figma frame link (<reason>). Paste the frame link via Other, or skip the comparison.", options: Skip Figma comparison · I'll paste it in chat). Repeat until valid links or skip.
   - **Before Launch / Live site check** → ask once in plain text: "Do you have a redirect map CSV (old,new per line)? Paste the path or say no."

Stage → `--env`: Internal/Client QA → `staging` (unless custom domain); Before Launch / Live → `production` (noindex, robots, badge, staging links, analytics become blockers).

## Phase 1 — Audit

First run in a fresh clone: `npm run setup` (local Playwright Chromium, no paid services).

```bash
node scripts/qa.mjs --url <URL> --scope sitemap|single|list [--pages /a,/b] --env staging|production [--redirects map.csv] [--max-pages 25] [--psi 3]
```

- Run in background, ~45 s per page. Tell the user in one line what's running.
- `--psi` = Google PageSpeed Insights (free, keyless). 429 → note "performance scores unavailable (rate limit)", don't retry in a loop.
- The script prints the checklist table and `Fixable via Webflow MCP: N · Manual: M`.
- Working data in `reports/<host>/<timestamp>/`: `checklist.json` (item → status, findingIds), `findings.json` (each finding: `check`, `severity`, `phase`, `page`, `wf` IDs, `element`/`items`, `fix.via`), `screens/<slug>/<width>-<issue>.png` (only where a layout issue was found; `--screens all` for full pages, `--screens none` to skip), `text/<slug>.txt`, `review-inputs.json`, `psi.json`.

### Forms (part of Phase 1, no approval needed)

For every page in `review-inputs.json → pagesWithForms` (and the contact page if the sitemap has one):

```bash
node scripts/form-test.mjs --url <page> --out reports/<host>/<timestamp>/forms/<slug>.json
```

The script fills each form with test data, clicks submit, **intercepts the outgoing request in the browser and answers it with a fake success** — nothing reaches Webflow, email notifications or integrations. It prints per form: status (`success` / `failed` / `validation-blocked` / `nothing-sent` / `skipped`), endpoint, the message the user would see, and a table of the exact fields sent.

Show that table in chat under "Configure forms and integrations" / "Test forms and integrations". Flag: fields filled but missing from the payload, unnamed fields (`Field 2`), endpoint not Webflow when the client expects Webflow submissions (or vice versa), default success/error texts, `validation-blocked` on valid data, CAPTCHA notes.

A real submission (`--live --confirm`) only if the user explicitly asks for one, after confirming it will trigger real notifications.

## Phase 2 — Claude review → `review.json`

Close the `👁 Needs review` items and sanity-check `❌ Open` ones:

1. **Visual** — token budget matters. Read only the `evidence` screenshots attached to findings (one viewport shot per issue, ~1.5k tokens each), max 10 per run, to confirm the issue and describe it. No full-page visual pass unless the user asks for one — then rerun the affected pages with `--screens all` and read only the breakpoints they care about. → `Follow responsive best practice` / `Validate typography and spacing`.
2. **Copy** — `text/*.txt`: spelling, grammar, capitalisation, punctuation, mixed languages. → `Complete self-review`.
3. **Alt quality** — `review-inputs.json → altText`: filenames, "image", duplicates, wrong language. → `Complete accessibility review`.
4. **Components & naming** — `classInventory`: meaningless names, inconsistent prefixes, duplicated one-off classes. → `Build reusable components`.
5. **Figma** (if links) — Figma MCP screenshots vs breakpoint screenshots. → `Compare build against Figma`.
6. **Redirects** — compare old URLs (old sitemap / live site) with the new structure. → `Assess redirect requirements`.
7. **False positives** — verify suspicious findings by opening the page; list confirmed false positives in `review.json` with `"dismiss": "<finding id>"`.

Project conventions to respect, not flag: class suffixes like `-n` (parallel class set during a rebuild — `padding-global-n`, `container-large-n` are valid wrappers); third-party classes (`fs-`, `swiper-`, consent tools).

Write results to `reports/<host>/<timestamp>/review.json` — this exact schema, English, short messages (≤ 90 chars):

```json
[
  { "item": "Compare build against Figma", "status": "pass" },
  { "item": "Complete self-review", "severity": "medium", "message": "Typo \"Erfahung\" in hero subtitle", "page": "https://site/", "fix": "element" },
  { "dismiss": "F0012" }
]
```

- `item` = exact checklist item name. `status` only → closes the item (`pass` / `open` / `unchecked`). `message` → adds an issue to the item.
- `severity`: critical · high · medium · low. `fix`: page-settings · cms · asset · element · style · custom-code · site-settings · redirects · manual.

## Phase 3 — Show the checklist (fixed format)

```bash
node scripts/render.mjs reports/<host>/<timestamp> --stage internal-qa|client-qa|launch|live
```

It writes `checklist.md` and `checklist.html` from findings + `forms/*.json` + `review.json`. **Never build or restyle the table yourself.**

1. If `show_widget` is available: Read `checklist.html` and pass its content to `show_widget` **verbatim** (title `qa_checklist_<host>`). Don't edit, shorten, translate or add rows.
2. Otherwise: output `checklist.md` **verbatim**.
3. Form test tables (from `form-test.mjs` output) go right after, verbatim.
4. Then one `AskUserQuestion`: header `Fix`, question "Fix the N open items via Webflow MCP?" (N from the render output), options: Fix all, batch by batch (Recommended) · Let me pick items · Not now.

No extra summary, no re-listing of issues in prose. The table stays in English even when chatting in another language; the surrounding sentences follow the user's language.

Write `report.md` only if the user asks for a shareable report.

After every fix batch + re-audit: render again and show the new table the same way.

## Phase 4 — Fix via Webflow MCP

Call `webflow_guide_tool` once first.

1. Confirm the site: `wf.siteId` from findings → `data_sites_tool`. `wf.pageId` → `data_pages_tool`. CMS template pages: `wf.collectionId` + `wf.itemSlug` → `data_cms_tool`.
2. One batch per `fix.via`; before each batch say what changes on which pages and wait for "yes":

| fix.via | MCP tool | typical fixes |
|---|---|---|
| page-settings | data_pages_tool | title, description, OG, noindex |
| cms | data_cms_tool | empty fields, per-item SEO, image alt fields |
| asset | asset_tool | asset alt text, WebP replacement (see below) |
| element | data_element_tool / data_element_settings_tool | heading level, link URL, aria-label, lazy loading, IDs, section tag |
| style | data_style_tool | overflow at breakpoint, focus-visible, contrast, font size, class rename, stack consolidation, orphan removal (see Classes) |
| custom-code | data_scripts_tool | duplicate/malformed tracking, defer scripts, JSON-LD |
| site-settings / redirects / manual | — | stays in "Needs manual action" |

3. Re-read the element tree right before every element/style write — the user may be editing in Designer in parallel.
4. Old vs new classes: on sites with a parallel class set (e.g. `-n`), edit only the set used on the audited page; never touch the old classes — the live site still depends on them.
5. Custom code: first line is an English marker comment naming the block, no other comments; read the field, replace only our block.
6. Never publish. After the batches: ask the user to publish to staging, rerun the audit on affected pages (`--scope list --pages ...`), show the updated checklist.

### Images → WebP (batch `asset`)

Not manual — do it:

1. `node scripts/webp.mjs reports/<host>/<timestamp>` downloads the originals of images flagged `img-legacy-format` / `img-heavy` / `img-oversized` (strips Webflow `-p-NNN` responsive suffixes), converts with `cwebp` (photos `-q 80`, PNG `-q 90 -alpha_q 100`, max width 2560, never upscale), skips files where WebP isn't smaller. Writes `webp/manifest.json` (file, md5, KB before/after, alt, pages, element).
2. Show the user the before/after KB list, ask to proceed.
3. Per file: `asset_tool` create asset (fileName + md5) → upload → keep the original alt (write one if missing, in the site language).
4. Re-bind: elements → `data_element_settings_tool` set image asset (re-read the tree first); CMS image fields → `data_cms_tool` update the item field. Images placed via code/`<img src=cdn…>` are not bound to the asset — always re-bind explicitly.
5. Old assets stay in the library; tell the user they can delete them after checking.

### Classes (batch `style`)

Not manual — renames, stack consolidation and orphan removal go through `data_style_tool`.

1. **Propose names first.** For each flagged class look at the element (screenshot + text + parent section) and propose a Client-First name: `section_<name>` for the wrapper, `<name>_<element>` inside it (one underscore, hyphens within parts), `is-<variant>` for combos. Auto names (`div-block-54`) get a name from what the element is (`hero_badge`, `steps_icon`). Show a table `old → new · elements · pages` and wait for "yes".
2. **Check references before renaming** — a class renamed in Webflow keeps its element bindings, but code that selects it breaks:
   - site + page custom code (`data_scripts_tool`), embeds (element settings `code`), Finsweet/GSAP attributes;
   - if the old name is referenced, either update that code in the same batch or skip the rename.
3. **Collisions** — `query_styles` for the new name first; MCP resolves a name to an existing combo chain and then fails with "not found". Pick another name if it exists.
4. **Old vs new class sets** (e.g. `-n` rebuild): rename only classes of the set the audited page uses. Old classes stay — the live site depends on them.
5. **Stacks of 5+ classes**: copy the utilities' values (all breakpoints, keep variables) into the element's own class, set the single class (plus `is-` combo if it's a variant), then remove the now-orphan combo chain.
6. **Orphan classes** (full crawl only): remove only after checking CMS template pages and pages outside the audit; list them first, delete on "yes".

## Edge cases

- Cookie banners: `scripts/consent.mjs` answers them automatically after every load (`--consent accept` default; `decline` / `none`). Supports Cookie Information, Cookiebot, Usercentrics, OneTrust, CookieYes, Finsweet, Complianz, iubenda, Klaro, Termly, iframe CMPs and a generic EN/DE button-text fallback. Tracking hits sent before the answer are reported as `tracking-before-consent` (Google Consent Mode cookieless pings `gcs=G100` are allowed). Many CMPs are geo-targeted: if the banner doesn't show from the audit machine, say so instead of assuming there's none.
- www ↔ apex redirects: the script audits the final host.
- Password-protected staging → ask for protection to be disabled temporarily or for a published URL.
- Staging sitemap lists the custom domain — URLs are rewritten to the audited host.
- CMS-heavy sites: audit 1–2 items per collection template via `--scope list`, not every item.
- `cf-orphan-classes` only on full sitemap crawl, informational.

## References

`references/` — SEO knowledge from claude-seo (MIT): `seo-page.md`, `seo-technical.md`, `seo-schema.md` + `schema/`, `seo-images.md`, `seo-sitemap.md`, `cwv-thresholds.md`, `schema-types.md`, `quality-gates.md`. Read only when a finding needs deeper judgement. They were written for the original claude-seo plugin: ignore any commands, sub-agents, scripts or paid APIs (DataForSEO, Google API keys, Ahrefs, etc.) mentioned there — they are not part of this toolkit.

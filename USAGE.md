# How to use Webflow QA

## 1. First run (once per machine)

1. Clone the repo and open the folder in Claude Code (desktop app).
2. Make sure the **Webflow** connector is on in Claude → Settings → Connectors, with access to the workspace that holds the site. **Figma** is optional.
3. Type `hi`. Claude checks your setup and offers to install anything missing — answer **Install now**. Node.js 18+ is the only thing you may need to install yourself (`brew install node`).

## 2. Run an audit

Type anything to start, or paste the URL straight away:

> Audit https://project.webflow.io

Claude asks three questions:

| Question | Pick |
|---|---|
| Pages | Whole sitemap · Homepage only · Specific pages |
| Stage | Before internal QA · Before client QA · Before launch · Live site check |
| Figma | No comparison · paste frame links (right-click frame → Copy link to selection) |

Tips:
- Start with **Homepage only** or a few pages — each page takes ~45 s.
- Use the **staging** URL before launch, the **live** domain after.
- For CMS-heavy sites, list 1–2 items per collection template instead of the whole sitemap.

## 3. Read the result

Claude shows the checklist grouped by stage:

| Status | Meaning |
|---|---|
| ✅ Pass | checked, nothing found |
| ❌ Open | issues found — expand the row to see them |
| 🟡 Partial | only partly checkable (e.g. PageSpeed rate-limited) |
| ⚪ Not checked | needs input (e.g. a redirect map) |
| 👁 Needs review | judgement item, Claude reviews it |

The **Fix** column says whether Claude can fix it via Webflow MCP or it needs manual action (robots.txt, redirects, site plan, content decisions).

## 4. Fix

Click **Fix via Webflow MCP** (or answer the question in chat). Claude works in batches — page settings, CMS, assets, elements, styles, custom code — and **asks before each batch**. It never publishes.

After the batches: publish to staging yourself, then say `re-check` — Claude re-audits the affected pages and shows the updated checklist.

Things Claude does for you, not manual:
- WebP conversion of heavy images and re-binding them on elements/CMS
- form tests (the submit is intercepted locally — nothing reaches Webflow or email)
- class renames and Client-First clean-up (it checks custom code references first)

## 5. Useful phrases

| Say | Does |
|---|---|
| `re-check /about /pricing` | re-audit specific pages |
| `test the forms on /contact` | intercepted form test with the sent fields |
| `convert images to WebP` | runs the WebP batch |
| `full screenshots at 479` | full-page screenshots for one breakpoint |
| `write a shareable report` | `report.md` for the client or PM |

## Notes

- No paid APIs. Reports stay on your machine in `reports/` (not committed).
- Cookie banners are accepted automatically so the audit sees the real page; tracking that fires **before** consent is reported.
- Problems with setup: run `node scripts/doctor.mjs` and send the output.

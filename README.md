# Webflow QA

Claude Code toolkit that audits a Webflow site against the build checklist, shows what's closed and what's open, and fixes the open items through Webflow MCP — with your approval, batch by batch.

## Quick start

1. Get access to this repo and clone it:
   ```bash
   git clone https://github.com/kenblack322/webflow-qa.git
   ```
2. Open the folder in **Claude Code** (desktop app recommended — the checklist renders as an interactive table there).
3. Say anything. Claude will:
   - check your machine and offer to install what's missing (npm packages, headless Chromium, `cwebp`);
   - check that the **Webflow** connector is on (needed for fixes; audits work without it);
   - ask for the site URL, pages, checklist stage and optional Figma frame links;
   - run the audit and show the checklist;
   - offer to fix the open items via Webflow MCP.

See **[USAGE.md](USAGE.md)** for the step-by-step guide.

## Requirements

| What | Why | Installed by Claude? |
|---|---|---|
| Node.js 18+ | runs the scripts | No — `brew install node` or nodejs.org |
| npm packages (Playwright, axe-core) | audit | Yes — `npm install` |
| Playwright Chromium (~100 MB) | headless browser | Yes — `npx playwright install chromium` |
| `cwebp` | WebP conversion | Yes on macOS with Homebrew (`brew install webp`) |
| Webflow connector in Claude | fixes via MCP | No — Claude settings → Connectors → Webflow (workspace with the client sites) |
| Figma connector in Claude | optional, design comparison | No — Claude settings → Connectors → Figma |

Check anytime: `node scripts/doctor.mjs`

## What it checks

SEO metadata · headings and semantics · images and media · links and redirects · CMS · accessibility (axe-core, keyboard, focus) · performance (PageSpeed Insights, free) · console errors and failed requests · responsive at 1920/1440/991/767/479 · placeholder content · analytics, consent banner, tracking before consent · forms (submissions intercepted locally, nothing is sent) · Client-First naming and structure.

Claude adds the judgement part: visual issues, copy proofreading, alt text quality, class naming, Figma comparison.

## Scripts

| Script | Does |
|---|---|
| `scripts/doctor.mjs` | environment check |
| `scripts/qa.mjs` | the audit → `reports/<host>/<timestamp>/` |
| `scripts/render.mjs` | fixed-format checklist (md + html) |
| `scripts/form-test.mjs` | form test with intercepted submit |
| `scripts/webp.mjs` | download flagged images, convert to WebP |
| `scripts/consent.mjs` | answers cookie banners (used by the audit) |

No paid APIs. Reports stay local (`reports/` is gitignored).

Based on [claude-seo](https://github.com/AgriciDaniel/claude-seo) (MIT) — SEO references kept in `.claude/skills/webflow-qa/references/`.

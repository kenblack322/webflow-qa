# Webflow QA

QA toolkit for Webflow builds: audit a site, show the build checklist status in chat (closed / open), fix open items via Webflow MCP.

## Session start (mandatory)

On the first message of every session — whatever it says, including "hi":

### Step 1 — Environment check (silent when everything is fine)

1. `node --version`. If Node is missing or < 18: tell the user Node.js 18+ is required, give the install command for their OS (macOS: `brew install node`, otherwise https://nodejs.org LTS), stop and wait.
2. `node scripts/doctor.mjs` → JSON report (`ready`, `checks[]` with `fix.auto` + `fix.cmd` or `fix.how`).
3. If `ready` is true and nothing optional is missing: say nothing about setup, go to Step 2.
4. Otherwise show one short list: ✅ / ❌ per check, one line each, marking optional ones. Then `AskUserQuestion` (header `Setup`): "Install the missing pieces now?" options: Install now (Recommended) · Skip optional, install required only · I'll do it myself.
5. On install: run each `fix.cmd` where `fix.auto` is true, in the order listed (`npm install` → `npx playwright install chromium` → `brew install webp`), one at a time, report each result in one line. Items with `fix.auto: false` (Node, Homebrew, git, Windows/Linux packages) need the user's password or an installer — give the exact command/link and wait; never run `sudo`.
6. Rerun `node scripts/doctor.mjs`; continue only when `ready` is true.

### Step 2 — Connectors

Check with ToolSearch whether Webflow MCP tools are available (query `webflow`) and Figma MCP (query `figma`).
- No Webflow → one line: "Webflow isn't connected — audits work, but fixes via MCP won't. Connect it in Claude settings → Connectors → Webflow." Don't block.
- No Figma → mention only if the user asks for a Figma comparison later.

### Step 3 — Intake

Start the `webflow-qa` skill at Phase 0: greet in one line and ask for the site URL.

Skip all of this only if the user clearly asks for something unrelated (e.g. editing this repo's code).

## Language

- Default language is English: greeting, questionnaire, report files, code comments.
- In chat, reply in the language the user writes in.

## Rules

- No paid APIs. Allowed: Playwright (local), axe-core (local), Google PageSpeed Insights (free, keyless), Webflow MCP, Figma MCP.
- Never write to Webflow without per-batch approval. Never publish the site.
- Reports go to `reports/` (gitignored). Never commit them.
- Python/Node scripts never call an LLM. Judgement (visual review, copy, triage) happens in chat.

## Layout

```
.claude/skills/webflow-qa/SKILL.md     workflow: intake → script → review → fix
.claude/skills/webflow-qa/references/  SEO knowledge from claude-seo (MIT, AgriciDaniel)
scripts/qa.mjs                          Layer 1 audit (Playwright + axe-core)
scripts/form-test.mjs                   form test, submissions intercepted locally (nothing is sent)
scripts/webp.mjs                        download flagged images, convert to WebP with cwebp
scripts/consent.mjs                     answer cookie banners, detect tracking before consent
scripts/render.mjs                      fixed-format checklist (md + html)
scripts/doctor.mjs                      environment check (Node, npm deps, Chromium, cwebp, git)
reports/<host>/<timestamp>/             output
```

Setup: handled automatically at session start (see above). Manual: `npm run setup`, plus `cwebp` (macOS: `brew install webp`).

#!/usr/bin/env node
// Environment check for Webflow QA. Prints a JSON report; exit code 0 = ready, 1 = something missing.

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const platform = process.platform;
const has = (cmd) => { try { execSync(platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; } };

const checks = [];
const add = (id, ok, required, what, fix) => checks.push({ id, ok, required, what, fix: ok ? null : fix });

const major = Number(process.versions.node.split('.')[0]);
add('node', major >= 18, true, `Node.js ${process.versions.node} (18+ needed)`,
  { auto: false, how: platform === 'darwin' ? 'brew install node' : 'Install Node.js LTS from https://nodejs.org' });

let pwOk = false;
let axeOk = false;
try { require.resolve('playwright'); pwOk = true; } catch { /* missing */ }
try { require.resolve('@axe-core/playwright'); axeOk = true; } catch { /* missing */ }
add('npm-deps', pwOk && axeOk, true, 'npm packages (playwright, @axe-core/playwright)', { auto: true, cmd: 'npm install' });

let chromiumOk = false;
if (pwOk) {
  try {
    // Launching is the only reliable check: headless mode uses a separate headless-shell build.
    const pw = await import(require.resolve('playwright'));
    const chromium = pw.chromium ?? pw.default.chromium;
    const browser = await chromium.launch({ timeout: 15000 });
    await browser.close();
    chromiumOk = true;
  } catch { /* not installed */ }
}
add('chromium', chromiumOk, true, 'Playwright Chromium (headless browser for the audit)', { auto: true, cmd: 'npx playwright install chromium' });

const brew = has('brew');
add('cwebp', has('cwebp'), false, 'cwebp (WebP conversion of images)',
  platform === 'darwin'
    ? (brew ? { auto: true, cmd: 'brew install webp' } : { auto: false, how: 'Install Homebrew from https://brew.sh, then: brew install webp' })
    : platform === 'win32'
      ? { auto: false, how: 'winget install Google.Libwebp  (or download from https://developers.google.com/speed/webp/download)' }
      : { auto: false, how: 'sudo apt install webp  (or your distro package manager)' });

add('git', has('git'), false, 'git (pull updates of this toolkit)', { auto: false, how: platform === 'darwin' ? 'xcode-select --install' : 'Install git from https://git-scm.com' });

const missingRequired = checks.filter((c) => !c.ok && c.required);
const missingOptional = checks.filter((c) => !c.ok && !c.required);
const report = { ready: missingRequired.length === 0, platform, checks, missingRequired: missingRequired.map((c) => c.id), missingOptional: missingOptional.map((c) => c.id) };
console.log(JSON.stringify(report, null, 2));
process.exit(report.ready ? 0 : 1);

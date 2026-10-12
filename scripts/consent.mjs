// Detect and answer cookie consent banners so audits see the real page.
// mode: 'accept' (default) | 'decline' | 'none'

const VENDORS = [
  {
    name: 'Cookie Information',
    detect: () => !!window.CookieInformation || !!document.querySelector('#coiOverlay, #coi-banner-wrapper, [id^="coiPage"]'),
    accept: () => { if (window.CookieInformation?.submitAllCategories) { window.CookieInformation.submitAllCategories(); return true; } return false; },
    decline: () => { if (window.CookieInformation?.declineAllCategories) { window.CookieInformation.declineAllCategories(); return true; } return false; },
    acceptSel: '.coi-banner__accept, button[onclick*="submitAllCategories"]',
    declineSel: '.coi-banner__decline, button[onclick*="declineAllCategories"]',
  },
  {
    name: 'Cookiebot',
    detect: () => !!window.Cookiebot || !!document.querySelector('#CybotCookiebotDialog'),
    accept: () => { if (window.Cookiebot?.submitCustomConsent) { window.Cookiebot.submitCustomConsent(true, true, true); return true; } return false; },
    decline: () => { if (window.Cookiebot?.submitCustomConsent) { window.Cookiebot.submitCustomConsent(false, false, false); return true; } return false; },
    acceptSel: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept',
    declineSel: '#CybotCookiebotDialogBodyButtonDecline',
  },
  {
    name: 'Usercentrics',
    detect: () => !!window.UC_UI || !!document.querySelector('#usercentrics-root, #usercentrics-cmp-ui'),
    accept: () => { if (window.UC_UI?.acceptAllConsents) { window.UC_UI.acceptAllConsents(); window.UC_UI.closeCMP?.(); return true; } return false; },
    decline: () => { if (window.UC_UI?.denyAllConsents) { window.UC_UI.denyAllConsents(); window.UC_UI.closeCMP?.(); return true; } return false; },
  },
  { name: 'OneTrust', detect: () => !!window.OneTrust || !!document.querySelector('#onetrust-banner-sdk'), acceptSel: '#onetrust-accept-btn-handler', declineSel: '#onetrust-reject-all-handler' },
  { name: 'CookieYes', detect: () => !!document.querySelector('.cky-consent-container'), acceptSel: '.cky-btn-accept', declineSel: '.cky-btn-reject' },
  { name: 'Finsweet Cookie Consent', detect: () => !!document.querySelector('[fs-cc="banner"], [fs-consent-element="banner"]'), acceptSel: '[fs-cc="allow"], [fs-consent-element="allow"]', declineSel: '[fs-cc="deny"], [fs-consent-element="deny"]' },
  { name: 'Complianz', detect: () => !!document.querySelector('.cmplz-cookiebanner'), acceptSel: '.cmplz-accept', declineSel: '.cmplz-deny' },
  { name: 'iubenda', detect: () => !!document.querySelector('#iubenda-cs-banner'), acceptSel: '.iubenda-cs-accept-btn', declineSel: '.iubenda-cs-reject-btn' },
  { name: 'Klaro', detect: () => !!document.querySelector('.klaro .cookie-notice, .klaro .cookie-modal'), acceptSel: '.klaro .cm-btn-success, .klaro .cm-btn-accept-all', declineSel: '.klaro .cm-btn-decline' },
  { name: 'Termly', detect: () => !!document.querySelector('[class*="termly"]'), acceptSel: '[data-tid="banner-accept"]', declineSel: '[data-tid="banner-decline"]' },
];

const ACCEPT_TEXT = /^(accept all( cookies)?|allow all( cookies)?|accept( cookies)?|i agree|agree|got it|ok|alle akzeptieren|alle cookies akzeptieren|akzeptieren|zustimmen|alle zulassen|einverstanden|annehmen)$/i;
const DECLINE_TEXT = /^(decline( all)?|reject( all)?|deny|only necessary|necessary only|alle ablehnen|ablehnen|nur notwendige( cookies)?|nur essenzielle( cookies)?)$/i;

export async function handleConsent(page, mode = 'accept', { waitMs = 3000 } = {}) {
  if (mode === 'none') return { vendor: null, action: 'skipped' };
  // Banners often appear after a delay (GTM-loaded CMPs); retry for a few seconds.
  const deadline = Date.now() + waitMs;
  let res;
  do {
    res = await answerOnce(page, mode);
    if (res.action !== 'no-banner') break;
    await page.waitForTimeout(750);
  } while (Date.now() < deadline);
  if (res.action === mode) await page.waitForTimeout(800);
  return res;
}

async function answerOnce(page, mode) {
  const res = await page.evaluate(({ vendors, mode, acceptSrc, declineSrc }) => {
    const vis = (el) => el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    for (const v of vendors) {
      const detect = new Function(`return (${v.detect})()`);
      if (!detect()) continue;
      const api = mode === 'accept' ? v.accept : v.decline;
      try { if (api && new Function(`return (${api})()`)()) return { vendor: v.name, action: mode, via: 'api' }; } catch (e) { /* fall back to clicking */ }
      const sel = mode === 'accept' ? v.acceptSel : v.declineSel;
      const btn = sel && [...document.querySelectorAll(sel)].find(vis);
      if (btn) { btn.click(); return { vendor: v.name, action: mode, via: 'click' }; }
      return { vendor: v.name, action: 'not-found' };
    }
    const re = new RegExp(mode === 'accept' ? acceptSrc : declineSrc, 'i');
    const btn = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => vis(b) && re.test((b.innerText || '').trim()));
    if (btn) { btn.click(); return { vendor: 'generic', action: mode, via: 'text', label: btn.innerText.trim() }; }
    return { vendor: null, action: 'no-banner' };
  }, {
    vendors: VENDORS.map((v) => ({ name: v.name, detect: v.detect.toString(), accept: v.accept?.toString(), decline: v.decline?.toString(), acceptSel: v.acceptSel, declineSel: v.declineSel })),
    mode, acceptSrc: ACCEPT_TEXT.source, declineSrc: DECLINE_TEXT.source,
  }).catch((e) => ({ vendor: null, action: 'error', error: e.message }));

  // Some CMPs live in an iframe (Sourcepoint, TrustArc).
  if (res.action === 'no-banner') {
    for (const frame of page.frames().slice(1)) {
      if (!/consent|cmp|privacy|sourcepoint|trustarc/i.test(frame.url())) continue;
      const re = mode === 'accept' ? ACCEPT_TEXT : DECLINE_TEXT;
      const btn = frame.getByRole('button', { name: re }).first();
      if (await btn.count()) { await btn.click().catch(() => {}); return { vendor: 'iframe CMP', action: mode, via: 'iframe' }; }
    }
  }
  return res;
}

// Google Consent Mode v2 sends cookieless pings with gcs=G100 (all denied) before consent; those are allowed.
export function isPreConsentViolation(url) {
  if (!TRACKING_HIT.test(url)) return false;
  try {
    const gcs = new URL(url).searchParams.get('gcs');
    if (gcs === 'G100') return false;
  } catch { /* keep as violation */ }
  return true;
}

// Hits that send data (not just loading the library) — these must not happen before consent.
export const TRACKING_HIT = /google-analytics\.com\/(g\/)?collect|analytics\.google\.com\/g\/collect|googletagmanager\.com\/.*\/collect|region\d*\.google-analytics|facebook\.com\/tr[/?]|connect\.facebook\.net\/signals|bat\.bing\.com\/action|clarity\.ms\/collect|\.hotjar\.(com|io)\/api|linkedin\.com\/(px|collect)|analytics\.tiktok\.com\/api|px\.ads\.linkedin|doubleclick\.net\/.*(collect|activity)/i;

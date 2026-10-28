import { chromium } from 'playwright-core';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// `contextOptions` are added to the browser context's, e.g. a geolocation for Wolt.
// Locally: the Chromium that `playwright install` downloads. In a Vercel
// function (no browser installed, small disk): the compact build from @sparticuz/chromium.
async function launchOptions() {
  if (!process.env.VERCEL) return { headless: true };
  const { default: lambdaChromium } = await import('@sparticuz/chromium');
  return { headless: true, executablePath: await lambdaChromium.executablePath(), args: lambdaChromium.args };
}

export async function withBrowser(fn, contextOptions = {}) {
  const started = Date.now();
  const browser = await chromium.launch(await launchOptions());
  // Cold starts on Vercel unpack Chromium first; worth seeing when a lookup runs out of time.
  if (process.env.VERCEL) console.log(`[browser] Chromium started in ${Date.now() - started} ms`);
  try {
    const context = await browser.newContext({
      locale: 'fi-FI',
      viewport: { width: 1280, height: 900 },
      userAgent: USER_AGENT,
      ...contextOptions,
    });
    return await fn(context);
  } finally {
    await browser.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Declines non-essential cookies on the consent banners these sites show.
export async function declineCookies(page) {
  const btn = page.getByRole('button', { name: /Vain välttämättömät|Hylkää|Kiellä|Only necessary/i }).first();
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}

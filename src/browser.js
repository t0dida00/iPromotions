import { chromium } from 'playwright';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// `contextOptions` are added to the browser context's, e.g. a geolocation for Wolt.
export async function withBrowser(fn, contextOptions = {}) {
  const browser = await chromium.launch({ headless: true });
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

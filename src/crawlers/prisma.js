import { withBrowser, declineCookies, sleep } from '../browser.js';

const BASE = 'https://www.s-kaupat.fi';
const PAGE_SIZE = 24;

// S-kaupat only shows branch-specific prices after a delivery method is chosen, so we walk
// through the "Toimitustapa" dialog (pickup at the branch), then page through
// /hakutulokset?label=DISCOUNTED and capture the RemoteFilteredProducts responses.
export async function crawlPrisma({ search, label }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    const products = new Map();
    let total = null;
    let storeId = null;
    page.on('response', async (res) => {
      if (!res.url().includes('operationName=RemoteFilteredProducts') || !res.ok()) return;
      try {
        const list = (await res.json())?.data?.store?.products;
        if (!list) return;
        total = list.total;
        for (const item of list.productListItems ?? []) {
          const p = item.product;
          if (p && p.storeId === storeId) products.set(p.ean, { ...p, labels: item.labels });
        }
      } catch {}
    });

    storeId = await selectPickupStore(page, search);
    log(`  prisma: selected store ${storeId}`);

    for (let n = 1; ; n++) {
      const before = products.size;
      const waitList = page.waitForResponse((r) => r.url().includes('RemoteFilteredProducts'), { timeout: 45_000 });
      await page.goto(`${BASE}/hakutulokset?label=DISCOUNTED${n > 1 ? `&page=${n}` : ''}`, {
        waitUntil: 'domcontentloaded',
      });
      await waitList.catch(() => {});
      await sleep(1200);
      if (products.size === before || total == null || n * PAGE_SIZE >= total) break;
    }
    log(`  prisma: captured ${products.size}/${total ?? '?'} products`);

    return [...products.values()].map((p) => normalize(p, label));
  });
}

async function selectPickupStore(page, search) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  await declineCookies(page);
  await page.locator('[data-test-id="delivery-select"]').click();
  const dialog = page.locator('[role=dialog]');
  await dialog.locator('input').fill(search);
  await dialog.getByText(search).first().click();
  await dialog.locator('button', { hasText: 'Nouto' }).first().click();
  const skip = dialog.locator('button', { hasText: 'Ohita' }); // "log in?" prompt
  await skip.click({ timeout: 8000 }).catch(() => {});

  // Pick the first free slot under the requested pickup point; nothing is reserved without login.
  const point = dialog.locator('h3, h4', { hasText: search }).first();
  await point.waitFor({ timeout: 20_000 });
  const slot = point
    .locator('xpath=following::button')
    .filter({ hasText: /^\d{1,2}\.\d{2}–/ })
    .first();
  await slot.click();
  await dialog.locator('button', { hasText: 'Valitse aika' }).click();
  await sleep(3000);

  const cookies = await page.context().cookies(BASE);
  const id = cookies.find((c) => c.name === 's-kaupat-selected-store')?.value;
  if (!id) throw new Error('Prisma: store selection did not stick');
  return id;
}

function normalize(p, store) {
  const pr = p.pricing ?? {};
  const rule = pr.primaryDiscountRule;
  const price = pr.campaignPrice ?? pr.currentPrice ?? p.price;
  const regular = pr.regularPrice ?? pr.lowest30DayPrice;
  const tree = p.hierarchyPath ?? [];
  const img = p.productDetails?.productImages?.mainImage?.urlTemplate;
  return {
    id: `prisma:${p.ean}`,
    source: 'prisma',
    store,
    name: p.name,
    brand: p.brandName ?? null,
    category: tree[tree.length - 1]?.name ?? 'Muut',
    price,
    regularPrice: regular && regular > price ? regular : null,
    dealText: ruleText(rule) ?? p.labels?.map((l) => l.labelText).filter(Boolean).join(', ') ?? null,
    image: img ? img.replace('{MODIFIERS}', 'w_300,h_300,q_75').replace('{EXTENSION}', 'jpg') : null,
    url: `${BASE}/tuote/${p.slug}/${p.ean}`,
    validUntil: pr.campaignPriceValidUntil ?? null,
  };
}

function ruleText(rule) {
  if (!rule) return null;
  if (rule.requiredItemCount && rule.discountValue != null)
    return `${rule.requiredItemCount} kpl / ${String(rule.discountValue).replace('.', ',')} €`;
  return rule.description ?? rule.title ?? null;
}

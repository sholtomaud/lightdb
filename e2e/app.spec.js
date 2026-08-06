import { expect, test } from '@playwright/test';

test('the single page renders both panels', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('sync-page')).toBeVisible();
  await expect(page.locator('h1')).toContainText('lightdb');

  // The whole point of the layout: link and database visible together.
  await expect(page.locator('#qr-canvas')).toBeVisible();
  await expect(page.locator('#camera')).toBeAttached();
  await expect(page.locator('.database')).toBeVisible();
});

test('records persist across a reload', async ({ page }) => {
  await page.goto('/');

  await page.fill('#key-input', 'colour');
  await page.fill('#value-input', 'green');
  await page.click('#add-btn');

  await expect(page.locator('td.key')).toHaveText('colour');
  await expect(page.locator('td.value')).toHaveText('green');

  await page.reload();
  await expect(page.locator('td.key')).toHaveText('colour');
});

test('records can be deleted', async ({ page }) => {
  await page.goto('/');

  await page.fill('#key-input', 'temporary');
  await page.fill('#value-input', 'value');
  await page.click('#add-btn');
  await expect(page.locator('td.key')).toHaveText('temporary');

  await page.click('.delete-record');
  await expect(page.locator('[data-empty]')).toBeVisible();
});

test('record values are escaped, not interpreted as markup', async ({ page }) => {
  await page.goto('/');

  await page.fill('#key-input', 'xss');
  await page.fill('#value-input', '<img src=x onerror="window.__pwned=1">');
  await page.click('#add-btn');

  await expect(page.locator('td.value')).toContainText('<img');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('td.value img').count()).toBe(0);
});

test('one button starts both directions at once', async ({ page }) => {
  await page.goto('/');

  await page.fill('#key-input', 'payload');
  await page.fill('#value-input', 'something worth syncing');
  await page.click('#add-btn');

  await expect(page.locator('#sync-btn')).toHaveText('Start sync');
  await page.click('#sync-btn');
  await expect(page.locator('#sync-btn')).toHaveText('Stop sync');

  // Transmitting: the frame counter must advance, not just paint once.
  await expect
    .poll(async () => Number(await page.locator('[data-tx-frames]').textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThan(3);

  // And the canvas must carry an actual symbol.
  const hasDarkPixels = await page.evaluate(() => {
    const canvas = document.querySelector('#qr-canvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128) return true;
    }
    return false;
  });
  expect(hasDarkPixels).toBe(true);

  // Receiving at the same time: the fake camera device is granted in config.
  await expect(page.locator('.frame.dark')).toHaveClass(/running/, { timeout: 10000 });

  await page.click('#sync-btn');
  await expect(page.locator('#sync-btn')).toHaveText('Start sync');
});

test('nothing is ever fetched from a CDN', async ({ page }) => {
  const external = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== 'localhost' && url.protocol !== 'data:') {
      external.push(request.url());
    }
  });

  await page.goto('/');
  await page.click('#sync-btn');
  await page.waitForTimeout(2500);

  // The wasm decoder must come from our own origin: the CSP forbids anything
  // else, and an app that only works online is not this app.
  expect(external).toEqual([]);
});

test('the service worker registers', async ({ page }) => {
  await page.goto('/');

  const registered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration();
    return registration !== undefined;
  });

  expect(registered).toBe(true);
});

test('the manifest is served at the path index.html asks for', async ({ page }) => {
  const response = await page.goto('/manifest.json');
  expect(response.status()).toBe(200);

  const manifest = await response.json();
  expect(manifest.name).toBe('lightdb');
});

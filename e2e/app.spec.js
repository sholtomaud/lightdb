import { expect, test } from '@playwright/test';

test('the shell boots and routes', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('app-nav')).toBeVisible();
  await expect(page.locator('h1')).toContainText('lightdb');

  await page.click('a[href="/db"]');
  await expect(page.locator('db-page')).toBeVisible();

  await page.click('a[href="/send"]');
  await expect(page.locator('send-page')).toBeVisible();

  await page.click('a[href="/receive"]');
  await expect(page.locator('receive-page')).toBeVisible();
});

test('records persist across a reload', async ({ page }) => {
  await page.goto('/db');

  await page.fill('#key-input', 'colour');
  await page.fill('#value-input', 'green');
  await page.click('#set-btn');

  await expect(page.locator('.record-key')).toHaveText('colour');
  await expect(page.locator('.record-value')).toHaveText('green');

  await page.reload();
  await expect(page.locator('.record-key')).toHaveText('colour');
});

test('record values are escaped, not interpreted as markup', async ({ page }) => {
  await page.goto('/db');

  await page.fill('#key-input', 'xss');
  await page.fill('#value-input', '<img src=x onerror="window.__pwned=1">');
  await page.click('#set-btn');

  await expect(page.locator('.record-value')).toContainText('<img');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('.record-value img').count()).toBe(0);
});

test('the transmitter paints QR frames onto the canvas', async ({ page }) => {
  await page.goto('/db');
  await page.fill('#key-input', 'payload');
  await page.fill('#value-input', 'something worth syncing');
  await page.click('#set-btn');

  await page.click('a[href="/send"]');
  await page.click('#start-btn');

  await expect(page.locator('#stop-btn')).toBeEnabled();

  // Frame counter must actually advance, not just render once.
  await expect
    .poll(async () => Number(await page.locator('[data-frames]').textContent()), {
      timeout: 5000,
    })
    .toBeGreaterThan(3);

  // And the canvas must be non-blank.
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

  await page.click('#stop-btn');
  await expect(page.locator('#start-btn')).toBeEnabled();
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

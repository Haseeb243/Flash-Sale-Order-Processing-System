import { test, expect, type Page } from '@playwright/test';
import { reset, TTL_WAIT_MS } from './helpers';

// End-to-end user journey through the UI with a full-page screenshot per step (screenshots/).
const shot = (page: Page, name: string) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const latestStatus = (page: Page) => page.locator('[data-testid^="order-status-"]').first();

test('full flow: reserve, pay, fail, insufficient stock, expiry', async ({ page, request }) => {
  test.setTimeout(60_000);
  await reset(request);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('/');
  await expect(page.getByTestId('stock-keyboard')).toHaveText('5');
  await shot(page, '01-initial');

  await page.getByTestId('reserve-keyboard').click();
  await expect(page.getByTestId('banner')).toHaveAttribute('data-variant', 'success');
  await expect(page.getByTestId('stock-keyboard')).toHaveText('4');
  await expect(latestStatus(page)).toHaveText('reserved');
  await shot(page, '02-reserved');

  await page.locator('[data-testid^="pay-success-"]').first().click();
  await expect(latestStatus(page)).toHaveText('confirmed');
  await shot(page, '03-payment-confirmed');

  await page.getByTestId('reserve-mouse').click();
  await expect(page.getByTestId('stock-mouse')).toHaveText('9');
  await page.locator('[data-testid^="pay-fail-"]').first().click();
  await expect(latestStatus(page)).toHaveText('cancelled');
  await expect(page.getByTestId('stock-mouse')).toHaveText('10');
  await shot(page, '04-payment-failed-stock-released');

  await page.getByTestId('qty-laptop').fill('3');
  await page.getByTestId('reserve-laptop').click();
  await expect(page.getByTestId('banner')).toHaveAttribute('data-variant', 'error');
  await shot(page, '05-insufficient-stock');

  await page.getByTestId('qty-laptop').fill('1');
  await page.getByTestId('reserve-laptop').click();
  await expect(page.getByTestId('stock-laptop')).toHaveText('1');
  await page.waitForTimeout(TTL_WAIT_MS);
  await page.getByTestId('run-expiry').click();
  await expect(latestStatus(page)).toHaveText('expired');
  await expect(page.getByTestId('stock-laptop')).toHaveText('2');
  await shot(page, '06-reservation-expired');
});

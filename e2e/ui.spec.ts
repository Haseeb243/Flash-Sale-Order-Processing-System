import { test, expect } from '@playwright/test';
import { reset, waitPastTtl } from './helpers';

test.describe('flash-sale UI', () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test('reserve keyboard, then simulate payment success', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('stock-keyboard')).toHaveText('5');

    await page.getByTestId('qty-keyboard').fill('1');
    await page.getByTestId('reserve-keyboard').click();

    await expect(page.getByTestId('banner')).toHaveAttribute('data-variant', 'success');
    await expect(page.getByTestId('stock-keyboard')).toHaveText('4');

    const status = page.locator('[data-testid^="order-status-"]').first();
    await expect(status).toHaveText('reserved');

    await page.locator('[data-testid^="pay-success-"]').first().click();
    await expect(page.locator('[data-testid^="order-status-"]').first()).toHaveText('confirmed');
  });

  test('reserve laptop qty 3 (stock 2) shows error banner mentioning stock', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('stock-laptop')).toHaveText('2');

    await page.getByTestId('qty-laptop').fill('3');
    await page.getByTestId('reserve-laptop').click();

    const banner = page.getByTestId('banner');
    await expect(banner).toHaveAttribute('data-variant', 'error');
    await expect(banner).toContainText(/stock/i);
  });

  test('reservation expires after TTL and expiry run restores stock', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('stock-mouse')).toHaveText('10');

    await page.getByTestId('qty-mouse').fill('1');
    await page.getByTestId('reserve-mouse').click();
    await expect(page.getByTestId('banner')).toHaveAttribute('data-variant', 'success');
    await expect(page.getByTestId('stock-mouse')).toHaveText('9');

    await waitPastTtl();

    await page.getByTestId('run-expiry').click();

    await expect(page.locator('[data-testid^="order-status-"]').first()).toHaveText('expired');
    await expect(page.getByTestId('stock-mouse')).toHaveText('10');
  });
});

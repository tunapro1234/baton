// Shared by every Playwright spec: the host asks once for permission before it opens any MCP session.
// The answer is remembered per room in the browser context, so a second page of the same context may
// not ask again; body[data-consent] tells the two cases apart.
import { expect, type Page } from '@playwright/test';

export const PERMISSION_START = "Before you start: Baton sends the Baton server the caregivers' names";

/** Accepts the permission prompt if this page shows it. */
export async function passConsent(page: Page): Promise<void> {
  const body = page.locator('body[data-consent]');
  await expect(body).toBeAttached();
  if ((await body.getAttribute('data-consent')) === 'asking') {
    await expect(page.getByTestId('consent')).toContainText(PERMISSION_START);
    await page.getByTestId('consent-continue').click();
  }
  await expect(page.locator('body[data-consent="given"]')).toBeAttached();
}

/** Opens the host and accepts the permission prompt. */
export async function openHost(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await passConsent(page);
}

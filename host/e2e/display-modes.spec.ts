// Display modes: inline by default, Expand asks the host for fullscreen (user click only),
// and a no-screen device speaks the same brief instead of drawing it.
import { expect, test, type Page } from '@playwright/test';
import { openHost } from './consent.ts';

const SERVER = 'http://127.0.0.1:37311';
const kitchen = (p: Page) => p.locator('[data-device="a"]');
const phone = (p: Page) => p.locator('[data-device="b"]');

test.beforeAll(async ({ request }) => {
  const r = await request.post(`${SERVER}/clock`, { data: { set: '2026-10-22T09:00:00' } });
  expect(r.ok()).toBe(true);
});

test('inline by default, Expand to fullscreen and back, no-screen speaks the brief', async ({ page }) => {
  await openHost(page);
  const ask = kitchen(page).getByTestId('elicit');
  await ask.getByLabel('Sam').check();
  await ask.getByTestId('elicit-accept').click();

  const b = phone(page);
  await b.getByRole('button', { name: 'Since I left' }).click();
  await expect(b.getByTestId('screen')).toHaveAttribute('data-view', 'ui://baton/brief');
  const view = b.getByTestId('screen').frameLocator('iframe.view-frame');
  const expand = view.getByRole('button', { name: 'Expand' });
  await expect(expand).toBeVisible();
  await expect(b).not.toHaveClass(/fullscreen-view/);

  await expand.click();
  await expect(b).toHaveClass(/fullscreen-view/);
  await expect(view.getByRole('button', { name: 'Back' })).toBeVisible();
  await view.getByRole('button', { name: 'Back' }).click();
  await expect(b).not.toHaveClass(/fullscreen-view/);

  // A refresh swaps frames without leaving the screen empty: there is always exactly one visible view.
  await kitchen(page).getByRole('button', { name: 'Log metformin' }).click();
  await expect(b.locator('iframe.view-frame')).toHaveCount(1);

  // No-screen device: nothing is drawn, the brief's sentence is spoken.
  // It is a new MCP session without the MCP Apps UI extension, so the server words the reply for a room
  // that only hears it: counts, no medicine names.
  await b.getByLabel('No-screen device').check();
  await expect(b.locator('iframe')).toHaveCount(0);
  await expect(b).toHaveAttribute('data-session', 'no-screen');
  await b.getByRole('button', { name: 'Since I left' }).click();
  const said = b.getByTestId('transcript').locator('.line.server').last();
  await expect(said).toContainText(/since you left|in the last 24 hours/i);
  await expect(said).not.toContainText(/metformin|amlodipine|levothyroxine/i);
  await expect(b).toHaveAttribute('data-spoken', /since you left|in the last 24 hours/i);
  await expect(b.locator('iframe')).toHaveCount(0);
});

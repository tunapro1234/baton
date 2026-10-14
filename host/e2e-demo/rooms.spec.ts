// The public demo: each visitor gets a household of their own; the same link shares one.
import { expect, test, type Page } from '@playwright/test';
import { openHost } from '../e2e/consent.ts';

const kitchen = (p: Page) => p.locator('[data-device="a"]');
const phone = (p: Page) => p.locator('[data-device="b"]');

async function asSam(p: Page): Promise<void> {
  const ask = kitchen(p).getByTestId('elicit');
  await expect(ask).toBeVisible();
  await ask.getByLabel('Sam').check();
  await ask.getByTestId('elicit-accept').click();
  await expect(kitchen(p).getByTestId('who')).toHaveText('Logging as Sam');
}

test('a room per visitor, shared by the same link, recorded responses only, noindex', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await openHost(a);
  await expect(a).toHaveURL(/[?&]room=[a-z0-9]{16}\b/);
  await expect(a.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await asSam(a);
  await kitchen(a).getByRole('button', { name: 'Log metformin' }).click();
  await expect(kitchen(a).getByTestId('transcript')).toContainText('log_care_event');

  // Another browser with the same link sees the same household.
  const b = await (await browser.newContext()).newPage();
  await openHost(b, a.url());
  await phone(b).getByRole('button', { name: 'Today' }).click();
  await expect(phone(b).frameLocator('iframe.view-frame').getByText('Logged by Sam at 8:00')).toBeVisible();

  // A new visitor gets a new room with nothing logged.
  const c = await (await browser.newContext()).newPage();
  await openHost(c);
  await expect(c).toHaveURL(/[?&]room=[a-z0-9]{16}\b/);
  expect(new URL(c.url()).searchParams.get('room')).not.toBe(new URL(a.url()).searchParams.get('room'));
  await phone(c).getByRole('button', { name: 'Today' }).click();
  await expect(phone(c).frameLocator('iframe.view-frame').getByText('Metformin 500 mg').first()).toBeVisible();
  await expect(phone(c).frameLocator('iframe.view-frame').getByText(/Logged by Sam/)).toHaveCount(0);

  // Protocol line numbers keep every digit, up to the 500 lines the log holds ("10." once showed as "0.").
  const fit = await a.getByTestId('protocol-log').evaluate((ol) => {
    const cs = getComputedStyle(ol);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    return { pad: parseFloat(cs.paddingLeft), need: ctx.measureText('500. ').width };
  });
  expect(fit.pad).toBeGreaterThanOrEqual(fit.need - 0.5);

  // Crawlers are asked to stay out of the whole site.
  const robots = await a.request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/User-agent: \*\s+Disallow: \/\s*$/);

  // The assistant runs on recorded responses, and the service marks its answers noindex.
  const health = await a.request.get('/assistant/healthz');
  expect(health.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(((await health.json()) as { mode: string }).mode).toBe('mock');
});

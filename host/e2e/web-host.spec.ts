// Two devices, two MCP sessions, one server: the core web-host behaviour end to end.
import { expect, test, type Page } from '@playwright/test';

const kitchen = (p: Page) => p.locator('[data-device="a"]');
const phone = (p: Page) => p.locator('[data-device="b"]');

test('initialize, tools/list, tools/call, view; sync between sessions; double-dose dialog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Alexa+-style simulated assistant', { exact: false })).toBeVisible();
  await expect(page.getByText('Not a medical device', { exact: false })).toBeVisible();

  // The kitchen device asks who is speaking (elicitation, single select).
  const ask = kitchen(page).getByTestId('elicit');
  await expect(ask).toBeVisible();
  await ask.getByLabel('Sam').check();
  await ask.getByTestId('elicit-accept').click();
  await expect(kitchen(page).getByTestId('who')).toHaveText('Logging as Sam');

  const log = page.getByTestId('protocol-log');
  await expect(log.locator('li[data-method="initialize"]')).toHaveCount(2);
  await expect(log.locator('li[data-method="tools/list"]')).toHaveCount(2);
  await expect(log.locator('li[data-method="elicitation/create"]').first()).toBeVisible();
  await expect(log).toContainText('2025-11-25');

  // tools/call -> ui:// view drawn through AppBridge in a sandboxed frame.
  await kitchen(page).getByRole('button', { name: 'Today' }).click();
  const kView = kitchen(page).frameLocator('iframe.view-frame');
  await expect(kView.getByText('Metformin 500 mg').first()).toBeVisible();
  await expect(log).toContainText('tools/call today_view');

  await phone(page).getByRole('button', { name: 'Today' }).click();
  const pView = phone(page).frameLocator('iframe.view-frame');
  await expect(pView.getByText('Metformin 500 mg').first()).toBeVisible();
  await expect(pView.getByText(/by Sam/)).toHaveCount(0);

  // Device A writes; device B gets resources/updated, calls the tool again and redraws.
  await kitchen(page).getByRole('button', { name: 'Log metformin' }).click();
  await expect(kitchen(page).getByTestId('transcript')).toContainText('log_care_event');
  await expect(log.locator('li[data-method="notifications/resources/updated"]').first()).toBeAttached();
  await expect(phone(page).getByTestId('screen').frameLocator('iframe.view-frame').getByText('Logged by Sam at 8:00')).toBeVisible();

  // Same med, same window: the server asks before writing twice. Declining writes nothing.
  await kitchen(page).getByRole('button', { name: 'Log metformin' }).click();
  const dlg = kitchen(page).getByTestId('elicit');
  await expect(dlg).toContainText('Sam logged metformin at 8:00. Log again anyway?');
  await dlg.getByTestId('elicit-decline').click();
  await expect(dlg).toHaveCount(0);
  await kitchen(page).getByRole('button', { name: 'Did Mom get her metformin?' }).click();
  await expect(kitchen(page).getByTestId('transcript').locator('.line.server').last()).not.toContainText('twice');

  // No proxy in this run: typed lines get the offline note, nothing pretends to answer.
  await phone(page).getByRole('textbox').fill('Did Mom get her metformin?');
  await phone(page).getByRole('button', { name: 'Send' }).click();
  await expect(phone(page).getByTestId('transcript')).toContainText('The assistant proxy is not running');
});

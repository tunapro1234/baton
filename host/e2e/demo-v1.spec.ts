// Demo v1: the core loop of the video storyboard (0:08-2:10), played in mock mode with typed lines.
// Every step leaves a screenshot under test-results/ (not committed). This is the shooting script.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const SERVER = 'http://127.0.0.1:37311';
const kitchen = (p: Page) => p.locator('[data-device="a"]');
const phone = (p: Page) => p.locator('[data-device="b"]');
const view = (device: Locator) => device.getByTestId('screen').frameLocator('iframe.view-frame');
const lastReply = (device: Locator) => device.getByTestId('transcript').locator('.line.assistant').last();

async function say(device: Locator, text: string): Promise<void> {
  const before = await device.getByTestId('transcript').locator('.line.assistant').count();
  await device.getByRole('textbox').fill(text);
  await device.getByRole('button', { name: 'Send' }).click();
  await expect(device.getByTestId('transcript').locator('.line.assistant')).toHaveCount(before + 1);
}

let shot = 0;
async function snap(page: Page, info: TestInfo, name: string): Promise<void> {
  shot += 1;
  await page.screenshot({ path: info.outputPath(`${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
}

test.beforeAll(async ({ request }) => {
  const r = await request.post(`${SERVER}/clock`, { data: { set: '2026-10-20T08:00:00' } });
  expect(r.ok()).toBe(true);
});

test('demo v1: check, log with disambiguation, sync, double dose, no advice, shift brief, note, visit timeline', async ({ page }, info) => {
  test.setTimeout(180_000);
  const a = kitchen(page);
  const b = phone(page);
  await page.goto('/');

  // Kitchen device: who is speaking (soft confirmation).
  const who = a.getByTestId('elicit');
  await who.getByLabel('Sam').check();
  await who.getByTestId('elicit-accept').click();
  await expect(a.getByTestId('who')).toHaveText('Logging as Sam');
  await b.getByRole('button', { name: 'Today' }).click();
  await expect(view(b).getByText('Metformin 500 mg').first()).toBeVisible();
  await snap(page, info, 'start');

  // 0:08 Sam checks, then logs; "the small white one" matches two plan lines, so the server asks.
  await say(a, 'Did Mom get her morning pills?');
  await expect(lastReply(a)).toContainText('Recorded response (mock)');
  await a.getByRole('textbox').fill("I'm giving them now, the metformin and the small white one.");
  await a.getByRole('button', { name: 'Send' }).click();
  const which = a.getByTestId('elicit');
  await expect(which).toContainText('Which one is "small white round tablet"?');
  await snap(page, info, 'disambiguation');
  await which.getByLabel('Amlodipine 5 mg', { exact: false }).check();
  await which.getByTestId('elicit-accept').click();
  await expect(lastReply(a)).toContainText('Recorded response (mock)');

  // Window B was showing today: the update arrives and it redraws with Sam's entries.
  await expect(view(b).getByText('Logged by Sam at 8:00').first()).toBeVisible();
  await snap(page, info, 'sync');

  // 0:30 Priya, unaware, tries to log metformin again. The server asks first; "No" writes nothing.
  await b.getByRole('textbox').fill("I'll give Mom her metformin.");
  await b.getByRole('button', { name: 'Send' }).click();
  const twice = b.getByTestId('elicit');
  await expect(twice).toContainText('Sam logged metformin at 8:00. Log again anyway?');
  await snap(page, info, 'double-dose');
  await twice.getByTestId('elicit-decline').click();
  await expect(twice).toHaveCount(0);
  await expect(lastReply(b)).toContainText('Recorded response (mock)');
  await expect(view(b).getByText('Logged twice')).toHaveCount(0);

  // No advice: a fixed sentence.
  await say(b, 'Can I give her half?');
  await expect(lastReply(b)).toContainText("I can't advise on doses.");
  await snap(page, info, 'no-advice');

  // 0:55 Clock to 14:00: Aylin's shift starts and the kitchen device shows her brief unasked.
  await page.getByRole('button', { name: '14:00' }).click();
  await expect(a.getByTestId('transcript')).toContainText("Aylin's shift started.");
  await expect(a.getByTestId('who')).toHaveText('Logging as Aylin');
  await expect(a.getByTestId('screen')).toHaveAttribute('data-view', 'ui://baton/brief');
  await snap(page, info, 'shift-brief');

  // 1:20 Aylin's note is stored word for word.
  const note = 'Mom seemed dizzy after lunch.';
  await say(a, note);
  await expect(lastReply(a)).toContainText('Recorded response (mock)');

  // 1:35 Priya prepares the visit: pick the notes, get a dated timeline.
  await b.getByRole('textbox').fill("Get ready for Thursday's visit with Dr. Lee.");
  await b.getByRole('button', { name: 'Send' }).click();
  const notes = b.getByTestId('elicit');
  await expect(notes).toContainText('Which notes should go on the timeline for Dr. Lee?');
  await snap(page, info, 'visit-notes');
  await notes.getByTestId('elicit-accept').click();
  await expect(b.getByTestId('screen')).toHaveAttribute('data-view', 'ui://baton/visit');
  await expect(view(b).getByText('Dates only. No link is implied.')).toBeVisible();
  await expect(view(b).getByText(note, { exact: false })).toBeVisible();
  await snap(page, info, 'visit-timeline');

  // No interpretation: a fixed sentence, the note stays on the timeline.
  await say(b, 'Is the dizziness from the new pill?');
  await expect(lastReply(b)).toContainText("I can't interpret symptoms.");
  await snap(page, info, 'no-interpretation');
});

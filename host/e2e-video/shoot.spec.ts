// The demo video shoot (teslim storyboard v1): the demo v1 flow, but the caregivers speak. Each line is a
// synthetic clip (evals/stt/video.json) played into the microphone input; the page records it, Whisper in
// the worker recognises it and the transcript goes to the assistant as a visitor's would. If a line is not
// recognised well enough for the recorded script, the shoot types it instead and says so in sahneler.json,
// so the edit can label that line "typed". The recording is silent; sahneler.json holds the press times
// (ms from the start of the video) where the edit places each clip.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clipSeconds, keepEverythingLocal, loadClips, stopModelServer, syntheticMicrophone, useClip, type Outside } from './mic.ts';
import { openHost } from '../e2e/consent.ts';

type VideoLine = { id: string; text: string; voice: string; medId?: string; expect?: string[] };
const lines = JSON.parse(readFileSync(new URL('../../evals/stt/video.json', import.meta.url), 'utf8')) as VideoLine[];

const SERVER = 'http://127.0.0.1:37331';
const kitchen = (p: Page) => p.locator('[data-device="a"]');
const phone = (p: Page) => p.locator('[data-device="b"]');
const view = (device: Locator) => device.getByTestId('screen').frameLocator('iframe.view-frame');
const replies = (device: Locator) => device.getByTestId('transcript').locator('.line.assistant');
const line = (id: string) => lines.find((l) => l.id === id)!;

type Spoken = {
  clip: string;
  device: string;
  pressMs: number;
  releaseMs: number;
  /** When the transcript line (or the failure note) appeared: the edit trims the recognition wait up to here. */
  heardMs: number;
  heard: string;
  matchNote?: string;
  recognised: boolean;
  typed: boolean;
};
type Mark = { scene: string; ms: number };

let t0 = 0;
const at = () => Date.now() - t0;
const marks: Mark[] = [];
const spoken: Spoken[] = [];
const mark = (scene: string) => marks.push({ scene, ms: at() });
const hold = (page: Page, ms = 1500) => page.waitForTimeout(ms);

/** Holds the talk button for the clip, waits for the transcript, falls back to typing if the line was not recognised. */
async function speak(page: Page, device: Locator, name: string, id: string): Promise<Spoken> {
  const l = line(id);
  const transcript = device.getByTestId('transcript');
  const you = transcript.locator('.line.you');
  const youBefore = await you.count();
  const notesBefore = await transcript.locator('.line.system').count();
  const repliesBefore = await replies(device).count();
  await useClip(page, id);
  // The phone's button sits below the fold once its view is drawn; a raw mouse press does not scroll.
  const talk = device.getByTestId('talk');
  await talk.scrollIntoViewIfNeeded();
  const box = (await talk.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const pressMs = at();
  await page.mouse.down();
  await expect(talk).toHaveText('Listening', { timeout: 5_000 });
  await page.waitForTimeout(clipSeconds(id) * 1000 + 150 + 400);
  await page.mouse.up();
  const releaseMs = at();

  // Recognition runs on CPU in the worker; the first press also waits for the model.
  const failed = /Nothing was heard|Microphone:|failed|no microphone/i;
  await expect
    .poll(async () => (await you.count()) > youBefore || failed.test((await transcript.locator('.line.system').allTextContents()).slice(notesBefore).join(' ')), {
      timeout: 300_000,
      intervals: [100],
    })
    .toBe(true);
  const heardMs = at();
  const heard = (await you.count()) > youBefore ? ((await you.last().locator('.text').textContent()) ?? '') : '';
  const note = (await transcript.locator('.line.system').allTextContents()).slice(notesBefore).find((t) => t.includes('Matched to the plan'));
  const recognised = heard !== '' && (l.expect ?? []).every((p) => heard.toLowerCase().includes(p));
  const s: Spoken = { clip: id, device: name, pressMs, releaseMs, heardMs, heard, matchNote: note, recognised, typed: false };
  if (!recognised) {
    // Let the off-script answer land, then type the line so the rest of the flow is the same.
    if (heard) await expect(replies(device)).toHaveCount(repliesBefore + 1);
    await device.getByRole('textbox').fill(l.text);
    await device.getByRole('button', { name: 'Send' }).click();
    s.typed = true;
  }
  spoken.push(s);
  return s;
}

test.beforeAll(async ({ request }) => {
  const r = await request.post(`${SERVER}/clock`, { data: { set: '2026-10-20T08:00:00' } });
  expect(r.ok()).toBe(true);
});

test.afterAll(() => stopModelServer());

/** Browser-side failures go to the test log, so a shoot that dies early says why. */
function watch(p: Page, name: string): void {
  p.on('crash', () => console.log(`[${name}] page crashed`));
  p.on('close', () => console.log(`[${name}] page closed at ${at()} ms`));
  p.on('pageerror', (e) => console.log(`[${name}] page error: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name}] console ${m.type()}: ${m.text()}`);
  });
}

test('shoot: caregivers speak the demo v1 lines', async ({ context, page }, info) => {
  t0 = Date.now();
  context.browser()?.on('disconnected', () => console.log(`browser disconnected at ${at()} ms`));
  context.on('page', (p) => watch(p, 'new page'));
  watch(page, 'main');
  const outside: Outside[] = await keepEverythingLocal(context);
  await syntheticMicrophone(context);

  // Warm-up in a second tab (its video is not used): loads the model into the browser cache once, so the
  // shoot's first press does not sit on a progress bar. It only asks a question; nothing is logged.
  const warm = await context.newPage();
  await openHost(warm);
  await loadClips(warm, ['v1']);
  const warmWho = kitchen(warm).getByTestId('elicit');
  await warmWho.getByLabel('Sam').check();
  await warmWho.getByTestId('elicit-accept').click();
  const warmLine = await speak(warm, kitchen(warm), 'warm-up', 'v1');
  spoken.pop();
  await warm.close();

  // Same browser context as the warm-up: the permission answer is already remembered there.
  await openHost(page);
  await loadClips(page, lines.map((l) => l.id));
  const a = kitchen(page);
  const b = phone(page);
  mark('2 start');
  const who = a.getByTestId('elicit');
  await who.getByLabel('Sam').check();
  await who.getByTestId('elicit-accept').click();
  await expect(a.getByTestId('who')).toHaveText('Logging as Sam');
  await b.getByRole('button', { name: 'Today' }).click();
  await expect(view(b).getByText('Metformin 500 mg').first()).toBeVisible();
  await hold(page);

  // Scene 2: Sam checks, then logs; "the small white one" matches two plan lines, so the server asks.
  mark('2 sam asks');
  let n = await replies(a).count();
  await speak(page, a, 'kitchen', 'v1');
  await expect(replies(a)).toHaveCount(n + 1);
  await hold(page);
  mark('2 sam logs');
  await speak(page, a, 'kitchen', 'v2');
  const which = a.getByTestId('elicit');
  await expect(which).toContainText('Which one is "small white round tablet"?');
  await hold(page);
  await which.getByLabel('Amlodipine 5 mg', { exact: false }).check();
  await which.getByTestId('elicit-accept').click();
  await expect(view(b).getByText('Logged by Sam at 8:00').first()).toBeVisible();
  mark('2 phone redrawn');
  await hold(page, 2500);

  // Scene 4: Nora, unaware, says she will give metformin. The server asks first; "No" writes nothing.
  mark('4 nora second dose');
  await speak(page, b, 'phone', 'v3');
  const twice = b.getByTestId('elicit');
  await expect(twice).toContainText('Sam logged metformin at 8:00. Log again anyway?');
  await hold(page, 2500);
  await twice.getByTestId('elicit-decline').click();
  await expect(twice).toHaveCount(0);
  await expect(view(b).getByText('Logged twice')).toHaveCount(0);
  mark('4 nora half');
  n = await replies(b).count();
  await speak(page, b, 'phone', 'v4');
  await expect(replies(b)).toHaveCount(n + 1);
  await expect(replies(b).last()).toContainText("I can't advise on doses.");
  await hold(page, 2500);

  // Scene 5: two o'clock, Aylin's shift starts and the kitchen device shows her brief unasked.
  mark('5 shift');
  await page.getByRole('button', { name: '14:00' }).click();
  await expect(a.getByTestId('transcript')).toContainText("Aylin's shift started.");
  await expect(a.getByTestId('screen')).toHaveAttribute('data-view', 'ui://baton/brief');
  await hold(page, 3000);

  // Scene 6: Aylin's note, word for word.
  mark('6 note');
  n = await replies(a).count();
  await speak(page, a, 'kitchen', 'v5');
  await expect(replies(a)).toHaveCount(n + 1);
  await hold(page, 2000);

  // Scene 7: Nora prepares the visit, picks the notes, gets the dated timeline, then asks about the pill.
  mark('7 visit');
  await speak(page, b, 'phone', 'v6');
  const notes = b.getByTestId('elicit');
  await expect(notes).toContainText('Which notes should go on the timeline for Dr. Lee?');
  await hold(page, 2000);
  await notes.getByTestId('elicit-accept').click();
  await expect(b.getByTestId('screen')).toHaveAttribute('data-view', 'ui://baton/visit');
  await expect(view(b).getByText('Dates only. No link is implied.')).toBeVisible();
  await expect(view(b).getByText(line('v5').text, { exact: false })).toBeVisible();
  await hold(page, 2500);
  const expand = view(b).getByRole('button', { name: 'Expand' });
  if (await expand.isVisible()) {
    mark('7 expand');
    await expand.click();
    await expect(b).toHaveClass(/fullscreen-view/);
    await hold(page, 3500);
    await view(b).getByRole('button', { name: 'Back' }).click();
    await expect(b).not.toHaveClass(/fullscreen-view/);
  }
  mark('7 pill question');
  n = await replies(b).count();
  await speak(page, b, 'phone', 'v7');
  await expect(replies(b)).toHaveCount(n + 1);
  await expect(replies(b).last()).toContainText("I can't interpret symptoms.");
  await hold(page, 2500);

  // Scene 8: a device without a screen speaks the brief instead of drawing it.
  mark('8 no screen');
  await b.getByLabel('No-screen device').check();
  await expect(b.locator('iframe')).toHaveCount(0);
  await b.getByRole('button', { name: 'Since I left' }).click();
  await expect(b).toHaveAttribute('data-spoken', /since you left/i);
  const noScreenText = await b.getAttribute('data-spoken');
  await hold(page, 3000);

  // Scene 9: the protocol panel, close.
  mark('9 protocol');
  await a.getByTestId('protocol-log').scrollIntoViewIfNeeded();
  await hold(page, 4000);
  mark('end');

  const video = await page.video()?.path();
  const out = {
    note: 'Times are ms from the start of the test, which is a fraction of a second after the video starts; align on the first "Listening" frame. Clips are synthetic (evals/stt/video.json). typed=true lines must carry the "typed" label in the edit.',
    video,
    warmUp: { heard: warmLine.heard, recognised: warmLine.recognised },
    marks,
    spoken,
    noScreenText,
    outside,
  };
  writeFileSync(info.outputPath('sahneler.json'), JSON.stringify(out, null, 2));
  console.log(`shoot: ${spoken.filter((s) => s.recognised).length}/${spoken.length} lines recognised, ${spoken.filter((s) => s.typed).length} typed`);
  for (const s of spoken) console.log(`${s.recognised ? 'ok   ' : 'TYPED'} ${s.clip} heard "${s.heard}"${s.matchNote ? ` (${s.matchNote})` : ''}`);
  console.log(`outside requests: ${outside.filter((o) => o.served === 'local copy').length} served from the local copy, ${outside.filter((o) => o.served === 'blocked').length} blocked`);
  for (const o of outside.filter((x) => x.served === 'blocked')) console.log(`blocked ${o.url}`);
});

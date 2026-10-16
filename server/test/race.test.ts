// Two caregivers at once. Aylin's call reads today's entries, then waits on a question (log amlodipine again?
// which tablet?). While it waits, Nora logs metformin from her own phone. When Aylin answers, her call must
// not write a second metformin that no one was asked about: the write re-reads today's entries and leaves out
// anything someone logged in the meantime, and the reply says who logged it and when.
import { afterEach, describe, expect, it } from 'vitest';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { SPOKEN } from '@baton/contract';
import type { App } from '../src/http.ts';
import { call, connect, decline, start, type Policy, type TestClient } from './helpers.ts';

const today = { from: '2026-10-20', to: '2026-10-20' };

let app: App | undefined;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await app?.close();
  app = undefined;
});

const accept = (): ElicitResult => ({ action: 'accept', content: {} });

/** The tool-result rule: at most 240 characters and two sentences, nothing that only reads on a screen. */
function speakable(text: string): string {
  expect(text.length).toBeGreaterThan(0);
  expect(text.length).toBeLessThanOrEqual(240);
  expect(text).not.toMatch(/[|*#`]|https?:|baton:\/\/|ui:\/\//);
  const sentences = text.replace(/\b(Dr|Mr|Mrs|Ms)\./g, '$1').split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length;
  expect(sentences, text).toBeLessThanOrEqual(2);
  return text;
}
/** Answers "which dose?" with the evening window and every other question with yes. */
const eveningYes: Policy = (p) =>
  'windowId' in (((p as { requestedSchema?: { properties?: object } }).requestedSchema?.properties) ?? {})
    ? { action: 'accept', content: { windowId: 'evening' } }
    : accept();

/** A policy that, before it answers its first question, lets Nora log `item` at `clock` from her own session. */
function answerAfterNora(nora: () => TestClient, item: string, clock: string, answer: Policy): Policy {
  let ran = false;
  return (async (p: Parameters<Policy>[0]) => {
    if (!ran) {
      ran = true;
      app!.ctx.clock.set(clock);
      const r = await call(nora(), 'log_care_event', { memberId: 'nora', items: [item], heardText: item, requestId: 'n1' });
      expect(r.sc.written).toBe(true);
    }
    return answer(p);
  }) as unknown as Policy;
}

/** Sam logs amlodipine at 8:00; Aylin then speaks at `now`. Nora says yes to any question of her own. */
async function setup(policy: (nora: () => TestClient) => Policy, kind: { screen?: boolean } = {}, now = '2026-10-20T08:30:00') {
  app = await start('2026-10-20T08:00:00');
  const sam = await connect(app, 'sam', decline);
  let noraClient: TestClient | undefined;
  const aylin = await connect(app, 'aylin', policy(() => noraClient!), undefined, kind);
  noraClient = await connect(app, 'nora', eveningYes);
  clients.push(sam, aylin, noraClient);
  await call(sam, 'log_care_event', { memberId: 'sam', items: ['amlodipine'], heardText: 'amlodipine', requestId: 's1' });
  app.ctx.clock.set(now);
  return { sam, aylin, nora: noraClient };
}

const who = async (c: TestClient, medId: string) =>
  ((await call(c, 'ledger_query', { ...today, medId })).sc.events as { memberId: string }[]).map((e) => e.memberId);
const metformin = (c: TestClient) => who(c, 'metformin');
const AT_840 = '2026-10-20T08:40:00';

describe('an entry logged by someone else while a question is open', () => {
  it('is not logged a second time when the open question is answered yes', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'metformin', AT_840, accept));
    const r = await call(aylin, 'log_care_event', {
      memberId: 'aylin', items: ['amlodipine', 'metformin'], heardText: 'amlodipine and metformin', requestId: 'a1',
    });
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Sam logged amlodipine at 8:00. Log again anyway?']);
    expect(await metformin(aylin)).toEqual(['nora']);
    expect(r.sc.written).toBe(true);
    expect(r.sc.events.map((e: { medId: string }) => e.medId)).toEqual(['amlodipine']);
    expect(r.sc.loggedMeanwhile).toEqual(['metformin']);
    expect(speakable(r.text)).toBe(
      'Logged amlodipine for Aylin at 8:30. Nora logged metformin at 8:40 while you were answering, so it was not logged again.',
    );
  });

  it('writes nothing when the one item was logged meanwhile, and says so as a fact', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'amlodipine', AT_840, accept));
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['amlodipine'], heardText: 'amlodipine', requestId: 'a2' });
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Sam logged amlodipine at 8:00. Log again anyway?']);
    expect(await who(aylin, 'amlodipine')).toEqual(['sam', 'nora']);
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'logged_meanwhile', loggedMeanwhile: ['amlodipine'] });
    expect(speakable(r.text)).toBe('Nora logged amlodipine at 8:40 while you were answering, so it was not logged again.');
  });

  it('covers the which-dose question too: a dose logged for the chosen window meanwhile is not logged again', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'metformin', '2026-10-20T14:20:00', eveningYes), {}, '2026-10-20T14:10:00');
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'a6' });
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Is this the morning or the evening metformin?']);
    expect(await metformin(aylin)).toEqual(['nora']);
    expect(r.sc).toMatchObject({ written: false, reason: 'logged_meanwhile', loggedMeanwhile: ['metformin'] });
    expect(speakable(r.text)).toBe('Nora logged metformin at 14:20 while you were answering, so it was not logged again.');
  });

  it('says it without the medicine name on a device without a screen', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'metformin', AT_840, accept), { screen: false });
    const r = await call(aylin, 'log_care_event', {
      memberId: 'aylin', items: ['amlodipine', 'metformin'], heardText: 'amlodipine and metformin', requestId: 'a3',
    });
    expect(await metformin(aylin)).toEqual(['nora']);
    expect(speakable(r.text)).toBe('Logged 1 item for Aylin at 8:30. The other one was logged by Nora at 8:40 while you were answering.');
    expect(r.text).not.toMatch(/metformin|amlodipine/i);
  });

  it('words a call with logged, kept and logged-meanwhile items in two sentences', async () => {
    // Sam logged amlodipine at 8:00. Aylin says all three; she says no to amlodipine again, and Nora logs
    // levothyroxine before she answers. Metformin is written, amlodipine kept, levothyroxine logged meanwhile.
    const args = { memberId: 'aylin', items: ['metformin', 'amlodipine', 'levothyroxine'], heardText: 'all three', requestId: 'a7' };
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'levothyroxine', AT_840, decline));
    const r = await call(aylin, 'log_care_event', args);
    expect(r.sc).toMatchObject({ written: true, notLoggedAgain: ['amlodipine'], loggedMeanwhile: ['levothyroxine'] });
    expect(speakable(r.text)).toBe(
      'Logged metformin for Aylin at 8:30. Amlodipine was not logged again, and Nora logged levothyroxine at 8:40 while you were answering.',
    );
  });

  it('gives counts, not "the other one", for the same call on a device without a screen', async () => {
    const args = { memberId: 'aylin', items: ['metformin', 'amlodipine', 'levothyroxine'], heardText: 'all three', requestId: 'a8' };
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'levothyroxine', AT_840, decline), { screen: false });
    const r = await call(aylin, 'log_care_event', args);
    expect(speakable(r.text)).toBe(
      'Logged 1 item for Aylin at 8:30. 1 already had an entry and was not logged again, and 1 was logged by Nora at 8:40 while you were answering.',
    );
    expect(r.text).not.toMatch(/other one|that one|metformin|amlodipine|levothyroxine/i);
  });

  it('writes nothing when one item is kept and the other logged meanwhile, in two sentences', async () => {
    const args = { memberId: 'aylin', items: ['amlodipine', 'metformin'], heardText: 'amlodipine and metformin', requestId: 'a9' };
    const screen = await setup((nora) => answerAfterNora(nora, 'metformin', AT_840, decline));
    const r = await call(screen.aylin, 'log_care_event', args);
    expect(r.sc).toMatchObject({ written: false, reason: 'logged_meanwhile', notLoggedAgain: ['amlodipine'], loggedMeanwhile: ['metformin'] });
    expect(speakable(r.text)).toBe('Nora logged metformin at 8:40 while you were answering, so it was not logged again. Amlodipine was not logged again.');
    for (const c of clients.splice(0)) await c.close();
    await app?.close();

    const quiet = await setup((nora) => answerAfterNora(nora, 'metformin', AT_840, decline), { screen: false });
    const q = await call(quiet.aylin, 'log_care_event', { ...args, requestId: 'a10' });
    expect(speakable(q.text)).toBe('1 already had an entry, and 1 was logged by Nora at 8:40 while you were answering. Nothing new was logged.');
  });

  it('says the note and the words outside the plan were not kept when nothing is written', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'amlodipine', AT_840, accept));
    const r = await call(aylin, 'log_care_event', {
      memberId: 'aylin', items: ['amlodipine', 'the blue vitamin'], note: 'with breakfast', heardText: 'amlodipine and the blue vitamin', requestId: 'a11',
    });
    expect(r.sc).toMatchObject({ written: false, reason: 'logged_meanwhile', unmatched: ['the blue vitamin'] });
    expect(speakable(r.text)).toBe(
      'Nora logged amlodipine at 8:40 while you were answering, so it was not logged again. I did not keep the rest as a note.',
    );
    const notes = (await call(aylin, 'ledger_query', today)).sc.events as { note?: string }[];
    expect(notes.some((e) => e.note?.includes('with breakfast') || e.note?.includes('blue vitamin'))).toBe(false);
  });

  it('says the same on a device without a screen', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'amlodipine', AT_840, accept), { screen: false });
    const r = await call(aylin, 'log_care_event', {
      memberId: 'aylin', items: ['amlodipine'], note: 'with breakfast', heardText: 'amlodipine', requestId: 'a12',
    });
    expect(speakable(r.text)).toBe(`${SPOKEN.loggedMeanwhile([{ by: 'Nora', clock: '8:40' }])} I did not keep the note.`);
  });

  it("says the note was not kept when every item already had an entry and the answer was no", async () => {
    const { aylin } = await setup(() => decline);
    const r = await call(aylin, 'log_care_event', {
      memberId: 'aylin', items: ['amlodipine'], note: 'with breakfast', heardText: 'amlodipine', requestId: 'a13',
    });
    expect(r.sc).toMatchObject({ written: false, reason: 'declined' });
    expect(speakable(r.text)).toBe('Sam logged amlodipine at 8:00. Nothing new was logged, and I did not keep the note.');
  });

  it('a retry with the same requestId returns the first result and writes nothing new', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'metformin', AT_840, accept));
    const args = { memberId: 'aylin', items: ['amlodipine', 'metformin'], heardText: 'amlodipine and metformin', requestId: 'a4' };
    const first = await call(aylin, 'log_care_event', args);
    const again = await call(aylin, 'log_care_event', args);
    expect(again).toEqual(first);
    expect(await metformin(aylin)).toEqual(['nora']);
  });

  it('an entry that was already there when the question was asked is still logged again after a yes', async () => {
    const { aylin } = await setup(() => accept);
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['amlodipine'], heardText: 'amlodipine', requestId: 'a5' });
    expect(r.sc).toMatchObject({ written: true });
    expect(r.sc.loggedMeanwhile).toBeUndefined();
  });
});

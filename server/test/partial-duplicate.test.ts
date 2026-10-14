// Several items in one call, one of which already has an entry in the window. A no to "Log again anyway?"
// is about that item only: the other items are logged and the reply says both things.
import { afterEach, describe, expect, it } from 'vitest';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { SPOKEN } from '@baton/contract';
import type { App } from '../src/http.ts';
import { call, connect, decline, start, type Policy, type TestClient } from './helpers.ts';

let app: App | undefined;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await app?.close();
  app = undefined;
});

async function setup(policy: Policy, kind: { screen?: boolean; elicitation?: boolean } = {}, first = ['amlodipine']) {
  app = await start('2026-10-20T08:00:00');
  const sam = await connect(app, 'sam', decline);
  const aylin = await connect(app, 'aylin', policy, undefined, kind);
  clients.push(sam, aylin);
  await call(sam, 'log_care_event', { memberId: 'sam', items: first, heardText: first.join(' and '), requestId: 'd0' });
  app.ctx.clock.set('2026-10-20T08:30:00');
  return { sam, aylin };
}
const both = { memberId: 'aylin', items: ['amlodipine', 'levothyroxine'], heardText: 'amlodipine and levothyroxine', requestId: 'd1' };
const status = async (c: TestClient, medId: string) => (await call(c, 'check_med', { medId, window: 'morning' })).sc;

describe('declining the second-dose question for one item of several', () => {
  it('logs the other items and says which one was not logged again', async () => {
    const { aylin } = await setup(decline);
    const r = await call(aylin, 'log_care_event', both);
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Sam logged amlodipine at 8:00. Log again anyway?']);
    expect(r.text).toBe('Logged levothyroxine for Aylin at 8:30. Amlodipine was not logged again.');
    expect(r.sc).toMatchObject({ written: true, notLoggedAgain: ['amlodipine'] });
    expect(r.sc.events.map((e: { medId: string }) => e.medId)).toEqual(['levothyroxine']);
    expect(await status(aylin, 'amlodipine')).toMatchObject({ status: 'given', by: 'Sam' });
    expect(await status(aylin, 'levothyroxine')).toMatchObject({ status: 'given', by: 'Aylin' });
  });

  it('says it without names on a device without a screen', async () => {
    const { aylin } = await setup(decline, { screen: false });
    const r = await call(aylin, 'log_care_event', both);
    expect(r.text).toBe(`${SPOKEN.logged(1, 'Aylin', '8:30')} ${SPOKEN.notAgain(1)}.`);
    expect(r.text).toBe('Logged 1 item for Aylin at 8:30. The other one was not logged again.');
  });

  it('a client without elicitation gets the same: the duplicate is left out, the rest is logged', async () => {
    const { aylin } = await setup(decline, { elicitation: false });
    const r = await call(aylin, 'log_care_event', both);
    expect(aylin.elicits).toEqual([]);
    expect(r.text).toBe('Logged levothyroxine for Aylin at 8:30. Amlodipine was not logged again.');
    expect(await status(aylin, 'amlodipine')).toMatchObject({ status: 'given' });
  });

  it('a yes logs both', async () => {
    const { aylin } = await setup((): ElicitResult => ({ action: 'accept', content: {} }));
    const r = await call(aylin, 'log_care_event', both);
    expect(r.text).toBe('Logged amlodipine and levothyroxine for Aylin at 8:30.');
    expect(r.sc.notLoggedAgain).toBeUndefined();
    expect(await status(aylin, 'amlodipine')).toMatchObject({ status: 'logged_twice' });
  });

  it('when every item already has an entry, each one is asked and nothing new is logged', async () => {
    const { aylin } = await setup(decline, {}, ['amlodipine', 'levothyroxine']);
    const r = await call(aylin, 'log_care_event', both);
    expect(aylin.elicits).toHaveLength(2);
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'declined', notLoggedAgain: ['amlodipine', 'levothyroxine'] });
    expect(r.text).toBe('Sam logged amlodipine at 8:00 and Sam logged levothyroxine at 8:00. Nothing new was logged.');
  });

  it('a single item keeps the old reply', async () => {
    const { aylin } = await setup(decline);
    const r = await call(aylin, 'log_care_event', { ...both, items: ['amlodipine'] });
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'declined' });
    expect(r.text).toBe('Sam logged amlodipine at 8:00. Nothing new was logged.');
  });

  it('cancelling the question writes nothing at all', async () => {
    const { aylin } = await setup((): ElicitResult => ({ action: 'cancel' }));
    const r = await call(aylin, 'log_care_event', both);
    expect(r.sc).toMatchObject({ written: false, reason: 'cancelled' });
    expect(await status(aylin, 'levothyroxine')).toMatchObject({ status: 'not_logged' });
  });

  it('an item not in the plan is still kept as a note', async () => {
    const { aylin } = await setup(decline);
    const r = await call(aylin, 'log_care_event', { ...both, items: ['amlodipine', 'levothyroxine', 'vitamin gummies'] });
    expect(r.text).toBe('Logged levothyroxine for Aylin at 8:30. Amlodipine was not logged again, and I kept the rest as a note.');
  });
});

// A dose said outside every window of an item that has more than one window (metformin at 14:10, between
// morning 07:30-09:30 and evening 18:30-20:30). Baton asks which dose it is, a fact only the speaker knows,
// and then runs the usual second-dose check on that window. It never says anything about the timing.
import { afterEach, describe, expect, it } from 'vitest';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { FIXED, SPOKEN, loadFixture } from '@baton/contract';
import type { App } from '../src/http.ts';
import { call, connect, decline, start, type Policy, type TestClient } from './helpers.ts';

const fx = loadFixture('june');
const today = { from: '2026-10-20', to: '2026-10-20' };

let app: App | undefined;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await app?.close();
  app = undefined;
});

async function setup(kind: { screen?: boolean; elicitation?: boolean } = {}, policy: Policy = decline) {
  app = await start('2026-10-20T08:00:00');
  const sam = await connect(app, 'sam', decline);
  const aylin = await connect(app, 'aylin', policy, undefined, kind);
  clients.push(sam, aylin);
  await call(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 'w0' });
  app.ctx.clock.set('2026-10-20T14:10:00');
  return { app, sam, aylin };
}

/** Answers the which-dose question with `windowId` and the second-dose question with `again`. */
const answer = (windowId: string, again: 'accept' | 'decline'): Policy => (p): ElicitResult => {
  if ('windowId' in (((p as { requestedSchema?: { properties?: object } }).requestedSchema?.properties) ?? {})) {
    return { action: 'accept', content: { windowId } };
  }
  return again === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
};

const optionsOf = (p: ElicitRequest['params']) =>
  ((p as { requestedSchema?: any }).requestedSchema.properties.windowId.oneOf as { const: string; title: string }[]);
const events = async (c: TestClient) => (await call(c, 'ledger_query', today)).sc.events as { medId: string; windowId?: string; memberId: string }[];

describe('a dose said outside every window of a two-window item', () => {
  it('asks which dose it is, then the second-dose check runs on the morning window', async () => {
    const { aylin } = await setup({}, answer('morning', 'decline'));
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'gave her the metformin', requestId: 'w1' });
    expect(aylin.elicits.map((e) => e.message)).toEqual([
      'Is this the morning or the evening metformin?',
      FIXED.duplicate('Sam', 'metformin', '8:00'),
    ]);
    expect(optionsOf(aylin.elicits[0]!)).toEqual([
      { const: 'morning', title: 'Morning, 7:30 to 9:30' },
      { const: 'evening', title: 'Evening, 18:30 to 20:30' },
    ]);
    expect(r.sc).toMatchObject({ written: false, reason: 'declined' });
    expect(await events(aylin)).toHaveLength(1);
  });

  it('a yes to the second-dose question logs it in the morning window', async () => {
    const { aylin } = await setup({}, answer('morning', 'accept'));
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'w2' });
    expect(r.sc.written).toBe(true);
    expect((await call(aylin, 'check_med', { medId: 'metformin', window: 'morning' })).sc.status).toBe('logged_twice');
  });

  it('the evening dose goes in the evening window with no second-dose question', async () => {
    const { app, aylin } = await setup({}, answer('evening', 'decline'));
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'w3' });
    expect(aylin.elicits).toHaveLength(1);
    expect(r.sc.written).toBe(true);
    expect((await events(aylin)).find((e) => e.memberId === 'aylin')!.windowId).toBe('evening');
    app.ctx.clock.set('2026-10-20T19:00:00');
    expect((await call(aylin, 'check_med', { medId: 'metformin', window: 'evening' })).sc).toMatchObject({ status: 'given', by: 'Aylin' });
    expect((await call(aylin, 'check_med', { medId: 'metformin', window: 'morning' })).sc.status).toBe('given');
  });

  it('declining the question writes nothing', async () => {
    const { aylin } = await setup({}, decline);
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'w4' });
    expect(r.sc).toMatchObject({ written: false, reason: 'declined' });
    expect(await events(aylin)).toHaveLength(1);
  });

  it('without elicitation: nothing is written, and the reply names the windows and what each holds', async () => {
    const { aylin } = await setup({ elicitation: false });
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin', 'amlodipine'], heardText: 'metformin and amlodipine', requestId: 'w5' });
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'which_dose', options: ['morning', 'evening'] });
    expect(r.text).toBe('Nothing was logged: metformin has two windows today, morning (Sam at 8:00) and evening (no entry). Say which dose this is.');
    expect(r.text.length).toBeLessThanOrEqual(240);
    expect(await events(aylin)).toHaveLength(1);
  });

  it('on a device without a screen the question and the reply name no medicine', async () => {
    const { aylin } = await setup({ screen: false }, answer('morning', 'decline'));
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'w6' });
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Is this the morning or the evening one?', SPOKEN.duplicate('Sam', '8:00')]);
    expect(r.text).toBe(SPOKEN.duplicateKept('Sam', '8:00'));
    const quiet = await connect(app!, 'speaker', decline, undefined, { screen: false, elicitation: false });
    clients.push(quiet);
    const q = await call(quiet, 'log_care_event', { memberId: 'nora', items: ['metformin'], heardText: 'metformin', requestId: 'w7' });
    expect(q.text).toBe(SPOKEN.whichDoseUnasked('two', 'morning (Sam at 8:00) and evening (no entry)'));
    const said = [q.text, r.text, ...aylin.elicits.flatMap((e) => [e.message, ...(e.message.startsWith('Is this') ? optionsOf(e).map((o) => o.title) : [])])];
    for (const s of said) for (const p of fx.plan) for (const f of [p.id, p.generic, p.name, p.looks]) expect(s.toLowerCase()).not.toContain(f.toLowerCase());
  });
});

describe('cases that keep the old behaviour', () => {
  it('a single-window item said outside its window is checked against that window, with no extra question', async () => {
    app = await start('2026-10-20T08:00:00');
    const sam = await connect(app, 'sam', decline);
    clients.push(sam);
    await call(sam, 'log_care_event', { memberId: 'sam', items: ['amlodipine'], heardText: 'amlodipine', requestId: 's1' });
    app.ctx.clock.set('2026-10-20T14:10:00');
    const r = await call(sam, 'log_care_event', { memberId: 'sam', items: ['amlodipine'], heardText: 'amlodipine', requestId: 's2' });
    expect(sam.elicits.map((e) => e.message)).toEqual([FIXED.duplicate('Sam', 'amlodipine', '8:00')]);
    expect(r.text).toBe('Sam logged amlodipine at 8:00. Nothing new was logged.');
  });

  it('a dose said inside a window is filed there with no extra question', async () => {
    app = await start('2026-10-20T19:00:00');
    const sam = await connect(app, 'sam', decline);
    clients.push(sam);
    const r = await call(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 's3' });
    expect(sam.elicits).toEqual([]);
    expect(r.sc.written).toBe(true);
  });
});

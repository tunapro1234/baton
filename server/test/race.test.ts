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
    expect(r.text).toBe(
      'Logged amlodipine for Aylin at 8:30. Nora logged metformin at 8:40 while you were answering. Nothing new was logged for it.',
    );
  });

  it('writes nothing when the one item was logged meanwhile, and says so as a fact', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'amlodipine', AT_840, accept));
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['amlodipine'], heardText: 'amlodipine', requestId: 'a2' });
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Sam logged amlodipine at 8:00. Log again anyway?']);
    expect(await who(aylin, 'amlodipine')).toEqual(['sam', 'nora']);
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'logged_meanwhile', loggedMeanwhile: ['amlodipine'] });
    expect(r.text).toBe('Nora logged amlodipine at 8:40 while you were answering. Nothing new was logged for it.');
  });

  it('covers the which-dose question too: a dose logged for the chosen window meanwhile is not logged again', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'metformin', '2026-10-20T14:20:00', eveningYes), {}, '2026-10-20T14:10:00');
    const r = await call(aylin, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'a6' });
    expect(aylin.elicits.map((e) => e.message)).toEqual(['Is this the morning or the evening metformin?']);
    expect(await metformin(aylin)).toEqual(['nora']);
    expect(r.sc).toMatchObject({ written: false, reason: 'logged_meanwhile', loggedMeanwhile: ['metformin'] });
    expect(r.text).toBe('Nora logged metformin at 14:20 while you were answering. Nothing new was logged for it.');
  });

  it('says it without the medicine name on a device without a screen', async () => {
    const { aylin } = await setup((nora) => answerAfterNora(nora, 'metformin', AT_840, accept), { screen: false });
    const r = await call(aylin, 'log_care_event', {
      memberId: 'aylin', items: ['amlodipine', 'metformin'], heardText: 'amlodipine and metformin', requestId: 'a3',
    });
    expect(await metformin(aylin)).toEqual(['nora']);
    expect(r.text).toBe(`${SPOKEN.logged(1, 'Aylin', '8:30')} ${SPOKEN.loggedMeanwhile([{ by: 'Nora', clock: '8:40' }])}`);
    expect(r.text).not.toMatch(/metformin|amlodipine/i);
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

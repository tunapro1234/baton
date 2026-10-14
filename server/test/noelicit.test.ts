// A client that does not declare elicitation cannot be asked anything. Baton then never writes on a guess:
// a second dose in the same window is not logged and the reply says who logged it and when; an item that
// matches two plan lines is not logged and the reply says what the choices are.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPOKEN } from '@baton/contract';
import type { App } from '../src/http.ts';
import { accept, call, connect, start, type TestClient } from './helpers.ts';

let app: App;
let sam: TestClient;
let plain: TestClient;
let speaker: TestClient;

const today = { from: '2026-10-20', to: '2026-10-20' };
const ledger = async (c: TestClient) => (await call(c, 'ledger_query', today)).sc.events.map((e: { eventId: string }) => e.eventId).sort();

beforeAll(async () => {
  app = await start('2026-10-20T08:00:00');
  sam = await connect(app, 'sam', accept);
  plain = await connect(app, 'no-elicitation', accept, undefined, { elicitation: false });
  speaker = await connect(app, 'speaker-no-elicitation', accept, undefined, { elicitation: false, screen: false });
});
afterAll(async () => {
  await sam?.close();
  await plain?.close();
  await speaker?.close();
  await app?.close();
});

describe('a client without elicitation', () => {
  it('is seen by the server as a client without elicitation', () => {
    const session = [...app.ctx.hub.sessions.values()].find((s) => s.server.getClientVersion()?.name === 'no-elicitation');
    expect(session).toBeDefined();
    expect(session!.server.getClientCapabilities()?.elicitation).toBeUndefined();
  });

  it('second dose: written false, says who and when, the ledger is unchanged', async () => {
    const first = await call(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 'n1' });
    expect(first.sc.written).toBe(true);
    const before = await ledger(sam);

    const r = await call(plain, 'log_care_event', { memberId: 'nora', items: ['metformin'], heardText: 'gave her the metformin', requestId: 'n2' });
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'already_logged' });
    expect(r.text).toBe('Sam logged metformin at 8:00. Nothing new was logged.');
    expect(plain.elicits).toEqual([]);
    expect(await ledger(sam)).toEqual(before);
    expect((await call(plain, 'check_med', { medId: 'metformin' })).sc.status).toBe('given');
  });

  it('second dose on a device without a screen: the same, in spoken wording', async () => {
    const before = await ledger(sam);
    const r = await call(speaker, 'log_care_event', { memberId: 'nora', items: ['metformin'], heardText: 'metformin', requestId: 'n3' });
    expect(r.sc).toMatchObject({ written: false, reason: 'already_logged' });
    expect(r.text).toBe(SPOKEN.duplicateKept('Sam', '8:00'));
    expect(await ledger(sam)).toEqual(before);
  });

  it('ambiguous item: nothing is written and the choices are stated', async () => {
    const before = await ledger(sam);
    const r = await call(plain, 'log_care_event', {
      memberId: 'sam', items: ['the small white one'], heardText: 'gave her the small white one', requestId: 'n4',
    });
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'ambiguous' });
    expect([...r.sc.options].sort()).toEqual(['amlodipine', 'levothyroxine']);
    expect(r.text).toBe('"the small white one" could be amlodipine or levothyroxine, so nothing was logged. Say which one.');
    expect(r.text.length).toBeLessThanOrEqual(240);
    expect(await ledger(sam)).toEqual(before);
  });

  it('a mixed list writes nothing at all when one item is ambiguous', async () => {
    const before = await ledger(sam);
    const r = await call(plain, 'log_care_event', {
      memberId: 'sam', items: ['levothyroxine', 'the small white one'], heardText: 'levothyroxine and the small white one', requestId: 'n5',
    });
    expect(r.sc.written).toBe(false);
    expect(await ledger(sam)).toEqual(before);
  });

  it('a retried request gets the same answer and still writes nothing', async () => {
    const r = await call(plain, 'log_care_event', { memberId: 'nora', items: ['metformin'], heardText: 'retry', requestId: 'n2' });
    expect(r.sc).toMatchObject({ written: false, reason: 'already_logged' });
    expect((await call(plain, 'check_med', { medId: 'metformin' })).sc.eventIds).toHaveLength(1);
  });
});

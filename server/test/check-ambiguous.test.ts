// check_med with a description that fits more than one plan line ("the small white one" is amlodipine or
// levothyroxine). Baton asks which one; when it cannot ask, it answers for every line the words fit
// instead of for whichever comes first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPOKEN, loadFixture } from '@baton/contract';
import type { App } from '../src/http.ts';
import { call, connect, decline, pick, start, type TestClient } from './helpers.ts';

const fx = loadFixture('june');
let app: App;
let sam: TestClient;

beforeAll(async () => {
  app = await start('2026-10-20T08:00:00');
  sam = await connect(app, 'sam', decline);
  await call(sam, 'log_care_event', { memberId: 'sam', items: ['levothyroxine'], heardText: 'levothyroxine', requestId: 'c0' });
});
afterAll(async () => {
  await sam?.close();
  await app?.close();
});

async function client(name: string, kind: { screen?: boolean; elicitation?: boolean }, policy = decline) {
  return connect(app, name, policy, undefined, kind);
}

const EACH = '"the small white one" could be amlodipine or levothyroxine. In the morning window, no one has logged amlodipine and Sam logged levothyroxine at 8:00.';

describe('check_med with a description that fits two plan lines', () => {
  it('asks which one and answers for the chosen line', async () => {
    const c = await client('pick', {}, pick('medId', 'levothyroxine'));
    try {
      const r = await call(c, 'check_med', { medId: 'the small white one' });
      expect(c.elicits.map((e) => e.message)).toEqual(['Which one is "the small white one"?']);
      const opts = ((c.elicits[0] as any).requestedSchema.properties.medId.oneOf as { const: string }[]).map((o) => o.const).sort();
      expect(opts).toEqual(['amlodipine', 'levothyroxine']);
      expect(r.sc).toMatchObject({ status: 'given', medId: 'levothyroxine', by: 'Sam' });
      expect(r.text).toBe('Sam logged levothyroxine at 8:00, in the morning window.');
    } finally {
      await c.close();
    }
  });

  it('without elicitation it answers for every line the words fit', async () => {
    const c = await client('plain', { elicitation: false });
    try {
      const r = await call(c, 'check_med', { medId: 'the small white one', window: 'morning' });
      expect(r.text).toBe(EACH);
      expect(r.text.length).toBeLessThanOrEqual(240);
      expect(r.sc.medId).toBeUndefined();
      expect(r.sc).toMatchObject({ status: 'not_logged', window: 'morning', options: ['amlodipine', 'levothyroxine'] });
      expect(r.sc.matches).toEqual([
        { medId: 'amlodipine', status: 'not_logged', eventIds: [] },
        expect.objectContaining({ medId: 'levothyroxine', status: 'given', by: 'Sam', at: '2026-10-20T08:00:00' }),
      ]);
    } finally {
      await c.close();
    }
  });

  it('a declined question gets the same answer for every line', async () => {
    const c = await client('declines', {}, decline);
    try {
      const r = await call(c, 'check_med', { medId: 'the small white one' });
      expect(c.elicits).toHaveLength(1);
      expect(r.text).toBe(EACH);
    } finally {
      await c.close();
    }
  });

  it('"her white pill" fits all three lines', async () => {
    const c = await client('three', { elicitation: false });
    try {
      const r = await call(c, 'check_med', { medId: 'her white pill' });
      expect(r.sc.options).toEqual(['metformin', 'amlodipine', 'levothyroxine']);
      expect(r.text).toBe('"her white pill" could be metformin, amlodipine or levothyroxine. In the morning window, no one has logged metformin, no one has logged amlodipine and Sam logged levothyroxine at 8:00.');
      expect(r.text.length).toBeLessThanOrEqual(240);
    } finally {
      await c.close();
    }
  });

  it('a device without a screen is not asked (the choices name medicines) and hears no names', async () => {
    const c = await client('speaker', { screen: false }, pick('medId', 'levothyroxine'));
    try {
      const r = await call(c, 'check_med', { medId: 'the small white one' });
      expect(c.elicits).toEqual([]);
      expect(r.text).toBe(SPOKEN.checkEach(2, 1, 'morning'));
      for (const p of fx.plan) for (const f of [p.id, p.generic, p.name, p.looks]) expect(r.text.toLowerCase()).not.toContain(f.toLowerCase());
    } finally {
      await c.close();
    }
  });

  it('a name that fits one line is answered directly, with no question', async () => {
    const c = await client('direct', {}, pick('medId', 'amlodipine'));
    try {
      const r = await call(c, 'check_med', { medId: 'levothyroxine' });
      expect(c.elicits).toEqual([]);
      expect(r.sc).toMatchObject({ status: 'given', medId: 'levothyroxine' });
    } finally {
      await c.close();
    }
  });
});

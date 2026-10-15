// The rules from the README section "The pattern, for your own MCP server", one named test each, so the
// README can point at one file. None of this is new behaviour: tools.test.ts, partial-duplicate.test.ts,
// noelicit.test.ts and policy.test.ts cover each rule in detail. Here the same household record is written
// by three kinds of client: one with a screen, one that cannot be asked, and a speaker without a screen.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixture } from '@baton/contract';
import type { App } from '../src/http.ts';
import { accept, call, connect, decline, start, type TestClient } from './helpers.ts';

const fx = loadFixture('june');
const STRENGTH = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g)\b/i;
const today = { from: '2026-10-20', to: '2026-10-20' };

let app: App;
let sam: TestClient;
let nora: TestClient;
let plain: TestClient;
let speaker: TestClient;

const ledger = async () => (await call(sam, 'ledger_query', today)).sc.events.map((e: { eventId: string }) => e.eventId).sort();
const secondMetformin = (requestId: string) => ({ memberId: 'nora', items: ['metformin'], heardText: 'I gave Mom her metformin', requestId });

beforeAll(async () => {
  app = await start('2026-10-20T08:00:00');
  sam = await connect(app, 'sam-phone', accept);
  nora = await connect(app, 'nora-phone', decline);
  plain = await connect(app, 'cannot-ask', accept, undefined, { elicitation: false });
  speaker = await connect(app, 'kitchen-speaker', decline, undefined, { screen: false });
  const first = await call(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 'first' });
  expect(first.sc.written).toBe(true);
});
afterAll(async () => {
  await sam?.close();
  await nora?.close();
  await plain?.close();
  await speaker?.close();
  await app?.close();
});

describe('the pattern', () => {
  it('rule 1: before a second entry for the same dose, the server asks and names who wrote the first', async () => {
    const before = nora.elicits.length;
    await call(nora, 'log_care_event', secondMetformin('second-asked'));
    const asked = nora.elicits.slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.message).toBe('Sam logged metformin at 8:00. Log again anyway?');
  });

  it('rule 1: declining that question writes nothing', async () => {
    const before = await ledger();
    const r = await call(nora, 'log_care_event', secondMetformin('second-declined'));
    expect(r.sc).toMatchObject({ written: false, reason: 'declined' });
    expect(await ledger()).toEqual(before);
  });

  it('rule 2: a client that cannot be asked gets the fact, and nothing is written', async () => {
    const before = await ledger();
    const r = await call(plain, 'log_care_event', secondMetformin('second-cannot-ask'));
    expect(r.sc).toMatchObject({ written: false, events: [], reason: 'already_logged' });
    expect(r.text).toContain('Sam');
    expect(r.text).toContain('8:00');
    expect(plain.elicits).toEqual([]);
    expect(await ledger()).toEqual(before);
  });

  it('rule 3: a client without a screen hears no plan medicine name, pill description or strength', async () => {
    const before = speaker.elicits.length;
    const logged = await call(speaker, 'log_care_event', secondMetformin('second-speaker'));
    const checked = await call(speaker, 'check_med', { medId: 'metformin' });
    const heard = [logged.text, checked.text, ...speaker.elicits.slice(before).map((e) => e.message)];
    expect(heard.length).toBeGreaterThanOrEqual(3);
    for (const h of heard) {
      const lower = h.toLowerCase();
      for (const p of fx.plan) {
        for (const word of [p.id, p.name, p.generic, p.looks, p.dose]) expect(lower, `"${h}" contains "${word}"`).not.toContain(word.toLowerCase());
      }
      expect(h, `"${h}" names a strength`).not.toMatch(STRENGTH);
    }
    expect(logged.sc.written).toBe(false);
  });
});

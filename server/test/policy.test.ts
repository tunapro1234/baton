// What a device without a screen hears. A client that does not declare the MCP Apps UI extension gets the
// spoken sentences: no plan medicine name, no description of a pill, no strength and no words of a note.
// Screen clients keep the regular sentences (tools.test.ts checks those word for word).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { FIXED, SPOKEN, loadFixture } from '@baton/contract';
import type { App } from '../src/http.ts';
import { accept, call, connect, decline, start, type Policy, type TestClient } from './helpers.ts';

const fx = loadFixture('june');
const NOTE = 'Mom seemed dizzy after lunch, and her hands shook.';

/** Every string that must not be read out loud, taken from the fixture plus the note this test logs. */
const FORBIDDEN: string[] = [
  ...fx.plan.flatMap((p) => [p.id, p.name, p.generic, p.looks, p.dose]),
  ...fx.observations.map((o) => o.text),
  ...fx.planChanges.map((c) => c.text),
  NOTE,
];
const STRENGTH = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g)\b/i;

/** Message plus every option title of an elicitation: a speaker reads all of it. */
function elicitStrings(p: ElicitRequest['params']): string[] {
  const out = [p.message];
  const props = ((p as { requestedSchema?: { properties?: Record<string, any> } }).requestedSchema?.properties ?? {});
  for (const s of Object.values(props)) {
    if (s.title) out.push(s.title);
    for (const o of [...(s.oneOf ?? []), ...(s.items?.anyOf ?? []), ...(s.items?.oneOf ?? [])]) out.push(o.title ?? o.const);
  }
  return out;
}

function clean(heard: string): void {
  const lower = heard.toLowerCase();
  for (const f of FORBIDDEN) expect(lower, `"${heard}" contains "${f}"`).not.toContain(f.toLowerCase());
  expect(heard, `"${heard}" names a strength`).not.toMatch(STRENGTH);
}

function speakable(text: string): void {
  expect(text.length).toBeGreaterThan(0);
  expect(text.length).toBeLessThanOrEqual(240);
  const sentences = text.replace(/\b(Dr|Mr|Mrs|Ms)\./g, '$1').split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length;
  expect(sentences).toBeLessThanOrEqual(2);
}

let app: App;
let sam: TestClient;
let nora: TestClient;
const heard: string[] = [];

/** Calls a tool and keeps what the device would say. */
async function say(c: TestClient, name: string, args: Record<string, unknown>) {
  const before = c.elicits.length;
  const r = await call(c, name, args);
  heard.push(r.text);
  for (const e of c.elicits.slice(before)) heard.push(...elicitStrings(e));
  speakable(r.text);
  return r;
}

const pickFirst: Policy = (p) => {
  const props = ((p as { requestedSchema?: { properties?: Record<string, any> } }).requestedSchema?.properties ?? {});
  const content: Record<string, string | string[]> = {};
  for (const [k, s] of Object.entries(props)) {
    if (s.type === 'array') content[k] = (s.items?.anyOf ?? []).map((o: { const: string }) => o.const);
    else if (s.oneOf) content[k] = s.oneOf[0].const;
  }
  return { action: 'accept', content };
};

beforeAll(async () => {
  app = await start('2026-10-20T07:10:00');
  sam = await connect(app, 'sam-speaker', pickFirst, undefined, { screen: false });
  nora = await connect(app, 'nora-speaker', decline, undefined, { screen: false });
});
afterAll(async () => {
  await sam?.close();
  await nora?.close();
  await app?.close();
});

describe('a device without a screen', () => {
  it('runs the main flows without naming a medicine, a pill, a strength or a note', async () => {
    await say(sam, 'who_is_here', { defaultMemberId: 'sam' });
    // Before the window: upcoming.
    await say(sam, 'check_med', { medId: 'metformin' });
    app.ctx.clock.set('2026-10-20T08:00:00');
    expect((await say(sam, 'check_med', { medId: 'metformin' })).sc.status).toBe('not_logged');
    await say(sam, 'check_med', {});
    await say(sam, 'check_med', { medId: 'aspirin 100 mg' });
    await say(sam, 'check_med', { medId: 'levothyroxine', window: 'evening' });

    // An item that matches two plan lines is not asked out loud: nothing is written.
    const amb = await say(sam, 'log_care_event', {
      memberId: 'sam', items: ['metformin', 'the small white one'], heardText: 'metformin and the small white one', requestId: 'p1',
    });
    expect(amb.sc).toMatchObject({ written: false, reason: 'ambiguous' });
    expect(amb.sc.options.sort()).toEqual(['amlodipine', 'levothyroxine']);
    expect(amb.text).toBe(SPOKEN.ambiguous(2));
    expect((await call(sam, 'ledger_query', { from: '2026-10-20', to: '2026-10-20' })).sc.events).toHaveLength(0);

    const logged = await say(sam, 'log_care_event', {
      memberId: 'sam', items: ['metformin', 'amlodipine', 'vitamin gummies'], heardText: 'metformin, amlodipine and a gummy', requestId: 'p2',
    });
    expect(logged.sc.written).toBe(true);
    expect(logged.text).toBe(`${SPOKEN.logged(2, 'Sam', '8:00')} I kept the rest as a note.`);
    await say(sam, 'check_med', { medId: 'metformin' });
    await say(sam, 'check_med', {});

    // Nora, unaware, logs metformin again: the question names who and when, not the medicine.
    const dup = await say(nora, 'log_care_event', { memberId: 'nora', items: ['metformin'], heardText: 'gave the metformin', requestId: 'p3' });
    expect(nora.elicits.at(-1)!.message).toBe(SPOKEN.duplicate('Sam', '8:00'));
    expect(dup.sc).toMatchObject({ written: false, reason: 'declined' });
    expect(dup.text).toBe(SPOKEN.duplicateKept('Sam', '8:00'));
    nora.policy = accept;
    expect((await say(nora, 'log_care_event', { memberId: 'nora', items: ['metformin'], heardText: 'log it', requestId: 'p4' })).sc.written).toBe(true);
    expect((await say(nora, 'check_med', { medId: 'metformin' })).sc.status).toBe('logged_twice');
    await say(nora, 'check_med', {});
    await say(sam, 'log_care_event', { memberId: 'sam', items: ['levothyroxine'], heardText: 'levothyroxine', requestId: 'p5' });

    await say(sam, 'today_view', {});
    await say(sam, 'ledger_query', { medId: 'metformin', from: '2026-10-20', to: '2026-10-20' });
    await say(sam, 'log_observation', { memberId: 'sam', text: NOTE });

    // Correction: the confirmation names who and when.
    const q = await call(nora, 'ledger_query', { memberId: 'nora', from: '2026-10-20', to: '2026-10-20' });
    const fix = await say(nora, 'correct_entry', { eventId: q.sc.events[0].eventId, reason: 'Logged twice by mistake' });
    expect(fix.sc.corrected).toBe(true);
    await say(nora, 'ledger_query', { kind: 'correction', from: '2026-10-20', to: '2026-10-20' });

    // Afternoon: Aylin's brief is numbers only; the visit timeline lists notes by who and when.
    app.ctx.clock.set('2026-10-20T14:00:00');
    const brief = await say(sam, 'handoff_brief', { memberId: 'aylin' });
    expect(brief.text).toMatch(/^Since you left yesterday at 20:00, there are \d+ new items\. Open Baton on a screen for the details\.$/);
    await say(nora, 'handoff_brief', { memberId: 'nora' });
    const visit = await say(sam, 'visit_brief', { from: '2026-10-14', to: '2026-10-20' });
    expect(visit.sc.rows.some((r: { text: string }) => r.text.includes(NOTE))).toBe(true);
    await say(sam, 'today_view', { date: '2026-10-19' });

    // Evening: the one evening item is logged.
    app.ctx.clock.set('2026-10-20T19:00:00');
    await say(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'evening metformin', requestId: 'p6' });
    await say(sam, 'check_med', { window: 'evening' });

    expect(heard.length).toBeGreaterThan(30);
    for (const h of heard) clean(h);
  });

  it('keeps the structured result whole: the screen-free rule is about what is said', async () => {
    const r = await call(sam, 'today_view', { date: '2026-10-20' });
    expect(r.sc.grid.some((g: { medName: string }) => g.medName === 'Metformin 500 mg')).toBe(true);
    clean(r.text);
  });
});

describe('a device with a screen', () => {
  it('still hears the regular sentences', async () => {
    const screen = await connect(app, 'kitchen', decline);
    try {
      app.ctx.clock.set('2026-10-21T08:00:00');
      await call(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 'p7' });
      const r = await call(screen, 'log_care_event', { memberId: 'aylin', items: ['metformin'], heardText: 'metformin', requestId: 'p8' });
      expect(screen.elicits.at(-1)!.message).toBe(FIXED.duplicate('Sam', 'metformin', '8:00'));
      expect(r.text).toBe('Sam logged metformin at 8:00. Nothing new was logged.');
      expect((await call(screen, 'check_med', { medId: 'metformin' })).text).toBe('Sam logged metformin at 8:00, in the morning window.');
    } finally {
      await screen.close();
    }
  });

  it('and the plan view result carries the consent line', async () => {
    const r = await call(sam, 'today_view', {});
    expect(r.sc.consent).toBe('June agreed to this shared log and its purpose on 2026-10-13 (fictional).');
  });
});

// The tool contract from end to end, through real MCP clients on two sessions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESOURCE, UI, VISIT_NOTE } from '@baton/contract';
import type { App } from '../src/http.ts';
import { accept, call, connect, decline, pick, start, waitFor, type TestClient } from './helpers.ts';

let app: App;
let sam: TestClient;
let priya: TestClient;

beforeAll(async () => {
  app = await start('2026-10-20T08:00:00');
  sam = await connect(app, 'sam', pick('medId', 'amlodipine'));
  priya = await connect(app, 'priya', decline);
});
afterAll(async () => {
  await sam?.close();
  await priya?.close();
  await app?.close();
});

/** Form elicitations carry requestedSchema; the SDK types params as a form | url union. */
const schemaOf = (p: unknown): any => (p as { requestedSchema?: unknown }).requestedSchema;

function speakable(text: string) {
  expect(text.length).toBeGreaterThan(0);
  expect(text.length).toBeLessThanOrEqual(240);
  expect(text).not.toMatch(/[|*#`]|https?:|baton:\/\/|ui:\/\//);
  const sentences = text.replace(/\b(Dr|Mr|Mrs|Ms)\./g, '$1').split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length;
  expect(sentences).toBeLessThanOrEqual(2);
  expect(text).not.toMatch(/\bsafe\b|okay to give|\byou should\b|\bprobably\b|caused by|\byou can give\b/i);
}

describe('tools/list', () => {
  it('lists nine tools with output schemas and views on the definition', async () => {
    const { tools } = await sam.listTools();
    expect(tools).toHaveLength(9);
    for (const t of tools) expect(t.outputSchema?.type).toBe('object');
    const ui = (n: string) => (tools.find((t) => t.name === n)?._meta as any)?.ui?.resourceUri;
    expect(ui('today_view')).toBe(UI.today);
    expect(ui('handoff_brief')).toBe(UI.brief);
    expect(ui('visit_brief')).toBe(UI.visit);
    expect(tools.find((t) => t.name === 'correct_entry')?.annotations?.destructiveHint).toBe(true);
  });
});

describe('logging a morning round', () => {
  it('starts with nothing logged', async () => {
    const r = await call(sam, 'check_med', { medId: 'metformin' });
    expect(r.sc.status).toBe('not_logged');
    speakable(r.text);
  });

  it('asks which plan item "the small white one" is, then logs both', async () => {
    const r = await call(sam, 'log_care_event', {
      memberId: 'sam', items: ['metformin', 'the small white one'], heardText: 'metformin and the small white one', requestId: 'r1',
    });
    const ask = sam.elicits.at(-1)!;
    const opts = (schemaOf(ask).properties.medId.oneOf as { const: string }[]).map((o) => o.const).sort();
    expect(opts).toEqual(['amlodipine', 'levothyroxine']);
    expect(r.sc.written).toBe(true);
    expect(r.sc.events.map((e: any) => e.medId).sort()).toEqual(['amlodipine', 'metformin']);
    speakable(r.text);
  });

  it('does not write twice for a retried requestId', async () => {
    await call(sam, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'retry', requestId: 'r1' });
    const r = await call(sam, 'check_med', { medId: 'metformin' });
    expect(r.sc.status).toBe('given');
    expect(r.sc.eventIds).toHaveLength(1);
    expect(r.sc.by).toBe('Sam');
  });

  it('asks before a second metformin and writes nothing on decline', async () => {
    const r = await call(priya, 'log_care_event', { memberId: 'priya', items: ['metformin'], heardText: "I'll give Mom her metformin.", requestId: 'r2' });
    expect(priya.elicits.at(-1)!.message).toBe('Sam logged metformin at 8:00. Log again anyway?');
    expect(schemaOf(priya.elicits.at(-1)!)).toEqual({ type: 'object', properties: {} });
    expect(r.sc).toMatchObject({ written: false, reason: 'declined' });
    speakable(r.text);
    expect((await call(priya, 'check_med', { medId: 'metformin' })).sc.eventIds).toHaveLength(1);
  });

  it('logs it on accept and reports logged_twice', async () => {
    priya.policy = accept;
    const r = await call(priya, 'log_care_event', { memberId: 'priya', items: ['metformin'], heardText: 'log it anyway', requestId: 'r3' });
    expect(r.sc.written).toBe(true);
    const c = await call(priya, 'check_med', { medId: 'metformin' });
    expect(c.sc.status).toBe('logged_twice');
    speakable(c.text);
  });

  it('keeps unknown items out of the plan', async () => {
    const r = await call(sam, 'log_care_event', { memberId: 'sam', items: ['vitamin gummies'], heardText: 'gave her vitamin gummies', requestId: 'r4' });
    expect(r.sc).toMatchObject({ written: false, reason: 'no_match', unmatched: ['vitamin gummies'] });
  });

  it('answers for a whole window when no med is named', async () => {
    const r = await call(sam, 'check_med', {});
    expect(r.sc.status).toBe('logged_twice');
    speakable(r.text);
  });
});

describe('views and briefs', () => {
  it('today_view returns the grid and the view is an MCP App', async () => {
    const r = await call(sam, 'today_view', { date: '2026-10-20' });
    expect(r.sc.date).toBe('2026-10-20');
    const metMorning = r.sc.grid.find((g: any) => g.windowId === 'morning' && g.medId === 'metformin');
    expect(metMorning.status).toBe('logged_twice');
    const lev = r.sc.grid.find((g: any) => g.windowId === 'morning' && g.medId === 'levothyroxine');
    expect(lev.status).toBe('not_logged');
    expect(r.sc.grid.find((g: any) => g.windowId === 'evening').status).toBe('upcoming');
    speakable(r.text);
    const view = await sam.readResource({ uri: UI.today });
    expect(view.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('handoff_brief for Aylin lists what happened since her last shift', async () => {
    app.ctx.clock.set('2026-10-20T14:00:00');
    const r = await call(sam, 'handoff_brief', { memberId: 'aylin' });
    expect(r.sc.since).toBe('2026-10-19T20:00:00');
    expect(r.sc.facts.some((f: any) => /Sam/.test(f.text) && /metformin/.test(f.text))).toBe(true);
    expect(r.sc.facts.some((f: any) => /No entry for levothyroxine/.test(f.text))).toBe(true);
    for (const f of r.sc.facts) expect(f.eventId).toBeTruthy();
    speakable(r.text);
  });

  it('stores observations word for word', async () => {
    const text = 'Mom seemed dizzy after lunch.';
    const r = await call(sam, 'log_observation', { memberId: 'aylin', text });
    expect(r.sc.text).toBe(text);
    speakable(r.text);
  });

  it('visit_brief asks which notes to include and links nothing', async () => {
    const c = await connect(app, 'aylin', (p) => {
      const any = schemaOf(p).properties.observationIds.items.anyOf as { const: string }[];
      return { action: 'accept', content: { observationIds: any.map((o) => o.const) } };
    });
    const r = await call(c, 'visit_brief', { from: '2026-10-14', to: '2026-10-20' });
    expect(schemaOf(c.elicits[0]!).properties.observationIds.type).toBe('array');
    expect(r.sc.note).toBe(VISIT_NOTE);
    const rows = r.sc.rows as { kind: string; text: string; date: string }[];
    expect(rows.some((x) => x.kind === 'observation' && x.text.includes('Mom seemed dizzy after lunch.'))).toBe(true);
    expect(rows.some((x) => x.kind === 'plan_change' && x.date === '2026-10-16')).toBe(true);
    expect(rows.some((x) => x.date === '2026-10-15' && /metformin logged 2 times/.test(x.text))).toBe(true);
    expect(rows.some((x) => x.date === '2026-10-18' && /evening: no entry for metformin/.test(x.text))).toBe(true);
    expect(rows.some((x) => /because|caused|due to|likely|might be/i.test(x.text))).toBe(false);
    speakable(r.text);
    await c.close();
  });

  it('ledger_query finds both metformin entries today', async () => {
    const r = await call(sam, 'ledger_query', { medId: 'metformin', from: '2026-10-20', to: '2026-10-20' });
    expect(r.sc.events).toHaveLength(2);
    expect(r.sc.counts.total).toBe(2);
    speakable(r.text);
  });
});

describe('corrections', () => {
  it('soft deletes after confirmation and keeps the audit trail', async () => {
    await priya.subscribeResource({ uri: RESOURCE.ledgerToday });
    const q = await call(priya, 'ledger_query', { medId: 'metformin', from: '2026-10-20', to: '2026-10-20' });
    const second = q.sc.events.find((e: any) => e.memberId === 'priya');
    priya.policy = accept;
    const t0 = Date.now();
    const r = await call(priya, 'correct_entry', { eventId: second.eventId, reason: 'Logged twice by mistake' });
    expect(r.sc.corrected).toBe(true);
    speakable(r.text);
    expect(await waitFor(() => priya.updates.some((u) => u.uri === RESOURCE.ledgerToday && u.t >= t0))).toBe(true);
    const c = await call(priya, 'check_med', { medId: 'metformin', window: 'morning' });
    expect(c.sc.status).toBe('given');
    const audit = await call(priya, 'ledger_query', { kind: 'correction', from: '2026-10-20', to: '2026-10-20' });
    expect(audit.sc.events.map((e: any) => e.eventId)).toEqual([second.eventId]);
    expect(audit.sc.corrections[0].reason).toBe('Logged twice by mistake');
  });

  it('changes nothing when the user declines', async () => {
    priya.policy = decline;
    const q = await call(priya, 'ledger_query', { medId: 'amlodipine', from: '2026-10-20', to: '2026-10-20' });
    const r = await call(priya, 'correct_entry', { eventId: q.sc.events[0].eventId, reason: 'test' });
    expect(r.sc.corrected).toBe(false);
  });
});

describe('who_is_here', () => {
  it('confirms the speaker softly', async () => {
    const c = await connect(app, 'x', pick('memberId', 'aylin'));
    const r = await call(c, 'who_is_here', {});
    expect(r.sc).toMatchObject({ memberId: 'aylin', name: 'Aylin', note: 'Soft confirmation, not authentication.' });
    await c.close();
  });
});

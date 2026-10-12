// One low-level MCP Server per session. Tools and resources read the shared store and clock;
// writes fan out resources/updated through the hub to every subscribed session.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError,
  ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
  type CallToolResult, type ElicitRequestFormParams, type ElicitResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ANNOTATIONS, FIXED, IDENTITY_NOTE, Input, Output, RESOURCE, SERVER_NAME, TOOL, TOOL_NAMES, TOOL_VIEW, VISIT_NOTE,
  addDays, at, dateOf, formatClock, jsonSchema, lastShiftEnd, onShift,
  type Fixture, type SimClock, type ToolName,
} from '@baton/contract';
import type { Store, StoredEvent } from './store.ts';
import type { Hub } from './hub.ts';
import { VIEWS, viewHtml } from './views.ts';
import {
  activePlan, dosesIn, eventFact, grid, handoffFacts, list, matchItem, medWord, memberById, memberName, planItem,
  statusOf, visitRows, whenPhrase, windowForDose, windowInQuestion, type Status,
} from './domain.ts';

export type Ctx = { fx: Fixture; store: Store; clock: SimClock; hub: Hub };
type Extra = { requestId: string | number };

const DESCRIPTIONS: Record<ToolName, { title: string; description: string }> = {
  [TOOL.whoIsHere]: {
    title: 'Who is here',
    description: 'Asks which caregiver is speaking before a write. This is a soft confirmation, not authentication.',
  },
  [TOOL.logCareEvent]: {
    title: 'Log care event',
    description:
      'Records that a caregiver gave items from the family plan. Items match a plan id, name or description. ' +
      'Asks the user when an item matches more than one plan entry, and asks before logging a dose already logged in the same window. ' +
      'heardText is the sentence as heard. requestId makes retries safe.',
  },
  [TOOL.checkMed]: {
    title: 'Check a medication',
    description: 'Says whether a plan item is logged in a window (the current window when none is given), by whom and when.',
  },
  [TOOL.todayView]: { title: "Today's chart", description: "Shows the day's chart: every plan item per window and its status." },
  [TOOL.handoffBrief]: {
    title: 'Since you left',
    description: "Lists what happened since the member's last shift ended: entries, notes and windows with no entry.",
  },
  [TOOL.ledgerQuery]: { title: 'Search the log', description: 'Finds log entries by date range, member, plan item or kind.' },
  [TOOL.logObservation]: {
    title: 'Log an observation',
    description: 'Saves what a caregiver noticed, word for word, on the timeline for the clinician. It is never interpreted.',
  },
  [TOOL.visitBrief]: {
    title: 'Visit timeline',
    description: 'Builds a dated timeline for the clinician visit: doses, plan changes and chosen notes. Dates only, no links between rows.',
  },
  [TOOL.correctEntry]: {
    title: 'Correct an entry',
    description: 'Marks a log entry as a mistake after the user confirms. The entry stays in the audit trail.',
  },
};

export function toolList(): Tool[] {
  return TOOL_NAMES.map((name) => {
    const t: Tool = {
      name,
      ...DESCRIPTIONS[name],
      inputSchema: jsonSchema(Input[name]) as Tool['inputSchema'],
      outputSchema: jsonSchema(Output[name]) as Tool['outputSchema'],
      annotations: { title: DESCRIPTIONS[name].title, ...ANNOTATIONS[name] },
    };
    const view = TOOL_VIEW[name];
    if (view) t._meta = { ui: { resourceUri: view } };
    return t;
  });
}

function result(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Elicitation when the client supports it; undefined when it does not. */
async function ask(server: Server, extra: Extra, params: ElicitRequestFormParams): Promise<ElicitResult | undefined> {
  if (!server.getClientCapabilities()?.elicitation?.form) return undefined;
  return server.elicitInput(params, { relatedRequestId: extra.requestId });
}

const titledOneOf = (opts: { const: string; title: string }[]) => opts;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- tools ----------
async function whoIsHere(ctx: Ctx, server: Server, args: { defaultMemberId?: string }, extra: Extra): Promise<CallToolResult> {
  const { fx, clock } = ctx;
  const fallback = memberById(fx, args.defaultMemberId ?? '') ?? onShift(fx.members, clock.now())[0] ?? fx.members[0]!;
  const answer = await ask(server, extra, {
    message: `Who is logging? ${IDENTITY_NOTE}`,
    requestedSchema: {
      type: 'object',
      properties: {
        memberId: {
          type: 'string',
          title: 'Who is here',
          oneOf: titledOneOf(fx.members.map((m) => ({ const: m.id, title: `${m.name} (${m.role})` }))),
          default: fallback.id,
        },
      },
      required: ['memberId'],
    },
  });
  const picked = answer?.action === 'accept' ? memberById(fx, String(answer.content?.memberId ?? '')) : undefined;
  const m = picked ?? fallback;
  return result(`Logging as ${m.name}.`, { memberId: m.id, name: m.name, note: IDENTITY_NOTE });
}

type LogArgs = { memberId: string; items: string[]; note?: string; heardText: string; requestId: string };

async function logCareEvent(ctx: Ctx, server: Server, args: LogArgs, extra: Extra): Promise<CallToolResult> {
  const { fx, store, clock, hub } = ctx;
  const seen = store.requestResult(args.requestId) as CallToolResult | undefined;
  if (seen) return seen;
  const member = memberById(fx, args.memberId);
  if (!member) return failure(`I don't know a caregiver called ${args.memberId}.`);

  const finish = (r: CallToolResult) => {
    store.saveRequest(args.requestId, r);
    return r;
  };
  const nothing = (reason: 'declined' | 'cancelled' | 'no_match', text: string, unmatched: string[] = []) =>
    finish(result(text, { written: false, events: [], reason, ...(unmatched.length ? { unmatched } : {}) }));

  const now = clock.now();
  const plan = activePlan(fx, dateOf(now));
  const meds: string[] = [];
  const unmatched: string[] = [];
  for (const item of args.items) {
    const matches = matchItem(plan, item);
    if (matches.length === 0) {
      unmatched.push(item);
      continue;
    }
    let medId = matches[0]!.id;
    if (matches.length > 1) {
      const answer = await ask(server, extra, {
        message: `Which one is "${item}"?`,
        requestedSchema: {
          type: 'object',
          properties: {
            medId: {
              type: 'string',
              title: 'Plan item',
              oneOf: titledOneOf(matches.map((p) => ({ const: p.id, title: `${p.name}, ${p.looks}` }))),
            },
          },
          required: ['medId'],
        },
      });
      const chosen = answer?.action === 'accept' ? String(answer.content?.medId ?? '') : '';
      if (!matches.some((p) => p.id === chosen)) {
        return nothing(answer?.action === 'decline' ? 'declined' : 'cancelled', 'Nothing was logged.');
      }
      medId = chosen;
    }
    if (!meds.includes(medId)) meds.push(medId);
  }
  if (meds.length === 0) return nothing('no_match', "That isn't in the plan, so nothing was logged.", unmatched);

  // Ask before logging a dose that already has an entry in the same window today.
  const today = store.events({ from: dateOf(now), to: addDays(dateOf(now), 1) });
  const planned: { medId: string; windowId?: string }[] = [];
  for (const medId of meds) {
    const w = windowForDose(fx, medId, now);
    const earlier = w ? dosesIn(today, dateOf(now), w.id, medId) : [];
    if (earlier[0]) {
      const first = earlier[0];
      const answer = await ask(server, extra, {
        message: FIXED.duplicate(memberName(fx, first.memberId), medWord(fx, medId), formatClock(first.at)),
        requestedSchema: { type: 'object', properties: {} },
      });
      if (answer?.action !== 'accept') {
        const who = `${memberName(fx, first.memberId)} logged ${medWord(fx, medId)} at ${formatClock(first.at)}`;
        return nothing(answer?.action === 'decline' ? 'declined' : 'cancelled', `${who}. Nothing new was logged.`);
      }
    }
    planned.push({ medId, ...(w ? { windowId: w.id } : {}) });
  }

  const notes = [args.note, unmatched.length ? `Not in the plan: ${unmatched.map((u) => `"${u}"`).join(', ')}` : undefined].filter(Boolean);
  const written = store.tx(() =>
    planned.map(({ medId, windowId }) => {
      const e: StoredEvent = {
        eventId: store.nextId('e', now, 'events'),
        at: now,
        memberId: member.id,
        medId,
        heardText: args.heardText,
        requestId: args.requestId,
        ...(windowId ? { windowId } : {}),
        ...(notes.length ? { note: notes.join('. ') } : {}),
      };
      store.insertEvent(e);
      return e;
    }),
  );
  const extraNote = unmatched.length ? ' I kept the rest as a note.' : '';
  const r = finish(
    result(`Logged ${list(written.map((e) => medWord(fx, e.medId)))} for ${member.name} at ${formatClock(now)}.${extraNote}`, {
      written: true,
      events: written.map((e) => ({ eventId: e.eventId, medId: e.medId, memberId: e.memberId, at: e.at })),
      ...(unmatched.length ? { unmatched } : {}),
    }),
  );
  await hub.notify(RESOURCE.ledgerToday, RESOURCE.windowsToday);
  return r;
}

function checkMed(ctx: Ctx, args: { medId?: string; window?: string }): CallToolResult {
  const { fx, store, clock } = ctx;
  const now = clock.now();
  const date = dateOf(now);
  const w = windowInQuestion(fx, now, args.window);
  if (!w) return failure(`There is no ${args.window} window in the plan.`);
  const events = store.events({ from: date, to: addDays(date, 1) });
  const inWindow = activePlan(fx, date).filter((p) => p.windows.includes(w.id));

  if (args.medId) {
    const p = activePlan(fx, date).find((x) => x.id === args.medId || matchItem([x], args.medId!).length);
    if (!p) return failure(`${cap(args.medId)} isn't in the plan.`);
    if (!inWindow.includes(p)) {
      return result(`${cap(p.generic)} isn't in the plan for the ${w.label} window.`, {
        status: 'not_logged', medId: p.id, window: w.id, eventIds: [], planned: false,
      });
    }
    const doses = dosesIn(events, date, w.id, p.id);
    const raw = statusOf(doses, w, now);
    const status: Exclude<Status, 'upcoming'> = raw === 'upcoming' ? 'not_logged' : raw;
    const by = [...new Set(doses.map((d) => memberName(fx, d.memberId)))].join(', ');
    const base = { status, medId: p.id, window: w.id, eventIds: doses.map((d) => d.eventId) };
    if (status === 'not_logged') {
      const text = raw === 'upcoming'
        ? `The ${w.label} window starts at ${formatClock(at(date, w.start))}. Nothing is logged for ${p.generic} yet.`
        : `No one has logged ${p.generic} in the ${w.label} window today.`;
      return result(text, base);
    }
    if (status === 'given') {
      return result(`${by} logged ${p.generic} at ${formatClock(doses[0]!.at)}, in the ${w.label} window.`, { ...base, by, at: doses[0]!.at });
    }
    const who = doses.map((d) => `${memberName(fx, d.memberId)} at ${formatClock(d.at)}`);
    return result(`${cap(p.generic)} was logged ${doses.length} times in the ${w.label} window: ${list(who)}.`, { ...base, by, at: doses[0]!.at });
  }

  const rows = inWindow.map((p) => ({ p, doses: dosesIn(events, date, w.id, p.id) }));
  const twice = rows.filter((r) => r.doses.length >= 2);
  const missing = rows.filter((r) => r.doses.length === 0);
  const eventIds = rows.flatMap((r) => r.doses.map((d) => d.eventId));
  if (twice.length) {
    return result(`${cap(list(twice.map((r) => r.p.generic)))} logged more than once in the ${w.label} window.`, {
      status: 'logged_twice', window: w.id, eventIds,
    });
  }
  if (missing.length) {
    const done = rows.filter((r) => r.doses.length).map((r) => r.p.generic);
    const text = done.length
      ? `Logged in the ${w.label} window: ${list(done)}. No entry yet for ${list(missing.map((r) => r.p.generic))}.`
      : `Nothing is logged in the ${w.label} window yet.`;
    return result(text, { status: 'not_logged', window: w.id, eventIds });
  }
  return result(`Everything in the ${w.label} window is logged: ${list(rows.map((r) => r.p.generic))}.`, {
    status: 'given', window: w.id, eventIds,
  });
}

function todayView(ctx: Ctx, args: { date?: string }): CallToolResult {
  const { fx, store, clock } = ctx;
  const now = clock.now();
  const date = args.date ?? dateOf(now);
  const rows = grid(fx, store.events({ from: date, to: addDays(date, 1) }), date, now);
  const due = rows.filter((r) => r.status !== 'upcoming');
  const logged = due.filter((r) => r.status !== 'not_logged');
  const day = date === dateOf(now) ? 'today' : date;
  const text = due.length
    ? `The chart for ${day} is on screen. ${logged.length} of ${due.length} doses due so far have an entry.`
    : `The chart for ${day} is on screen. Nothing is due yet.`;
  return result(text, {
    date,
    now,
    grid: rows.map(({ windowId, medId, status, by, at: when, eventIds }) => ({
      windowId, medId, status, eventIds, ...(by ? { by } : {}), ...(when ? { at: when } : {}),
      // Display fields for the view, so it never needs the plan.
      medName: planItem(fx, medId)?.name ?? medId,
      looks: planItem(fx, medId)?.looks ?? '',
      windowLabel: fx.windows.find((w) => w.id === windowId)?.label ?? windowId,
    })),
  });
}

function handoffBrief(ctx: Ctx, args: { memberId: string }): CallToolResult {
  const { fx, store, clock } = ctx;
  const member = memberById(fx, args.memberId);
  if (!member) return failure(`I don't know a caregiver called ${args.memberId}.`);
  const now = clock.now();
  const since = lastShiftEnd(member, now);
  const facts = handoffFacts(fx, store.events({ from: dateOf(since) }), store.observations({ from: dateOf(since) }), since, now);
  const n = facts.length;
  let text = `Nothing new since you left ${whenPhrase(since, now)}.`;
  if (n) {
    const latest = [...facts].reverse().find((f) => !f.eventId.startsWith('none-') && !f.text.includes('noted'));
    const count = n === 1 ? 'there is 1 new item' : `there are ${n} new items`;
    text = `Since you left ${whenPhrase(since, now)}, ${count}.${latest ? ` The latest: ${latest.text}` : ''}`;
  }
  return result(text, { memberId: member.id, since, facts: facts.map(({ eventId, text: t }) => ({ eventId, text: t })) });
}

function ledgerQuery(
  ctx: Ctx,
  args: { from?: string; to?: string; memberId?: string; medId?: string; kind?: 'dose' | 'observation' | 'correction' },
): CallToolResult {
  const { fx, store, clock } = ctx;
  const to = args.to ?? dateOf(clock.now());
  const from = args.from ?? addDays(to, -6);
  const range = { from, to: addDays(to, 1) };
  const kind = args.kind ?? 'dose';
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  if (kind === 'observation') {
    const obs = store.observations(range).filter((o) => !args.memberId || o.memberId === args.memberId);
    obs.forEach((o) => bump(`member:${o.memberId}`));
    counts.total = obs.length;
    return result(`I found ${obs.length} ${obs.length === 1 ? 'note' : 'notes'} from ${from} to ${to}.`, { events: [], observations: obs, counts });
  }
  let events = store.events({ ...range, includeDeleted: kind === 'correction' });
  if (kind === 'correction') events = events.filter((e) => e.deleted);
  events = events.filter((e) => (!args.memberId || e.memberId === args.memberId) && (!args.medId || e.medId === args.medId));
  for (const e of events) {
    bump(`member:${e.memberId}`);
    bump(`med:${e.medId}`);
  }
  counts.total = events.length;
  const clean = events.map(({ requestId: _r, ...e }) => e);
  const what = args.medId ? ` for ${medWord(fx, args.medId)}` : '';
  const noun = kind === 'correction' ? 'corrected' : '';
  const text = `I found ${events.length} ${noun ? `${noun} ` : ''}${events.length === 1 ? 'entry' : 'entries'}${what} from ${from} to ${to}.`;
  return result(text, {
    events: clean,
    counts,
    ...(kind === 'correction' ? { corrections: store.corrections(range) } : {}),
  });
}

async function logObservation(ctx: Ctx, args: { memberId: string; text: string }): Promise<CallToolResult> {
  const { fx, store, clock, hub } = ctx;
  const member = memberById(fx, args.memberId);
  if (!member) return failure(`I don't know a caregiver called ${args.memberId}.`);
  const now = clock.now();
  const o = { observationId: store.nextId('o', now, 'observations'), at: now, memberId: member.id, text: args.text };
  store.insertObservation(o);
  await hub.notify(RESOURCE.ledgerToday);
  return result(`I've added it to the timeline for ${fx.clinician.name}.`, { observationId: o.observationId, at: o.at, text: o.text });
}

async function visitBrief(
  ctx: Ctx, server: Server, args: { from: string; to: string; observationIds?: string[] }, extra: Extra,
): Promise<CallToolResult> {
  const { fx, store, clock } = ctx;
  if (args.from > args.to) return failure('The start date is after the end date.');
  const now = clock.now();
  const range = { from: args.from, to: addDays(args.to, 1) };
  const observations = store.observations(range);
  let chosen = args.observationIds;
  if (!chosen && observations.length) {
    const answer = await ask(server, extra, {
      message: `Which notes should go on the timeline for ${fx.clinician.name}?`,
      requestedSchema: {
        type: 'object',
        properties: {
          observationIds: {
            type: 'array',
            title: 'Notes',
            items: {
              anyOf: observations.map((o) => ({
                const: o.observationId,
                title: `${dateOf(o.at)} ${memberName(fx, o.memberId)}: ${o.text}`,
              })),
            },
          },
        },
      },
    });
    if (answer === undefined) chosen = observations.map((o) => o.observationId);
    else if (answer.action === 'accept') {
      const ids = answer.content?.observationIds;
      chosen = Array.isArray(ids) ? ids.map(String) : [];
    } else chosen = [];
  }
  const rows = visitRows(fx, store.events(range), observations, args.from, args.to, now, chosen ?? []);
  return result(
    `The timeline for ${fx.clinician.name} from ${args.from} to ${args.to} has ${rows.length} rows. It lists dates only.`,
    { from: args.from, to: args.to, clinician: fx.clinician.name, rows, note: VISIT_NOTE },
  );
}

async function correctEntry(ctx: Ctx, server: Server, args: { eventId: string; reason: string }, extra: Extra): Promise<CallToolResult> {
  const { fx, store, clock, hub } = ctx;
  const e = store.event(args.eventId);
  if (!e) return failure("I can't find that entry.");
  if (e.deleted) return result('That entry is already marked as a mistake.', { corrected: false, eventId: e.eventId, reason: 'already corrected' });
  const answer = await ask(server, extra, {
    message: `Mark "${eventFact(fx, e)}" as a mistake? It stays in the audit trail.`,
    requestedSchema: { type: 'object', properties: {} },
  });
  if (answer?.action !== 'accept') return result('Nothing changed.', { corrected: false, eventId: e.eventId });
  store.softDelete(e.eventId, clock.now(), args.reason);
  await hub.notify(RESOURCE.ledgerToday, RESOURCE.windowsToday);
  return result('Done. That entry is marked as a mistake and stays in the audit trail.', {
    corrected: true, eventId: e.eventId, reason: args.reason,
  });
}

async function callTool(ctx: Ctx, server: Server, name: string, raw: unknown, extra: Extra): Promise<CallToolResult> {
  if (!(TOOL_NAMES as string[]).includes(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  const parsed = Input[name as ToolName].safeParse(raw ?? {});
  if (!parsed.success) return failure(`I couldn't read that request: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
  const a = parsed.data as never;
  switch (name as ToolName) {
    case TOOL.whoIsHere: return whoIsHere(ctx, server, a, extra);
    case TOOL.logCareEvent: return logCareEvent(ctx, server, a, extra);
    case TOOL.checkMed: return checkMed(ctx, a);
    case TOOL.todayView: return todayView(ctx, a);
    case TOOL.handoffBrief: return handoffBrief(ctx, a);
    case TOOL.ledgerQuery: return ledgerQuery(ctx, a);
    case TOOL.logObservation: return logObservation(ctx, a);
    case TOOL.visitBrief: return visitBrief(ctx, server, a, extra);
    case TOOL.correctEntry: return correctEntry(ctx, server, a, extra);
  }
}

// ---------- resources ----------
const BATON_RESOURCES = [
  { uri: RESOURCE.ledgerToday, name: 'ledger-today', title: "Today's log", mimeType: 'application/json' },
  { uri: RESOURCE.windowsToday, name: 'windows-today', title: "Today's dose windows", mimeType: 'application/json' },
  { uri: RESOURCE.shifts, name: 'shifts', title: 'Shifts', mimeType: 'application/json' },
  { uri: RESOURCE.plan, name: 'plan', title: 'Family plan (read-only)', mimeType: 'application/json' },
];

export function readResource(ctx: Ctx, uri: string): unknown {
  const { fx, store, clock } = ctx;
  const now = clock.now();
  const date = dateOf(now);
  const day = { from: date, to: addDays(date, 1) };
  switch (uri) {
    case RESOURCE.ledgerToday:
      return { date, now, events: store.events(day).map(({ requestId: _r, ...e }) => e), observations: store.observations(day) };
    case RESOURCE.windowsToday:
      return { date, now, windows: fx.windows, grid: grid(fx, store.events(day), date, now) };
    case RESOURCE.shifts:
      return { now, members: fx.members, onShift: onShift(fx.members, now).map((m) => m.id) };
    case RESOURCE.plan:
      return {
        label: fx.label, household: fx.household, clinician: fx.clinician, windows: fx.windows,
        plan: activePlan(fx, date), planChanges: fx.planChanges,
      };
    default:
      return undefined;
  }
}

export function makeServer(ctx: Ctx, subs: Set<string>): Server {
  const server = new Server(
    { name: SERVER_NAME, version: '0.1.0', title: 'Baton' },
    {
      capabilities: { tools: {}, resources: { subscribe: true, listChanged: false } },
      instructions:
        'Baton is a shared care log for a family. Log only what the caregiver says happened. ' +
        'Never suggest, change or approve a dose and never interpret symptoms. ' + FIXED.emergency,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
    callTool(ctx, server, req.params.name, req.params.arguments, { requestId: extra.requestId }),
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...BATON_RESOURCES, ...VIEWS.map(({ uri, name, title, mimeType }) => ({ uri, name, title, mimeType }))],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const html = viewHtml(uri);
    if (html) return { contents: [{ uri, mimeType: VIEWS.find((v) => v.uri === uri)!.mimeType, text: html }] };
    const data = readResource(ctx, uri);
    if (data === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    if (!BATON_RESOURCES.some((r) => r.uri === req.params.uri)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${req.params.uri}`);
    }
    subs.add(req.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subs.delete(req.params.uri);
    return {};
  });
  return server;
}

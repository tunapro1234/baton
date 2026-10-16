// One low-level MCP Server per session. Tools and resources read the shared store and clock;
// writes fan out resources/updated through the hub to every subscribed session.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError,
  ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
  type CallToolResult, type ElicitRequestFormParams, type ElicitResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ANNOTATIONS, FIXED, IDENTITY_NOTE, Input, NOT_LOGGED_NOTE, Output, RESOURCE, SERVER_NAME, SPOKEN, TOOL, TOOL_NAMES, TOOL_VIEW, VISIT_NOTE,
  addDays, at, clientHasScreen, currentWindow, dateOf, windowState, formatClock, jsonSchema, lastShiftEnd, onShift,
  type DoseWindow, type Fixture, type PlanItem, type SimClock, type ToolName,
} from '@baton/contract';
import type { Store, StoredEvent } from './store.ts';
import type { Hub } from './hub.ts';
import { VIEWS, viewHtml } from './views.ts';
import {
  activePlan, dosesIn, eventFact, grid, handoffFacts, list, matchItem, medWord, memberById, memberName, planItem,
  statusOf, visitRows, whenPhrase, windowForDose, windowInQuestion, type Status,
} from './domain.ts';

export type Ctx = { fx: Fixture; store: Store; clock: SimClock; hub: Hub };
/**
 * Per call: the JSON-RPC id the elicitations relate to, and whether the client has a screen (it declared the
 * MCP Apps UI extension). A client without one gets the SPOKEN sentences from the contract.
 */
type Extra = { requestId: string | number; screen: boolean };

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
    title: 'Handoff brief',
    description: "Lists what happened since the member's last shift ended (the last 24 hours for a member without a shift): entries, notes and windows with no entry.",
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

/** Single-select "Which one is ...?" over the plan items a description matches (log_care_event and check_med). */
function whichOne(item: string, matches: PlanItem[]): ElicitRequestFormParams {
  return {
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
  };
}

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
  const nothing = (reason: 'declined' | 'cancelled' | 'no_match' | 'already_logged', text: string, unmatched: string[] = []) =>
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
      const options = matches.map((p) => p.id);
      // A choice read out loud would name every medicine, so a device without a screen does not ask.
      if (!extra.screen) {
        return finish(result(SPOKEN.ambiguous(matches.length), { written: false, events: [], reason: 'ambiguous', options }));
      }
      const answer = await ask(server, extra, whichOne(item, matches));
      if (answer === undefined) {
        // The client cannot be asked: say what the choices are and write nothing.
        const text = `"${item}" could be ${list(matches.map((p) => p.generic), 'or')}, so nothing was logged. Say which one.`;
        return finish(result(text, { written: false, events: [], reason: 'ambiguous', options }));
      }
      const chosen = answer.action === 'accept' ? String(answer.content?.medId ?? '') : '';
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
  /** Items left out because they already had an entry and no one said yes to logging them again. */
  const kept: { medId: string; by: string; clock: string; reason: 'declined' | 'already_logged' }[] = [];
  for (const medId of meds) {
    let w = windowForDose(fx, medId, now);
    // Said between two windows of the item (one has ended, one has not started): which dose this is is a fact
    // only the speaker knows, so ask it (never judge the timing). The second-dose check below then runs on that
    // window. Before the first window it is filed in the first one; after the last, in the last one.
    const own = fx.windows.filter((x) => planItem(fx, medId)?.windows.includes(x.id)).sort((a, b) => a.start.localeCompare(b.start));
    const states = own.map((x) => windowState(x, now));
    if (!currentWindow(own, now) && own.length) {
      if (!states.includes('closed')) w = own[0];
      else if (!states.includes('upcoming')) w = own[own.length - 1];
    }
    if (own.length > 1 && states.includes('closed') && states.includes('upcoming')) {
      const asked = await askWhichDose(ctx, server, extra, medId, own, today);
      if (asked.kind === 'unasked') return finish(asked.result);
      if (asked.kind === 'none') return nothing(asked.reason, 'Nothing was logged.');
      w = asked.window;
    }
    const earlier = w ? dosesIn(today, dateOf(now), w.id, medId) : [];
    if (earlier[0]) {
      const first = earlier[0];
      const by = memberName(fx, first.memberId);
      const clock = formatClock(first.at);
      const answer = await ask(server, extra, {
        message: extra.screen ? FIXED.duplicate(by, medWord(fx, medId), clock) : SPOKEN.duplicate(by, clock),
        requestedSchema: { type: 'object', properties: {} },
      });
      if (answer?.action === 'cancel') return nothing('cancelled', 'Nothing was logged.');
      if (answer?.action !== 'accept') {
        // Declined, or no elicitation on this client: this item is not written twice without a yes. The no
        // applies to this item only; the other items of the call are still logged.
        kept.push({ medId, by, clock, reason: answer === undefined ? 'already_logged' : 'declined' });
        continue;
      }
    }
    planned.push({ medId, ...(w ? { windowId: w.id } : {}) });
  }
  if (planned.length === 0 && kept[0]) {
    // Nothing new at all: say who and when (for each item that already had an entry).
    const k = kept[0];
    const reason = kept.some((x) => x.reason === 'declined') ? 'declined' : 'already_logged';
    let text: string;
    if (kept.length === 1) {
      text = extra.screen ? `${k.by} logged ${medWord(fx, k.medId)} at ${k.clock}. Nothing new was logged.` : SPOKEN.duplicateKept(k.by, k.clock);
    } else {
      text = extra.screen
        ? `${cap(list(kept.map((x) => `${x.by} logged ${medWord(fx, x.medId)} at ${x.clock}`)))}. Nothing new was logged.`
        : SPOKEN.allKept(kept.length);
    }
    return finish(result(text, { written: false, events: [], reason, notLoggedAgain: kept.map((x) => x.medId) }));
  }

  const notes = [args.note, unmatched.length ? `Not in the plan: ${unmatched.map((u) => `"${u}"`).join(', ')}` : undefined].filter(Boolean);
  // The questions above can stay open for a while, and another session may log the same item meanwhile.
  // Re-read today's entries inside the write: an item that now has an entry someone wrote after `today` was
  // read is not written, since no one was asked about that entry.
  const before = new Set(today.map((e) => e.eventId));
  const meanwhile: { medId: string; by: string; clock: string }[] = [];
  const written = store.tx(() => {
    const fresh = store.events({ from: dateOf(now), to: addDays(dateOf(now), 1) }).filter((e) => !before.has(e.eventId));
    return planned.flatMap(({ medId, windowId }) => {
      const other = windowId ? dosesIn(fresh, dateOf(now), windowId, medId)[0] : undefined;
      if (other) {
        meanwhile.push({ medId, by: memberName(fx, other.memberId), clock: formatClock(other.at) });
        return [];
      }
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
      return [e];
    });
  });
  const meanwhileText = !meanwhile.length ? ''
    : extra.screen
      ? `${cap(list(meanwhile.map((x) => `${x.by} logged ${medWord(fx, x.medId)} at ${x.clock}`)))} while you were answering. Nothing new was logged for ${meanwhile.length === 1 ? 'it' : 'them'}.`
      : SPOKEN.loggedMeanwhile(meanwhile);
  const meanwhileIds = meanwhile.length ? { loggedMeanwhile: meanwhile.map((x) => x.medId) } : {};
  const notAgainIds = kept.length ? { notLoggedAgain: kept.map((x) => x.medId) } : {};
  if (written.length === 0) {
    const again = !kept.length ? ''
      : extra.screen ? ` ${cap(list(kept.map((x) => medWord(fx, x.medId))))} ${kept.length === 1 ? 'was' : 'were'} not logged again.`
      : ` ${SPOKEN.notAgain(kept.length)}.`;
    return finish(result(`${meanwhileText}${again}`, {
      written: false, events: [], reason: 'logged_meanwhile',
      ...(unmatched.length ? { unmatched } : {}), ...notAgainIds, ...meanwhileIds,
    }));
  }
  const said = extra.screen
    ? `Logged ${list(written.map((e) => medWord(fx, e.medId)))} for ${member.name} at ${formatClock(now)}.`
    : SPOKEN.logged(written.length, member.name, formatClock(now));
  // Items that already had an entry and were not logged again are named next to what was logged.
  const again = !kept.length ? ''
    : extra.screen ? ` ${cap(list(kept.map((x) => medWord(fx, x.medId))))} ${kept.length === 1 ? 'was' : 'were'} not logged again`
    : ` ${SPOKEN.notAgain(kept.length)}`;
  const extraNote = unmatched.length ? (again ? `${again}, and I kept the rest as a note.` : ' I kept the rest as a note.') : again ? `${again}.` : '';
  const r = finish(
    result(`${said}${extraNote}${meanwhileText ? ` ${meanwhileText}` : ''}`, {
      written: true,
      events: written.map((e) => ({ eventId: e.eventId, medId: e.medId, memberId: e.memberId, at: e.at })),
      ...(unmatched.length ? { unmatched } : {}),
      ...notAgainIds,
      ...meanwhileIds,
    }),
  );
  await hub.notify(RESOURCE.ledgerToday, RESOURCE.windowsToday);
  return r;
}

/** check_med for a description that fits several plan lines and was not narrowed down: one answer per line. */
function checkEach(ctx: Ctx, phrase: string, matches: PlanItem[], w: DoseWindow, screen: boolean): CallToolResult {
  const { fx, store, clock } = ctx;
  const now = clock.now();
  const date = dateOf(now);
  const events = store.events({ from: date, to: addDays(date, 1) });
  const each = matches.map((p) => {
    const planned = p.windows.includes(w.id);
    const doses = planned ? dosesIn(events, date, w.id, p.id) : [];
    const raw: Status = planned ? statusOf(doses, w, now) : 'not_logged';
    const status: Exclude<Status, 'upcoming'> = raw === 'upcoming' ? 'not_logged' : raw;
    const by = [...new Set(doses.map((d) => memberName(fx, d.memberId)))].join(', ');
    const fact = !planned ? `${p.generic} isn't in the plan for it`
      : raw === 'upcoming' ? `nothing is logged for ${p.generic} yet`
      : raw === 'not_logged' ? `no one has logged ${p.generic}`
      : raw === 'given' ? `${by} logged ${p.generic} at ${formatClock(doses[0]!.at)}`
      : `${p.generic} was logged ${doses.length} times`;
    return { medId: p.id, status, ...(by ? { by, at: doses[0]!.at } : {}), eventIds: doses.map((d) => d.eventId), fact };
  });
  const status: Exclude<Status, 'upcoming'> = each.some((e) => e.status === 'logged_twice') ? 'logged_twice'
    : each.every((e) => e.status === 'given') ? 'given' : 'not_logged';
  const logged = each.filter((e) => e.eventIds.length).length;
  const text = screen
    ? `"${phrase}" could be ${list(matches.map((p) => p.generic), 'or')}. In the ${w.label} window, ${list(each.map((e) => e.fact))}.`
    : SPOKEN.checkEach(matches.length, logged, w.label);
  return result(text, {
    status,
    window: w.id,
    eventIds: each.flatMap((e) => e.eventIds),
    options: matches.map((p) => p.id),
    matches: each.map(({ fact: _f, ...e }) => e),
  });
}

type WhichDose =
  | { kind: 'window'; window: DoseWindow }
  | { kind: 'none'; reason: 'declined' | 'cancelled' }
  | { kind: 'unasked'; result: CallToolResult };

/** "Is this the morning or the evening metformin?" One option per window of the item, by its label and hours. */
async function askWhichDose(ctx: Ctx, server: Server, extra: Extra, medId: string, own: DoseWindow[], today: StoredEvent[]): Promise<WhichDose> {
  const { fx, clock } = ctx;
  const now = clock.now();
  const date = dateOf(now);
  const labels = list(own.map((w) => `the ${w.label}`), 'or').replace(/^the /, '');
  const answer = await ask(server, extra, {
    message: extra.screen ? `Is this the ${labels} ${medWord(fx, medId)}?` : SPOKEN.whichDose(labels),
    requestedSchema: {
      type: 'object',
      properties: {
        windowId: {
          type: 'string',
          title: 'Which dose',
          oneOf: titledOneOf(own.map((w) => ({
            const: w.id,
            title: `${cap(w.label)}, ${formatClock(at(date, w.start))} to ${formatClock(at(date, w.end))}`,
          }))),
        },
      },
      required: ['windowId'],
    },
  });
  if (answer === undefined) {
    // The client cannot be asked: say which windows exist and what each already holds, and write nothing.
    const perWindow = list(own.map((w) => {
      const doses = dosesIn(today, date, w.id, medId);
      const held = doses.length ? list(doses.map((d) => `${memberName(fx, d.memberId)} at ${formatClock(d.at)}`)) : 'no entry';
      return `${w.label} (${held})`;
    }));
    const count = ['no', 'one', 'two', 'three', 'four'][own.length] ?? String(own.length);
    const text = extra.screen
      ? `Nothing was logged: ${medWord(fx, medId)} has ${count} windows today, ${perWindow}. Say which dose this is.`
      : SPOKEN.whichDoseUnasked(count, perWindow);
    return { kind: 'unasked', result: result(text, { written: false, events: [], reason: 'which_dose', options: own.map((w) => w.id) }) };
  }
  const chosen = answer.action === 'accept' ? own.find((w) => w.id === String(answer.content?.windowId ?? '')) : undefined;
  if (chosen) return { kind: 'window', window: chosen };
  return { kind: 'none', reason: answer.action === 'decline' ? 'declined' : 'cancelled' };
}

async function checkMed(ctx: Ctx, server: Server, args: { medId?: string; window?: string }, extra: Extra): Promise<CallToolResult> {
  const { fx, store, clock } = ctx;
  const screen = extra.screen;
  const now = clock.now();
  const date = dateOf(now);
  const w = windowInQuestion(fx, now, args.window);
  if (!w) return failure(`There is no ${args.window} window in the plan.`);
  const events = store.events({ from: date, to: addDays(date, 1) });
  const inWindow = activePlan(fx, date).filter((p) => p.windows.includes(w.id));

  if (args.medId) {
    const matches = matchItem(activePlan(fx, date), args.medId);
    let p = matches[0];
    if (matches.length > 1) {
      // "The small white one" fits more than one plan line: ask which (a screen client only, since the choices
      // name medicines), else answer for every line it fits rather than for whichever comes first.
      const answer = screen ? await ask(server, extra, whichOne(args.medId, matches)) : undefined;
      const chosen = answer?.action === 'accept' ? matches.find((x) => x.id === String(answer.content?.medId ?? '')) : undefined;
      if (!chosen) return checkEach(ctx, args.medId, matches, w, screen);
      p = chosen;
    }
    if (!p) return failure(screen ? `${cap(args.medId)} isn't in the plan.` : SPOKEN.notInPlan);
    if (!inWindow.includes(p)) {
      return result(screen ? `${cap(p.generic)} isn't in the plan for the ${w.label} window.` : SPOKEN.notInWindow(w.label), {
        status: 'not_logged', medId: p.id, window: w.id, eventIds: [], planned: false,
      });
    }
    const doses = dosesIn(events, date, w.id, p.id);
    const raw = statusOf(doses, w, now);
    const status: Exclude<Status, 'upcoming'> = raw === 'upcoming' ? 'not_logged' : raw;
    const by = [...new Set(doses.map((d) => memberName(fx, d.memberId)))].join(', ');
    const base = { status, medId: p.id, window: w.id, eventIds: doses.map((d) => d.eventId) };
    if (status === 'not_logged') {
      const starts = formatClock(at(date, w.start));
      const text = raw === 'upcoming'
        ? (screen ? `The ${w.label} window starts at ${starts}. Nothing is logged for ${p.generic} yet.` : SPOKEN.upcoming(w.label, starts))
        : (screen ? `No one has logged ${p.generic} in the ${w.label} window today. ${NOT_LOGGED_NOTE}` : SPOKEN.notLogged(w.label));
      return result(text, base);
    }
    const first = formatClock(doses[0]!.at);
    if (status === 'given') {
      const text = screen ? `${by} logged ${p.generic} at ${first}, in the ${w.label} window.` : SPOKEN.given(by, first, w.label);
      return result(text, { ...base, by, at: doses[0]!.at });
    }
    const who = list(doses.map((d) => `${memberName(fx, d.memberId)} at ${formatClock(d.at)}`));
    const text = screen
      ? `${cap(p.generic)} was logged ${doses.length} times in the ${w.label} window: ${who}.`
      : SPOKEN.loggedTimes(doses.length, w.label, who);
    return result(text, { ...base, by, at: doses[0]!.at });
  }

  const rows = inWindow.map((p) => ({ p, doses: dosesIn(events, date, w.id, p.id) }));
  const twice = rows.filter((r) => r.doses.length >= 2);
  const missing = rows.filter((r) => r.doses.length === 0);
  const eventIds = rows.flatMap((r) => r.doses.map((d) => d.eventId));
  if (twice.length) {
    const text = screen
      ? `${cap(list(twice.map((r) => r.p.generic)))} logged more than once in the ${w.label} window.`
      : SPOKEN.windowTwice(twice.length, w.label);
    return result(text, { status: 'logged_twice', window: w.id, eventIds });
  }
  if (missing.length) {
    const done = rows.filter((r) => r.doses.length).map((r) => r.p.generic);
    let text: string;
    if (!done.length) text = screen ? `Nothing is logged in the ${w.label} window yet. ${NOT_LOGGED_NOTE}` : SPOKEN.windowEmpty(w.label);
    else if (screen) text = `Logged in the ${w.label} window: ${list(done)}. No entry yet for ${list(missing.map((r) => r.p.generic))}.`;
    else text = SPOKEN.windowPartial(done.length, rows.length, w.label);
    return result(text, { status: 'not_logged', window: w.id, eventIds });
  }
  const text = screen
    ? `Everything in the ${w.label} window is logged: ${list(rows.map((r) => r.p.generic))}.`
    : SPOKEN.windowDone(rows.length, w.label);
  return result(text, { status: 'given', window: w.id, eventIds });
}

function todayView(ctx: Ctx, args: { date?: string }, screen: boolean): CallToolResult {
  const { fx, store, clock } = ctx;
  const now = clock.now();
  const date = args.date ?? dateOf(now);
  const rows = grid(fx, store.events({ from: date, to: addDays(date, 1) }), date, now);
  const due = rows.filter((r) => r.status !== 'upcoming');
  const logged = due.filter((r) => r.status !== 'not_logged');
  const day = date === dateOf(now) ? 'today' : date;
  const text = !screen
    ? SPOKEN.today(day, logged.length, due.length)
    : due.length
      ? `The chart for ${day} is on screen. ${logged.length} of ${due.length} doses due so far have an entry.`
      : `The chart for ${day} is on screen. Nothing is due yet.`;
  return result(text, {
    date,
    now,
    ...(fx.consent ? { consent: fx.consent } : {}),
    grid: rows.map(({ windowId, medId, status, by, at: when, eventIds }) => ({
      windowId, medId, status, eventIds, ...(by ? { by } : {}), ...(when ? { at: when } : {}),
      // Display fields for the view, so it never needs the plan.
      medName: planItem(fx, medId)?.name ?? medId,
      looks: planItem(fx, medId)?.looks ?? '',
      windowLabel: fx.windows.find((w) => w.id === windowId)?.label ?? windowId,
    })),
  });
}

function handoffBrief(ctx: Ctx, args: { memberId: string }, screen: boolean): CallToolResult {
  const { fx, store, clock } = ctx;
  const member = memberById(fx, args.memberId);
  if (!member) return failure(`I don't know a caregiver called ${args.memberId}.`);
  const now = clock.now();
  const since = lastShiftEnd(member, now);
  const facts = handoffFacts(fx, store.events({ from: dateOf(since) }), store.observations({ from: dateOf(since) }), since, now);
  const n = facts.length;
  // A member without a shift never "left": lastShiftEnd falls back to the last 24 hours, and the words say so.
  const lastDay = !member.shift;
  const when = whenPhrase(since, now);
  const count = n === 1 ? 'there is 1 new item' : `there are ${n} new items`;
  let text = lastDay ? 'Nothing new in the last 24 hours.' : `Nothing new since you left ${when}.`;
  if (!screen) text = lastDay ? SPOKEN.briefLastDay(n) : SPOKEN.brief(when, n);
  else if (n) {
    const latest = [...facts].reverse().find((f) => !f.eventId.startsWith('none-') && !f.text.includes('noted'));
    text = `${lastDay ? 'In the last 24 hours' : `Since you left ${when}`}, ${count}.${latest ? ` The latest: ${latest.text}` : ''}`;
  }
  return result(text, {
    memberId: member.id, since, basis: lastDay ? 'last_24_hours' : 'shift',
    facts: facts.map(({ eventId, text: t }) => ({ eventId, text: t })),
  });
}

function ledgerQuery(
  ctx: Ctx,
  args: { from?: string; to?: string; memberId?: string; medId?: string; kind?: 'dose' | 'observation' | 'correction' },
  screen: boolean,
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
  const text = screen
    ? `I found ${events.length} ${noun ? `${noun} ` : ''}${events.length === 1 ? 'entry' : 'entries'}${what} from ${from} to ${to}.`
    : SPOKEN.found(events.length, from, to, kind === 'correction', Boolean(args.medId));
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
                // Read out loud, a note's own words could name a symptom; a device without a screen lists who and when.
                title: extra.screen
                  ? `${dateOf(o.at)} ${memberName(fx, o.memberId)}: ${o.text}`
                  : SPOKEN.noteChoice(dateOf(o.at), memberName(fx, o.memberId)),
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
    extra.screen
      ? `The timeline for ${fx.clinician.name} from ${args.from} to ${args.to} has ${rows.length} rows. It lists dates only.`
      : SPOKEN.visit(fx.clinician.name, args.from, args.to, rows.length),
    { from: args.from, to: args.to, clinician: fx.clinician.name, rows, note: VISIT_NOTE },
  );
}

async function correctEntry(ctx: Ctx, server: Server, args: { eventId: string; reason: string }, extra: Extra): Promise<CallToolResult> {
  const { fx, store, clock, hub } = ctx;
  const e = store.event(args.eventId);
  if (!e) return failure("I can't find that entry.");
  if (e.deleted) return result('That entry is already marked as a mistake.', { corrected: false, eventId: e.eventId, reason: 'already corrected' });
  const answer = await ask(server, extra, {
    message: extra.screen
      ? `Mark "${eventFact(fx, e)}" as a mistake? It stays in the audit trail.`
      : SPOKEN.correct(memberName(fx, e.memberId), formatClock(e.at)),
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
    case TOOL.checkMed: return checkMed(ctx, server, a, extra);
    case TOOL.todayView: return todayView(ctx, a, extra.screen);
    case TOOL.handoffBrief: return handoffBrief(ctx, a, extra.screen);
    case TOOL.ledgerQuery: return ledgerQuery(ctx, a, extra.screen);
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
    callTool(ctx, server, req.params.name, req.params.arguments, {
      requestId: extra.requestId,
      screen: clientHasScreen(server.getClientCapabilities()),
    }),
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

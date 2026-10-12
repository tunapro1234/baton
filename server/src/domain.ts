// Pure rules over the fixture and the log. No I/O, no real time: callers pass `now` from the SimClock.
import {
  addDays, at, compareLocal, currentWindow, dateOf, formatClock, windowState,
  type CareEvent, type DoseWindow, type Fixture, type Member, type Observation, type PlanItem,
} from '@baton/contract';

// ---------- plan matching ----------
const STOP = new Set(['the', 'a', 'an', 'one', 'ones', 'pill', 'pills', 'tablet', 'tablets', 'her', 'his', 'mom', 'mum', 'dad', 'my', 'of', 'and', 'it', 'that', 'this', 'med', 'meds', 'medicine']);
const SYNONYM: Record<string, string> = { big: 'large', little: 'small', tiny: 'small', round: 'round', oval: 'oval' };

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => SYNONYM[t] ?? t);
}

/** Plan items active on `date` (an item with `since` starts that day). */
export function activePlan(fx: Fixture, date: string): PlanItem[] {
  return fx.plan.filter((p) => !p.since || p.since <= date);
}

/**
 * Deterministic match of one spoken item to plan items: by id, generic name, label, or every
 * meaningful word of the description ("the small white one" -> small + white).
 */
export function matchItem(plan: PlanItem[], item: string): PlanItem[] {
  const raw = item.trim().toLowerCase();
  const exact = plan.filter((p) => p.id === raw || p.generic.toLowerCase() === raw || p.name.toLowerCase() === raw);
  if (exact.length) return exact;
  const words = tokens(item);
  if (!words.length) return [];
  const byName = plan.filter((p) => words.some((w) => w === p.id || w === p.generic.toLowerCase()));
  if (byName.length) return byName;
  return plan.filter((p) => {
    const looks = new Set(tokens(p.looks));
    const nameWords = new Set(tokens(p.name));
    return words.every((w) => looks.has(w) || nameWords.has(w));
  });
}

// ---------- windows and statuses ----------
export type Status = 'given' | 'not_logged' | 'logged_twice' | 'upcoming';

export function memberName(fx: Fixture, id: string): string {
  return fx.members.find((m) => m.id === id)?.name ?? id;
}

export function planItem(fx: Fixture, id: string): PlanItem | undefined {
  return fx.plan.find((p) => p.id === id);
}

/** Window a dose at `iso` counts for: the open window, else the closest window of that day for the med. */
export function windowForDose(fx: Fixture, medId: string, iso: string): DoseWindow | undefined {
  const med = planItem(fx, medId);
  const allowed = fx.windows.filter((w) => !med || med.windows.includes(w.id));
  const open = currentWindow(allowed, iso);
  if (open) return open;
  const day = dateOf(iso);
  let best: DoseWindow | undefined;
  let bestGap = Infinity;
  for (const w of allowed) {
    const gap = Math.min(
      Math.abs(compareLocal(iso, at(day, w.start))),
      Math.abs(compareLocal(iso, at(day, w.end))),
    );
    if (gap < bestGap) [best, bestGap] = [w, gap];
  }
  return best;
}

/** The window a question is about: the one given, the open one, else the last one that started today. */
export function windowInQuestion(fx: Fixture, now: string, windowId?: string): DoseWindow | undefined {
  if (windowId) return fx.windows.find((w) => w.id === windowId || w.label === windowId);
  const open = currentWindow(fx.windows, now);
  if (open) return open;
  const started = fx.windows.filter((w) => windowState(w, now) !== 'upcoming');
  return started[started.length - 1] ?? fx.windows[0];
}

export function dosesIn(events: CareEvent[], date: string, windowId: string, medId: string): CareEvent[] {
  return events.filter((e) => !e.deleted && e.medId === medId && e.windowId === windowId && dateOf(e.at) === date);
}

export function statusOf(doses: CareEvent[], w: DoseWindow, now: string): Status {
  if (doses.length >= 2) return 'logged_twice';
  if (doses.length === 1) return 'given';
  return windowState(w, now) === 'upcoming' ? 'upcoming' : 'not_logged';
}

export type GridRow = { windowId: string; medId: string; status: Status; by?: string; at?: string; eventIds: string[] };

export function grid(fx: Fixture, events: CareEvent[], date: string, now: string): GridRow[] {
  const rows: GridRow[] = [];
  // For a past date every window has already happened.
  const asOf = date < dateOf(now) ? at(date, '23:59') : now;
  for (const w of fx.windows) {
    for (const p of activePlan(fx, date)) {
      if (!p.windows.includes(w.id)) continue;
      const doses = dosesIn(events, date, w.id, p.id);
      const row: GridRow = { windowId: w.id, medId: p.id, status: statusOf(doses, w, asOf), eventIds: doses.map((d) => d.eventId) };
      if (doses[0]) {
        row.by = [...new Set(doses.map((d) => memberName(fx, d.memberId)))].join(', ');
        row.at = doses[0].at;
      }
      rows.push(row);
    }
  }
  return rows;
}

// ---------- spoken text helpers ----------
export function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function medWord(fx: Fixture, medId: string): string {
  return planItem(fx, medId)?.generic ?? medId;
}

/** "Sam logged metformin at 8:05" for one event. */
export function eventFact(fx: Fixture, e: CareEvent): string {
  const w = e.windowId ? ` (${e.windowId})` : '';
  return `${memberName(fx, e.memberId)} logged ${medWord(fx, e.medId)}${w} at ${formatClock(e.at)}`;
}

/** "yesterday at 20:00" / "at 8:05" / "on 2026-10-18 at 9:00" relative to now. */
export function whenPhrase(iso: string, now: string): string {
  const d = dateOf(iso);
  const today = dateOf(now);
  if (d === today) return `at ${formatClock(iso)}`;
  if (d === addDays(today, -1)) return `yesterday at ${formatClock(iso)}`;
  return `on ${d} at ${formatClock(iso)}`;
}

// ---------- handoff ----------
export type Fact = { eventId: string; text: string; at: string };

export function handoffFacts(fx: Fixture, events: CareEvent[], observations: Observation[], since: string, now: string): Fact[] {
  const facts: Fact[] = [];
  for (const e of events) {
    if (e.deleted || compareLocal(e.at, since) <= 0 || compareLocal(e.at, now) > 0) continue;
    facts.push({ eventId: e.eventId, text: `${eventFact(fx, e)}.`, at: e.at });
  }
  for (const o of observations) {
    if (compareLocal(o.at, since) <= 0 || compareLocal(o.at, now) > 0) continue;
    facts.push({ eventId: o.observationId, text: `${memberName(fx, o.memberId)} noted at ${formatClock(o.at)}: "${o.text}"`, at: o.at });
  }
  // Windows that closed since then with nothing logged.
  for (let d = dateOf(since); d <= dateOf(now); d = addDays(d, 1)) {
    for (const w of fx.windows) {
      const end = at(d, w.end);
      if (compareLocal(end, since) <= 0 || compareLocal(end, now) > 0) continue;
      for (const p of activePlan(fx, d)) {
        if (!p.windows.includes(w.id) || dosesIn(events, d, w.id, p.id).length) continue;
        facts.push({ eventId: `none-${d}-${w.id}-${p.id}`, text: `No entry for ${p.generic} in the ${w.label} window on ${d}.`, at: end });
      }
    }
  }
  return facts.sort((a, b) => compareLocal(a.at, b.at));
}

// ---------- visit timeline ----------
export type VisitRow = { date: string; kind: 'dose' | 'plan_change' | 'observation'; text: string; refId: string };

/**
 * Visit timeline with fixed templates. Doses are summarised per day and window; a window with
 * nothing logged or with two entries gets its own row. Observations are quoted word for word.
 * Rows sit side by side by date and never claim a link between them.
 */
export function visitRows(
  fx: Fixture, events: CareEvent[], observations: Observation[], from: string, to: string, now: string, observationIds?: string[],
): VisitRow[] {
  const rows: VisitRow[] = [];
  const last = to < dateOf(now) ? to : dateOf(now);
  for (let d = from; d <= last; d = addDays(d, 1)) {
    for (const c of fx.planChanges) if (c.date === d) rows.push({ date: d, kind: 'plan_change', text: c.text, refId: c.changeId });
    for (const w of fx.windows) {
      const asOf = d < dateOf(now) ? at(d, '23:59') : now;
      if (windowState(w, asOf) === 'upcoming') continue;
      const logged: string[] = [];
      for (const p of activePlan(fx, d)) {
        if (!p.windows.includes(w.id)) continue;
        const doses = dosesIn(events, d, w.id, p.id);
        if (doses.length === 0 && windowState(w, asOf) === 'closed') {
          rows.push({ date: d, kind: 'dose', text: `${w.label}: no entry for ${p.generic}.`, refId: `none-${d}-${w.id}-${p.id}` });
        } else if (doses.length >= 2) {
          const who = doses.map((e) => `${memberName(fx, e.memberId)} ${formatClock(e.at)}`).join(', ');
          rows.push({ date: d, kind: 'dose', text: `${w.label}: ${p.generic} logged ${doses.length} times (${who}).`, refId: doses.map((e) => e.eventId).join(',') });
        } else if (doses[0]) {
          logged.push(p.generic);
        }
      }
      if (logged.length) {
        const ids = activePlan(fx, d).flatMap((p) => dosesIn(events, d, w.id, p.id)).filter((e) => logged.includes(medWord(fx, e.medId)));
        rows.push({ date: d, kind: 'dose', text: `${w.label}: ${list(logged)} logged once.`, refId: ids.map((e) => e.eventId).join(',') });
      }
    }
    for (const o of observations) {
      if (dateOf(o.at) !== d) continue;
      if (observationIds && !observationIds.includes(o.observationId)) continue;
      rows.push({ date: d, kind: 'observation', text: `${memberName(fx, o.memberId)} noted: "${o.text}"`, refId: o.observationId });
    }
  }
  return rows;
}

export function memberById(fx: Fixture, id: string): Member | undefined {
  return fx.members.find((m) => m.id === id);
}

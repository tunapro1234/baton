// Simulated clock. Business rules never read the real time: every "now" comes from a SimClock.
// Times are local ISO strings without a zone ("2026-10-20T08:05:00"); arithmetic runs in UTC so DST never shifts a window.
import type { DoseWindow, Member } from './contract.ts';

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function toMs(iso: string): number {
  const m = LOCAL_RE.exec(iso);
  if (!m) throw new Error(`not a local ISO time: ${iso}`);
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, s ? +s : 0);
  // Date.UTC rolls "2026-02-30" over to March; reject it instead.
  if (fromMs(ms).slice(0, 16) !== `${y}-${mo}-${d}T${h}:${mi}`) throw new Error(`not a real time: ${iso}`);
  return ms;
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/** Normalises "2026-10-20T08:05" to "2026-10-20T08:05:00". Throws on anything else. */
export function normalizeLocal(iso: string): string {
  return fromMs(toMs(iso));
}

export function addMinutes(iso: string, minutes: number): string {
  if (!Number.isFinite(minutes)) throw new Error('minutes must be a finite number');
  return fromMs(toMs(iso) + Math.round(minutes) * 60_000);
}

export function compareLocal(a: string, b: string): number {
  return toMs(a) - toMs(b);
}

export function dateOf(iso: string): string {
  return normalizeLocal(iso).slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return addMinutes(`${date}T00:00:00`, days * 24 * 60).slice(0, 10);
}

/** "HH:MM" on a date as local ISO. */
export function at(date: string, hhmm: string): string {
  return normalizeLocal(`${date}T${hhmm}`);
}

/** Spoken clock: "2026-10-20T08:05:00" -> "8:05", "...T19:30" -> "19:30". */
export function formatClock(iso: string): string {
  const t = normalizeLocal(iso).slice(11, 16);
  return t.startsWith('0') ? t.slice(1) : t;
}

export class SimClock {
  #now: string;
  #listeners = new Set<(now: string, previous: string) => void>();

  constructor(start: string) {
    this.#now = normalizeLocal(start);
  }

  now(): string {
    return this.#now;
  }

  today(): string {
    return this.#now.slice(0, 10);
  }

  set(iso: string): string {
    return this.#move(normalizeLocal(iso));
  }

  advance(minutes: number): string {
    return this.#move(addMinutes(this.#now, minutes));
  }

  /** Called after every change with (now, previous). Returns an unsubscribe function. */
  onChange(fn: (now: string, previous: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #move(next: string): string {
    const previous = this.#now;
    this.#now = next;
    if (next !== previous) for (const fn of this.#listeners) fn(next, previous);
    return next;
  }
}

/** Default start: the fixture's "today" at 07:00. */
export function defaultStart(today: string): string {
  return at(today, '07:00');
}

export type WindowState = 'upcoming' | 'open' | 'closed';

/** A window is open from start (inclusive) to end (exclusive). */
export function windowState(w: DoseWindow, now: string): WindowState {
  const date = dateOf(now);
  if (compareLocal(now, at(date, w.start)) < 0) return 'upcoming';
  if (compareLocal(now, at(date, w.end)) < 0) return 'open';
  return 'closed';
}

/** The open window at `now`, if any. */
export function currentWindow(windows: DoseWindow[], now: string): DoseWindow | undefined {
  return windows.find((w) => windowState(w, now) === 'open');
}

/** The window an event time falls into (same rule as currentWindow). */
export function windowAt(windows: DoseWindow[], iso: string): DoseWindow | undefined {
  return currentWindow(windows, iso);
}

/** Windows that closed in (previous, now]. Used to send baton://windows/today updates. */
export function windowsClosedBetween(windows: DoseWindow[], previous: string, now: string): DoseWindow[] {
  if (compareLocal(now, previous) <= 0) return [];
  const out: DoseWindow[] = [];
  for (let d = dateOf(previous); d <= dateOf(now); d = addDays(d, 1)) {
    for (const w of windows) {
      const end = at(d, w.end);
      if (compareLocal(end, previous) > 0 && compareLocal(end, now) <= 0) out.push(w);
    }
  }
  return out;
}

/** Members whose shift started in (previous, now]. Used to send baton://shifts updates. */
export function shiftsStartedBetween(members: Member[], previous: string, now: string): Member[] {
  if (compareLocal(now, previous) <= 0) return [];
  const out: Member[] = [];
  for (let d = dateOf(previous); d <= dateOf(now); d = addDays(d, 1)) {
    for (const m of members) {
      if (!m.shift) continue;
      const start = at(d, m.shift.start);
      if (compareLocal(start, previous) > 0 && compareLocal(start, now) <= 0 && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

/** Who is on shift at `now` (start inclusive, end exclusive). Members without a shift are never on shift. */
export function onShift(members: Member[], now: string): Member[] {
  const date = dateOf(now);
  return members.filter(
    (m) => m.shift && compareLocal(now, at(date, m.shift.start)) >= 0 && compareLocal(now, at(date, m.shift.end)) < 0,
  );
}

/**
 * End of the member's most recent finished shift before `now`. For a member without a shift
 * (family without a shift) it falls back to `now` minus 24 hours, so "since you left" still has a start.
 */
export function lastShiftEnd(member: Member, now: string): string {
  if (!member.shift) return addMinutes(now, -24 * 60);
  const today = dateOf(now);
  const endToday = at(today, member.shift.end);
  return compareLocal(endToday, now) <= 0 ? endToday : at(addDays(today, -1), member.shift.end);
}

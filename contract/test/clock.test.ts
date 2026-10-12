import { describe, expect, it } from 'vitest';
import {
  SimClock, addMinutes, currentWindow, defaultStart, formatClock, lastShiftEnd, loadFixture, normalizeLocal, onShift,
  shiftsStartedBetween, windowState, windowsClosedBetween,
} from '../src/index.ts';

const fx = loadFixture('june');
const morning = fx.windows.find((w) => w.id === 'morning')!;
const member = (id: string) => fx.members.find((m) => m.id === id)!;

describe('SimClock', () => {
  it('starts at the fixture day at 07:00 by default', () => {
    expect(new SimClock(defaultStart(fx.today)).now()).toBe('2026-10-20T07:00:00');
  });

  it('sets and advances, and tells listeners', () => {
    const c = new SimClock('2026-10-20T07:00');
    const seen: string[] = [];
    c.onChange((now, prev) => seen.push(`${prev}>${now}`));
    expect(c.advance(65)).toBe('2026-10-20T08:05:00');
    expect(c.set('2026-10-20T19:00')).toBe('2026-10-20T19:00:00');
    c.set('2026-10-20T19:00:00');
    expect(seen).toEqual(['2026-10-20T07:00:00>2026-10-20T08:05:00', '2026-10-20T08:05:00>2026-10-20T19:00:00']);
  });

  it('crosses midnight', () => {
    expect(addMinutes('2026-10-20T23:50:00', 20)).toBe('2026-10-21T00:10:00');
  });

  it('rejects zones and impossible dates', () => {
    expect(() => normalizeLocal('2026-10-20T08:05:00Z')).toThrow();
    expect(() => normalizeLocal('2026-02-30T08:00')).toThrow();
    expect(() => new SimClock('2026-10-20').now()).toThrow();
  });

  it('speaks times without a leading zero', () => {
    expect(formatClock('2026-10-20T08:05:00')).toBe('8:05');
    expect(formatClock('2026-10-20T19:30:00')).toBe('19:30');
    expect(formatClock('2026-10-20T00:15:00')).toBe('0:15');
  });
});

describe('windows', () => {
  it('opens at start and closes at end', () => {
    expect(windowState(morning, '2026-10-20T07:29:00')).toBe('upcoming');
    expect(windowState(morning, '2026-10-20T07:30:00')).toBe('open');
    expect(windowState(morning, '2026-10-20T09:29:00')).toBe('open');
    expect(windowState(morning, '2026-10-20T09:30:00')).toBe('closed');
    expect(currentWindow(fx.windows, '2026-10-20T19:00:00')?.id).toBe('evening');
    expect(currentWindow(fx.windows, '2026-10-20T12:00:00')).toBeUndefined();
  });

  it('reports windows that closed during a jump', () => {
    expect(windowsClosedBetween(fx.windows, '2026-10-20T09:00:00', '2026-10-20T09:30:00').map((w) => w.id)).toEqual(['morning']);
    expect(windowsClosedBetween(fx.windows, '2026-10-20T09:30:00', '2026-10-20T10:00:00')).toEqual([]);
    expect(windowsClosedBetween(fx.windows, '2026-10-20T07:00:00', '2026-10-20T21:00:00').map((w) => w.id)).toEqual([
      'morning', 'evening',
    ]);
    expect(windowsClosedBetween(fx.windows, '2026-10-20T10:00:00', '2026-10-20T09:00:00')).toEqual([]);
  });
});

describe('shifts', () => {
  it('knows who is on shift', () => {
    expect(onShift(fx.members, '2026-10-20T08:00:00').map((m) => m.id)).toEqual(['sam']);
    expect(onShift(fx.members, '2026-10-20T14:00:00').map((m) => m.id)).toEqual(['aylin']);
    expect(onShift(fx.members, '2026-10-20T21:00:00')).toEqual([]);
  });

  it('reports shifts that started during a jump', () => {
    expect(shiftsStartedBetween(fx.members, '2026-10-20T13:59:00', '2026-10-20T14:00:00').map((m) => m.id)).toEqual(['aylin']);
    expect(shiftsStartedBetween(fx.members, '2026-10-20T06:00:00', '2026-10-20T15:00:00').map((m) => m.id)).toEqual([
      'sam', 'aylin',
    ]);
  });

  it('finds the end of the last finished shift', () => {
    expect(lastShiftEnd(member('aylin'), '2026-10-20T15:00:00')).toBe('2026-10-19T20:00:00');
    expect(lastShiftEnd(member('aylin'), '2026-10-20T20:00:00')).toBe('2026-10-20T20:00:00');
    expect(lastShiftEnd(member('priya'), '2026-10-20T12:00:00')).toBe('2026-10-19T12:00:00');
  });
});

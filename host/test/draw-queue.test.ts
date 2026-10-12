import { describe, expect, it } from 'vitest';
import { LatestQueue } from '../src/draw-queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LatestQueue', () => {
  it('runs tasks one at a time and skips the ones a newer task replaced while they waited', async () => {
    const q = new LatestQueue();
    const ran: string[] = [];
    let release!: () => void;
    const first = q.run(() => new Promise<void>((r) => { ran.push('today (refresh)'); release = r; }));
    await tick();
    const stale = q.run(async () => { ran.push('today again'); });
    const newest = q.run(async () => { ran.push('visit'); });
    await tick();
    expect(ran).toEqual(['today (refresh)']);
    release();
    await Promise.all([first, stale, newest]);
    expect(ran).toEqual(['today (refresh)', 'visit']);
  });

  it('keeps going after a task fails', async () => {
    const q = new LatestQueue();
    await expect(q.run(async () => { throw new Error('mount failed'); })).rejects.toThrow('mount failed');
    const ran: string[] = [];
    await q.run(async () => { ran.push('next'); });
    expect(ran).toEqual(['next']);
  });
});

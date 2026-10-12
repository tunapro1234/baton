// Two MCP sessions on one server: when A writes, B hears about it through resources/updated on its standalone GET stream.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESOURCE } from '@baton/contract';
import type { App } from '../src/http.ts';
import { call, connect, start, waitFor, type TestClient } from './helpers.ts';

let app: App;
let A: TestClient;
let B: TestClient;

beforeAll(async () => {
  app = await start();
  A = await connect(app, 'sam');
  B = await connect(app, 'priya');
});
afterAll(async () => {
  await A?.close();
  await B?.close();
  await app?.close();
});

describe('resources/subscribe across sessions', () => {
  it('opens two distinct sessions with subscribe support', () => {
    expect(A.sessionId).toBeTruthy();
    expect(B.sessionId).toBeTruthy();
    expect(A.sessionId).not.toBe(B.sessionId);
    expect(A.getServerCapabilities()?.resources?.subscribe).toBe(true);
  });

  it('notifies B within 1 s when A writes, and A too', async () => {
    await B.subscribeResource({ uri: RESOURCE.ledgerToday });
    await A.subscribeResource({ uri: RESOURCE.ledgerToday });
    const t0 = Date.now();
    const r = await call(A, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'gave mom her metformin', requestId: 'sub-1' });
    expect(r.sc.written).toBe(true);
    expect(await waitFor(() => B.updates.some((u) => u.uri === RESOURCE.ledgerToday && u.t >= t0), 1000)).toBe(true);
    expect(await waitFor(() => A.updates.some((u) => u.uri === RESOURCE.ledgerToday && u.t >= t0), 1000)).toBe(true);
    const latency = B.updates.find((u) => u.t >= t0)!.t - t0;
    expect(latency).toBeLessThanOrEqual(1000);
  });

  it('stops notifying after unsubscribe', async () => {
    await B.unsubscribeResource({ uri: RESOURCE.ledgerToday });
    const before = B.updates.length;
    await call(A, 'log_observation', { memberId: 'sam', text: 'She ate all of her breakfast.' });
    await new Promise((r) => setTimeout(r, 200));
    expect(B.updates.length).toBe(before);
  });

  it('sends windows and shifts updates when the simulated clock moves', async () => {
    await B.subscribeResource({ uri: RESOURCE.windowsToday });
    await B.subscribeResource({ uri: RESOURCE.shifts });
    const t0 = Date.now();
    app.ctx.clock.set('2026-10-20T14:00:00');
    expect(await waitFor(() => B.updates.some((u) => u.uri === RESOURCE.windowsToday && u.t >= t0))).toBe(true);
    expect(await waitFor(() => B.updates.some((u) => u.uri === RESOURCE.shifts && u.t >= t0))).toBe(true);
  });

  it('rejects subscriptions to unknown resources', async () => {
    await expect(B.subscribeResource({ uri: 'baton://nope' })).rejects.toThrow();
  });
});

// Loads contract/fixtures/<name>.json and checks it against the Fixture schema and the plan's own references.
import { readFileSync } from 'node:fs';
import { Fixture } from './contract.ts';

const FIXTURE_NAME = /^[a-z0-9-]+$/;

export function fixturePath(name: string): string {
  if (!FIXTURE_NAME.test(name)) throw new Error(`bad fixture name: ${name}`);
  return new URL(`../fixtures/${name}.json`, import.meta.url).pathname;
}

export function parseFixture(raw: unknown): Fixture {
  const fx = Fixture.parse(raw);
  const members = new Set(fx.members.map((m) => m.id));
  const meds = new Set(fx.plan.map((p) => p.id));
  const windows = new Set(fx.windows.map((w) => w.id));
  const problems: string[] = [];
  for (const p of fx.plan) for (const w of p.windows) if (!windows.has(w)) problems.push(`plan ${p.id}: unknown window ${w}`);
  const ids = new Set<string>();
  for (const e of fx.events) {
    if (ids.has(e.eventId)) problems.push(`duplicate eventId ${e.eventId}`);
    ids.add(e.eventId);
    if (!members.has(e.memberId)) problems.push(`event ${e.eventId}: unknown member ${e.memberId}`);
    if (!meds.has(e.medId)) problems.push(`event ${e.eventId}: unknown med ${e.medId}`);
    if (e.windowId && !windows.has(e.windowId)) problems.push(`event ${e.eventId}: unknown window ${e.windowId}`);
    if (e.at.slice(0, 10) >= fx.today) problems.push(`event ${e.eventId}: history must end before today`);
  }
  for (const o of fx.observations) if (!members.has(o.memberId)) problems.push(`observation ${o.observationId}: unknown member`);
  for (const c of fx.planChanges) if (!meds.has(c.medId)) problems.push(`plan change ${c.changeId}: unknown med`);
  if (problems.length) throw new Error(`fixture is inconsistent:\n${problems.join('\n')}`);
  return fx;
}

export function loadFixture(name = 'june'): Fixture {
  return parseFixture(JSON.parse(readFileSync(fixturePath(name), 'utf8')));
}

// Guardrail eval: 40 bad drafts must each be replaced by the right rule, 20 clean sentences must pass unchanged.
// No key, no network.
import { readFileSync } from 'node:fs';
import { guard } from '../../proxy/src/guardrail.ts';

type Case = { id: string; kind: 'dose' | 'interpretation'; draft: string };

const CTX = { clinician: 'Dr. Lee', planLine: 'Metformin 500 mg, morning and evening' };
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as T;

const cases = read<Case[]>('guardrail.json');
const clean = read<string[]>('guardrail-clean.json');

let hit = 0;
for (const c of cases) {
  const r = guard(c.draft, CTX);
  if (r.replaced && r.rule === c.kind) hit++;
  else console.log(`miss ${c.id}: expected ${c.kind}, got ${r.rule ?? 'pass'}`);
}

let pass = 0;
for (const [i, s] of clean.entries()) {
  const r = guard(s, CTX);
  if (!r.replaced && r.text === s) pass++;
  else console.log(`clean ${i + 1} was changed (${r.rule ?? 'none'})`);
}

console.log(`guardrail: ${hit}/${cases.length}`);
console.log(`clean: ${pass}/${clean.length}`);
process.exit(hit === cases.length && pass === clean.length ? 0 : 1);

// System prompt for the live model. Facts come from the fixture and the tool results only.
// The log itself never goes in here: the model reads it through tools.
import { FIXED, NOT_A_MEDICAL_DEVICE, TOOL } from '@baton/contract';
import type { Fixture } from '@baton/contract';

export type PromptContext = { memberId?: string | undefined; now?: string | undefined; device?: string | undefined };

/** "Metformin 500 mg, morning and evening": the plan line the dose sentence quotes. */
export function planLine(fx: Fixture, medId: string): string | undefined {
  const item = fx.plan.find((p) => p.id === medId);
  if (!item) return undefined;
  const when = item.windows
    .map((w) => fx.windows.find((x) => x.id === w)?.label ?? w)
    .join(' and ');
  return `${item.name}, ${when}`;
}

/** Plan line for a message: the medications it names (by generic name), or the whole plan. */
export function planLineFor(fx: Fixture, text: string): string {
  const lower = text.toLowerCase();
  const named = fx.plan.filter((p) => lower.includes(p.generic.toLowerCase()));
  const items = named.length ? named : fx.plan;
  return items.map((p) => planLine(fx, p.id) ?? p.name).join('; ');
}

export function buildSystemPrompt(fx: Fixture, context: PromptContext = {}): string {
  const clinician = fx.clinician.name;
  const members = fx.members
    .map((m) => `- ${m.id}: ${m.name} (${m.role}${m.shift ? `, shift ${m.shift.start}-${m.shift.end}` : ', no shift'})`)
    .join('\n');
  const plan = fx.plan
    .map((p) => {
      const windows = p.windows.map((w) => fx.windows.find((x) => x.id === w)?.label ?? w).join(', ');
      const since = p.since ? `, since ${p.since}` : '';
      return `- ${p.id}: ${p.name} (${p.looks}); windows: ${windows}${since}`;
    })
    .join('\n');
  const who = context.memberId
    ? `The speaker is ${context.memberId} (soft confirmation, not authentication).`
    : 'The speaker is not confirmed yet. Call who_is_here before logging anything.';
  const when = context.now ? `The simulated time is ${context.now}.` : '';

  return [
    `You are Baton, a voice assistant for a shared care log for ${fx.household.name} (fictional, ${fx.household.age}). ${NOT_A_MEDICAL_DEVICE}`,
    '',
    'How to answer:',
    '- Speak in one or two short sentences. Plain text only: no markdown, no lists, no emoji, no links.',
    '- Every fact comes from a tool call. Never state a number, time, date or name that is not in a tool result or in what the user said.',
    '- Do not give doses, dose changes, or advice about medicines. Do not interpret symptoms or name causes.',
    `- For a dose question, say exactly: "${FIXED.dose('<plan line>', clinician)}" with the plan line from the plan below.`,
    `- For a symptom question or a symptom report, say exactly: "${FIXED.symptom(clinician)}"`,
    `- For an emergency, say exactly: "${FIXED.emergency}"`,
    '- Never use these words or phrases: safe, okay to give, you should, probably, caused by.',
    '',
    'Four jobs:',
    `1. Spoken care notes: call ${TOOL.logCareEvent} with the items as the user said them, mapped to plan ids, names or the looks text in the plan. Pass the user words as heardText. If an item is ambiguous the server asks the user; do not ask yourself.`,
    `2. Since you left: call ${TOOL.handoffBrief} for the speaker, then say what happened in two sentences.`,
    `3. A free question about the log: plan the arguments for ${TOOL.ledgerQuery} or ${TOOL.checkMed}, call it, and answer from the result.`,
    `4. Visit prep: call ${TOOL.visitBrief} with the dates the user names. Say only that the brief is ready.`,
    '',
    `Other tools: ${TOOL.logObservation} stores a note exactly as said (no interpretation); ${TOOL.todayView} shows the day; ${TOOL.correctEntry} removes an entry the user asks to correct.`,
    '',
    'Household members:',
    members,
    '',
    `Plan (written by the family, not a drug database). Clinician: ${clinician}.`,
    plan,
    '',
    [who, when, context.device ? `Device: ${context.device}.` : ''].filter(Boolean).join(' '),
  ].join('\n');
}

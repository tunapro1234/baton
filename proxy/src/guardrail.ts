// Deterministic output filter for assistant text. Runs on every text block the model returns,
// before the browser sees it. A match replaces the whole block with a fixed sentence.
import { FIXED, SPOKEN } from '@baton/contract';

/** screen: false for a device without a screen; the fixed sentences then use their SPOKEN wording. */
export type GuardContext = { clinician: string; planLine: string; screen?: boolean };
export type GuardRule = 'dose' | 'interpretation';
export type GuardResult = { text: string; replaced: boolean; rule?: GuardRule };

// Dose and advice patterns. Checked first, so a sentence that is both is reported as a dose.
const DOSE: RegExp[] = [
  /\bsafe to\b/i,
  /\b(?:ok|okay) to give\b/i,
  /\byou can give\b/i,
  /\byou could give\b/i,
  /\byou should\b/i,
  /\bgo ahead and give\b/i,
  /\bgive her (?:half|another|one more|an extra|double)\b/i,
  /\btake (?:\d+|two|another)\b/i,
  /\bskip the (?:next|evening|morning) dose\b/i,
  /\bextra dose\b/i,
  /\b(?:give|take)\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml)\b/i,
  /\b(?:i suggest|i recommend|i'd suggest)\s+\d+/i,
  /\bdouble up\b/i,
  /\bit won'?t hurt\b/i,
  /\bit'?s fine to\b/i,
];

// Interpretation patterns: the assistant explaining a cause or a symptom.
const INTERPRETATION: RegExp[] = [
  /\bcaused by\b/i,
  /\bbecause of the (?:med|medication|pill|pills|metformin|amlodipine|levothyroxine|drug|new pill)\b/i,
  /\bside effects?\b/i,
  /\bprobably\b/i,
  /\blikely due to\b/i,
  /\bsounds like\b/i,
  /\bcould be a sign\b/i,
  /\bmight be (?:low|high) blood\b/i,
  /\bis a symptom of\b/i,
  /\bmeans (?:she|he) has\b/i,
  /\bnothing to worry about\b/i,
  /\bnormal for (?:her|him)\b/i,
];

// Emergency wording in what the user said. Checked before any model call.
const EMERGENCY: RegExp[] = [
  /\bchest pain\b/i,
  /\bcan'?t breathe\b/i,
  /\bcannot breathe\b/i,
  /\bnot breathing\b/i,
  /\bisn'?t breathing\b/i,
  /\bunconscious\b/i,
  /\bwon'?t wake up\b/i,
  /\bwill not wake up\b/i,
  /\bfell and hit\b/i,
  /\bstroke\b/i,
  /\boverdos/i,
  /\btook too many\b/i,
];

export function guard(text: string, ctx: GuardContext): GuardResult {
  if (DOSE.some((re) => re.test(text))) {
    const fixed = ctx.screen === false ? SPOKEN.dose(ctx.clinician) : FIXED.dose(ctx.planLine, ctx.clinician);
    return { text: fixed, replaced: true, rule: 'dose' };
  }
  if (INTERPRETATION.some((re) => re.test(text))) {
    const fixed = ctx.screen === false ? SPOKEN.symptom(ctx.clinician) : FIXED.symptom(ctx.clinician);
    return { text: fixed, replaced: true, rule: 'interpretation' };
  }
  return { text, replaced: false };
}

/** True when the user's words describe an emergency. The proxy then answers FIXED.emergency without a model. */
export function emergency(userText: string): boolean {
  return EMERGENCY.some((re) => re.test(userText));
}

/**
 * Words a device without a screen must not say: every plan name, generic name, description and strength,
 * and the words of the notes. A reply that contains one is replaced with SPOKEN.details.
 */
export function unspeakable(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml)\b/i.test(text) || words.some((w) => w && lower.includes(w.toLowerCase()));
}

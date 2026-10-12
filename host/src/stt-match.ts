// Speech recognisers often split or bend drug names ("met forming", "levo thyroxine"). Before a
// transcript goes to the assistant, near misses of the family's own plan names are put back.
// Only names in the plan are candidates: there is no drug dictionary.

export type Correction = { heard: string; as: string };

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Edits allowed for a name: about one in four letters, at least one, at most three. */
function allowed(name: string): number {
  return Math.min(3, Math.max(1, Math.floor(name.length / 4)));
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Replaces runs of one to three spoken words that come close to a plan name with that name.
 * `names` are generic names from the plan, such as "metformin". Short words never match on their own.
 */
export function matchPlanNames(transcript: string, names: string[]): { text: string; corrections: Correction[] } {
  const targets = [...new Set(names.map(letters).filter((n) => n.length >= 5))];
  const words = transcript.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const corrections: Correction[] = [];
  for (let i = 0; i < words.length; ) {
    let best: { n: number; name: string; d: number } | undefined;
    for (let n = 3; n >= 1; n--) {
      if (i + n > words.length) continue;
      const joined = letters(words.slice(i, i + n).join(''));
      if (joined.length < 4) continue;
      for (const name of targets) {
        // Recognisers rarely get the first sound wrong; this also keeps "her levo..." from swallowing "her".
        if (joined[0] !== name[0]) continue;
        const d = distance(joined, name);
        if (d <= allowed(name) && (!best || d < best.d || (d === best.d && n > best.n))) best = { n, name, d };
      }
    }
    if (best) {
      const heard = words.slice(i, i + best.n).join(' ');
      const tail = heard.match(/[^A-Za-z]+$/)?.[0] ?? '';
      out.push(best.name + tail);
      if (heard.slice(0, heard.length - tail.length).toLowerCase() !== best.name) corrections.push({ heard, as: best.name });
      i += best.n;
    } else {
      out.push(words[i]!);
      i += 1;
    }
  }
  return { text: out.join(' '), corrections };
}

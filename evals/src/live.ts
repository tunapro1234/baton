// Guardrail eval against the live model. Needs a key; without one it refuses to run and exits 2.
// Not wired in this build: with a key it still refuses, so nothing is sent to the API from here.
const key = process.env.ANTHROPIC_API_KEY ?? '';
if (!key) {
  console.error('eval:guardrail:live needs ANTHROPIC_API_KEY. It is not set, so nothing ran. Use npm run eval:guardrail (no key).');
  process.exit(2);
}
console.error('eval:guardrail:live is not wired in this build, so nothing ran. Use npm run eval:guardrail.');
process.exit(2);

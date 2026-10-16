// The README states counts that come from the code. Keep them in step.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RESOURCE } from '@baton/contract';
import { toolList } from '../src/mcp.ts';
import { VIEWS } from '../src/views.ts';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const pattern = readFileSync(new URL('./pattern.test.ts', import.meta.url), 'utf8');
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

describe('README', () => {
  it('counts the tools, data resources and MCP Apps views the server has', () => {
    const line = `${WORDS[toolList().length]} tools, ${WORDS[Object.keys(RESOURCE).length]} data resources and ${WORDS[VIEWS.length]} MCP Apps views`;
    expect(readme).toContain(line);
  });

  it('describes the pattern tests as they are: every rule has at least one named test', () => {
    for (const rule of [1, 2, 3]) expect(pattern).toContain(`it('rule ${rule}:`);
    expect(readme).toContain('named tests for each rule');
  });

  it('says where the 500 ms latency budget comes from', () => {
    for (const m of readme.matchAll(/500 ms/g)) {
      expect(readme.slice(m.index, m.index + 120)).toContain("voice-ready-mcp's default latency budget");
    }
  });
});

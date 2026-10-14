// MCP Apps views (text/html;profile=mcp-app), assembled into one self-contained HTML file each from
// server/views/: shared style + runtime and a small renderer per view. No network access is needed.
import { readFileSync } from 'node:fs';
import { ADVICE_NOTICE, ENTERED_BY_FAMILY, MCP_APP_MIME, NOT_A_MEDICAL_DEVICE, UI } from '@baton/contract';

const dir = new URL('../views/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** advice: the plan and the timeline carry both notice sentences word for word. */
function page(title: string, renderer: string, advice: boolean): string {
  const notice = advice ? `\n<p class="advice" data-testid="advice">${ADVICE_NOTICE.map(esc).join(' ')}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${read('style.css')}</style></head>
<body>
<header><h1>${title}</h1><button id="expand" type="button" hidden>Expand</button></header>
<main id="view"></main>${notice}
<footer>Fictional family. ${NOT_A_MEDICAL_DEVICE}</footer>
<script>window.BATON_TEXT = ${JSON.stringify({ enteredByFamily: ENTERED_BY_FAMILY })};</script>
<script>${read(renderer)}</script>
<script>${read('runtime.js')}</script>
</body></html>`;
}

export const VIEWS = [
  { uri: UI.today, name: 'today', title: 'Today', file: 'today.js', advice: true },
  { uri: UI.brief, name: 'brief', title: 'Since you left', file: 'brief.js', advice: false },
  { uri: UI.visit, name: 'visit', title: 'Visit timeline', file: 'visit.js', advice: true },
].map(({ file, advice, ...v }) => ({ ...v, mimeType: MCP_APP_MIME, html: page(v.title, file, advice) }));

export function viewHtml(uri: string): string | undefined {
  return VIEWS.find((v) => v.uri === uri)?.html;
}

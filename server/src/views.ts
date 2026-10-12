// MCP Apps views (text/html;profile=mcp-app), assembled into one self-contained HTML file each from
// server/views/: shared style + runtime and a small renderer per view. No network access is needed.
import { readFileSync } from 'node:fs';
import { MCP_APP_MIME, NOT_A_MEDICAL_DEVICE, UI } from '@baton/contract';

const dir = new URL('../views/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

function page(title: string, renderer: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${read('style.css')}</style></head>
<body>
<header><h1>${title}</h1><button id="expand" type="button" hidden>Expand</button></header>
<main id="view"></main>
<footer>Fictional family. ${NOT_A_MEDICAL_DEVICE}</footer>
<script>${read(renderer)}</script>
<script>${read('runtime.js')}</script>
</body></html>`;
}

export const VIEWS = [
  { uri: UI.today, name: 'today', title: 'Today', file: 'today.js' },
  { uri: UI.brief, name: 'brief', title: 'Since you left', file: 'brief.js' },
  { uri: UI.visit, name: 'visit', title: 'Visit timeline', file: 'visit.js' },
].map(({ file, ...v }) => ({ ...v, mimeType: MCP_APP_MIME, html: page(v.title, file) }));

export function viewHtml(uri: string): string | undefined {
  return VIEWS.find((v) => v.uri === uri)?.html;
}

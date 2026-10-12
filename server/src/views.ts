// MCP Apps views (text/html;profile=mcp-app). These are minimal placeholders that render the tool
// result as plain HTML; the host package ships the full views.
import { MCP_APP_MIME, UI } from '@baton/contract';

const PAGE = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;margin:16px}pre{white-space:pre-wrap}</style></head>
<body><h1>${title}</h1><pre id="out">Waiting for data.</pre>
<script>
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m && m.method === 'ui/notifications/tool-result') {
    document.getElementById('out').textContent = JSON.stringify(m.params && m.params.structuredContent, null, 2);
  }
});
</script></body></html>`;

export const VIEWS = [
  { uri: UI.today, name: 'today', title: 'Today' },
  { uri: UI.brief, name: 'brief', title: 'Since you left' },
  { uri: UI.visit, name: 'visit', title: 'Visit timeline' },
].map((v) => ({ ...v, mimeType: MCP_APP_MIME, html: PAGE(v.title) }));

export function viewHtml(uri: string): string | undefined {
  return VIEWS.find((v) => v.uri === uri)?.html;
}

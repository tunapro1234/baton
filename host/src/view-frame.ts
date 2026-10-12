// Mounts an MCP Apps view (ui:// resource) in a sandboxed iframe and feeds it one tool result
// through AppBridge. Each refresh mounts a fresh frame: there is no live host-to-view channel.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type DisplayMode = 'inline' | 'fullscreen';

export type MountedView = { bridge: AppBridge; frame: HTMLIFrameElement; close(): Promise<void> };

export async function mountView(opts: {
  container: HTMLElement;
  client: Client;
  html: string;
  result: CallToolResult;
  theme: 'light' | 'dark';
  displayMode: DisplayMode;
  onDisplayMode: (mode: DisplayMode) => DisplayMode;
}): Promise<MountedView> {
  const frame = document.createElement('iframe');
  frame.className = 'view-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = 'Baton view';
  frame.srcdoc = opts.html;
  opts.container.replaceChildren(frame);
  await new Promise<void>((r) => frame.addEventListener('load', () => r(), { once: true }));

  const bridge = new AppBridge(opts.client, { name: 'baton-host', version: '0.1.0' }, {}, {
    hostContext: { theme: opts.theme, displayMode: opts.displayMode, availableDisplayModes: ['inline', 'fullscreen'] },
  });
  bridge.onsizechange = ({ height }) => {
    if (height) frame.style.height = `${Math.min(Math.max(height, 160), 2000)}px`;
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    const set = opts.onDisplayMode(mode === 'fullscreen' ? 'fullscreen' : 'inline');
    bridge.setHostContext({ theme: opts.theme, displayMode: set, availableDisplayModes: ['inline', 'fullscreen'] });
    return { mode: set };
  };
  const ready = new Promise<void>((r) => {
    bridge.oninitialized = () => r();
  });
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  await ready;
  await bridge.sendToolResult(opts.result);
  return {
    bridge,
    frame,
    async close() {
      try {
        await bridge.teardownResource({});
      } catch {
        // view already gone
      }
      // close() comes from the SDK Protocol base class, which the ext-apps typings do not surface.
      await (bridge as unknown as { close(): Promise<void> }).close();
      frame.remove();
    },
  };
}

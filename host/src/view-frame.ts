// Mounts an MCP Apps view (ui:// resource) in a sandboxed iframe and feeds it one tool result
// through AppBridge. Each refresh mounts a fresh frame: there is no live host-to-view channel.
// The new frame loads hidden next to the old one and takes its place only once it has drawn,
// so a refresh does not flash an empty screen.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type DisplayMode = 'inline' | 'fullscreen';

export type MountedView = {
  bridge: AppBridge;
  frame: HTMLIFrameElement;
  /** Puts this frame on screen and hides the frame it replaces (still open until its close()). */
  show(): void;
  close(): Promise<void>;
};

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
  frame.className = 'view-frame-pending';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = 'Baton view';
  const current = opts.container.querySelector<HTMLIFrameElement>('iframe.view-frame');
  if (current) frame.style.height = current.style.height;
  frame.srcdoc = opts.html;
  for (const n of [...opts.container.childNodes]) if (!(n instanceof HTMLIFrameElement)) n.remove();
  opts.container.append(frame);

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
  // Listen before the frame loads: the view sends ui/initialize while its script runs, which can be
  // delivered before the load event. contentWindow is the same WindowProxy across the srcdoc navigation.
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  // A frame removed while it loads never initializes; give up instead of holding the draw queue.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the view did not start within 15 s')), 15_000);
      }),
    ]);
  } catch (e) {
    void (bridge as unknown as { close(): Promise<void> }).close().catch(() => undefined);
    frame.remove();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  await bridge.sendToolResult(opts.result);
  // Let the view draw the result before it becomes visible.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  return {
    bridge,
    frame,
    show() {
      for (const old of opts.container.querySelectorAll<HTMLIFrameElement>('iframe.view-frame')) {
        if (old !== frame) old.className = 'view-frame-old';
      }
      frame.className = 'view-frame';
    },
    async close() {
      try {
        // A busy or broken view must not keep its frame alive for the SDK's 60 s default.
        await bridge.teardownResource({}, { timeout: 1000 });
      } catch {
        // view already gone
      }
      // close() comes from the SDK Protocol base class, which the ext-apps typings do not surface.
      await (bridge as unknown as { close(): Promise<void> }).close();
      frame.remove();
    },
  };
}

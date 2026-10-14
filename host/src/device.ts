// One simulated device = one MCP session: its own SDK Client and Streamable HTTP transport.
// A device with a screen declares the MCP Apps UI extension; switching the screen off reconnects it as a
// new session without the extension, so the server words its replies for a room that only hears them.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  ElicitRequestSchema, ResourceUpdatedNotificationSchema,
  type CallToolResult, type ElicitRequest, type ElicitResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE, UI_EXTENSION, UI_EXTENSION_SETTINGS } from '@baton/contract/browser';
import { SERVER_URL, authHeaders } from './config.ts';
import { logTransport } from './protocol-log.ts';

export type ToolCall = { name: string; args: Record<string, unknown> };

export class Device {
  readonly id: string;
  readonly label: string;
  client: Client;
  /** Whether the current session declared the MCP Apps UI extension. */
  screen = true;
  tools: Tool[] = [];
  /** Settles when the current session is connected; calls wait for it during a reconnect. */
  private ready: Promise<void> = Promise.resolve();
  memberId: string | undefined;
  /** Answers elicitation requests; set by the UI. */
  onElicit: (p: ElicitRequest['params']) => Promise<ElicitResult> = async () => ({ action: 'cancel' });
  /** Called for each resources/updated notification. */
  onUpdate: (uri: string) => void = () => {};
  readonly views = new Map<string, string>();

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
    this.client = this.makeClient();
  }

  private makeClient(): Client {
    const capabilities = {
      elicitation: { form: {} },
      ...(this.screen ? { extensions: { [UI_EXTENSION]: UI_EXTENSION_SETTINGS } } : {}),
    };
    const c = new Client({ name: `baton-host-${this.id}`, version: '0.1.0' }, { capabilities });
    c.setRequestHandler(ElicitRequestSchema, (r) => this.onElicit(r.params));
    c.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => this.onUpdate(n.params.uri));
    return c;
  }

  connect(): Promise<void> {
    this.ready = this.open();
    return this.ready;
  }

  private async open(): Promise<void> {
    const t = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), { requestInit: { headers: authHeaders() } });
    await this.client.connect(logTransport(this.label, t));
    this.tools = (await this.client.listTools()).tools;
    for (const uri of [RESOURCE.ledgerToday, RESOURCE.windowsToday, RESOURCE.shifts]) {
      await this.client.subscribeResource({ uri });
    }
  }

  /** Ends the session and opens a new one that does (screen) or does not declare the UI extension. */
  async setScreen(screen: boolean): Promise<void> {
    if (screen === this.screen) return this.ready;
    this.screen = screen;
    const old = this.client;
    this.client = this.makeClient();
    this.ready = (async () => {
      const t = old.transport as StreamableHTTPClientTransport | undefined;
      await t?.terminateSession().catch(() => undefined);
      await old.close().catch(() => undefined);
      await this.open();
    })();
    return this.ready;
  }

  get sessionId(): string | undefined {
    return (this.client.transport as StreamableHTTPClientTransport | undefined)?.sessionId;
  }

  /** The ui:// view a tool declares in its definition, if any. */
  viewOf(name: string): string | undefined {
    const t = this.tools.find((x) => x.name === name);
    return t ? getToolUiResourceUri(t) : undefined;
  }

  async call(call: ToolCall): Promise<{ result: CallToolResult; ms: number }> {
    await this.ready;
    const t0 = performance.now();
    const result = (await this.client.callTool({ name: call.name, arguments: call.args })) as CallToolResult;
    return { result, ms: Math.round(performance.now() - t0) };
  }

  /** Reads a JSON resource such as baton://shifts. */
  async readJson<T>(uri: string): Promise<T> {
    await this.ready;
    const c = (await this.client.readResource({ uri })).contents[0];
    return JSON.parse(c && 'text' in c ? c.text : 'null') as T;
  }

  async viewHtml(uri: string): Promise<string> {
    const cached = this.views.get(uri);
    if (cached) return cached;
    const r = await this.client.readResource({ uri });
    const c = r.contents[0];
    const html = c && 'text' in c ? c.text : '';
    this.views.set(uri, html);
    return html;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** content[0].text of a tool result. */
export function spoken(result: CallToolResult): string {
  const c = result.content?.[0];
  return c && c.type === 'text' ? c.text : '';
}

// One simulated device = one MCP session: its own SDK Client and Streamable HTTP transport.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  ElicitRequestSchema, ResourceUpdatedNotificationSchema,
  type CallToolResult, type ElicitRequest, type ElicitResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE } from '@baton/contract/browser';
import { SERVER_URL, authHeaders } from './config.ts';
import { logTransport } from './protocol-log.ts';

export type ToolCall = { name: string; args: Record<string, unknown> };

export class Device {
  readonly id: string;
  readonly label: string;
  readonly client: Client;
  tools: Tool[] = [];
  memberId: string | undefined;
  /** Answers elicitation requests; set by the UI. */
  onElicit: (p: ElicitRequest['params']) => Promise<ElicitResult> = async () => ({ action: 'cancel' });
  /** Called for each resources/updated notification. */
  onUpdate: (uri: string) => void = () => {};
  readonly views = new Map<string, string>();

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
    this.client = new Client({ name: `baton-host-${id}`, version: '0.1.0' }, { capabilities: { elicitation: { form: {} } } });
    this.client.setRequestHandler(ElicitRequestSchema, (r) => this.onElicit(r.params));
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => this.onUpdate(n.params.uri));
  }

  async connect(): Promise<void> {
    const t = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), { requestInit: { headers: authHeaders() } });
    await this.client.connect(logTransport(this.label, t));
    this.tools = (await this.client.listTools()).tools;
    for (const uri of [RESOURCE.ledgerToday, RESOURCE.windowsToday, RESOURCE.shifts]) {
      await this.client.subscribeResource({ uri });
    }
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
    const t0 = performance.now();
    const result = (await this.client.callTool({ name: call.name, arguments: call.args })) as CallToolResult;
    return { result, ms: Math.round(performance.now() - t0) };
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

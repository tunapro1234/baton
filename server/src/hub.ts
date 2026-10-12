// Every MCP session has its own low-level Server. The hub remembers which session subscribed to
// which resource and fans out notifications/resources/updated to all of them, the writer included.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export type Session = { id: string; server: Server; transport: StreamableHTTPServerTransport; subs: Set<string> };

export class Hub {
  readonly sessions = new Map<string, Session>();

  add(s: Session): void {
    this.sessions.set(s.id, s);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  /** Sends resources/updated for each uri to every session subscribed to it. Returns how many were sent. */
  async notify(...uris: string[]): Promise<number> {
    let sent = 0;
    const jobs: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      for (const uri of uris) {
        if (!s.subs.has(uri)) continue;
        sent++;
        jobs.push(s.server.sendResourceUpdated({ uri }).catch(() => undefined));
      }
    }
    await Promise.all(jobs);
    return sent;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
    this.sessions.clear();
  }
}

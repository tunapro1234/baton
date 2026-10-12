// Records the real JSON-RPC traffic of each MCP session for the protocol panel.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export type LogEntry = { device: string; dir: 'out' | 'in'; t: number; msg: JSONRPCMessage; ms?: number };
type Listener = (e: LogEntry) => void;

const listeners = new Set<Listener>();
export const entries: LogEntry[] = [];

export function onLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: LogEntry): void {
  entries.push(e);
  if (entries.length > 500) entries.shift();
  for (const fn of listeners) fn(e);
}

/** Wraps send and onmessage of a transport so every message is logged, with round-trip ms for requests. */
export function logTransport<T extends Transport>(device: string, t: T): T {
  const started = new Map<string | number, number>();
  const send = t.send.bind(t);
  t.send = (msg, opts) => {
    if ('id' in msg && 'method' in msg) started.set(msg.id, performance.now());
    emit({ device, dir: 'out', t: Date.now(), msg });
    return send(msg, opts);
  };
  let handler: Transport['onmessage'];
  Object.defineProperty(t, 'onmessage', {
    configurable: true,
    get: () => handler,
    set: (fn: Transport['onmessage']) => {
      handler = fn
        ? (msg, extra) => {
            let ms: number | undefined;
            const id = 'id' in msg && !('method' in msg) ? (msg.id as string | number | undefined) : undefined;
            if (id !== undefined && started.has(id)) {
              ms = Math.round(performance.now() - started.get(id)!);
              started.delete(id);
            }
            emit({ device, dir: 'in', t: Date.now(), msg, ...(ms !== undefined ? { ms } : {}) });
            fn(msg, extra);
          }
        : fn;
    },
  });
  return t;
}

/** One line summary: "tools/call log_care_event", "result 42 ms", "notifications/resources/updated baton://ledger/today". */
export function summary(e: LogEntry): string {
  const m = e.msg as Record<string, any>;
  if (m.method) {
    const p = m.params ?? {};
    const detail = p.name ?? p.uri ?? p.protocolVersion ?? (m.method === 'elicitation/create' ? p.message : '') ?? '';
    return `${m.method}${detail ? ` ${detail}` : ''}`;
  }
  if (m.error) return `error ${m.error.message}`;
  return `result${e.ms !== undefined ? ` ${e.ms} ms` : ''}`;
}
